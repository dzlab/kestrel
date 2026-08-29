import { randomUUID } from "node:crypto";
import { ValidationError } from "../errors";
import { MAX_SCHEDULE_ATTEMPTS, nextOccurrence, validateScheduleWorkspace } from "./expressions";
import { SCHEDULE_LEASE_TIMEOUT_MS } from "../store/repository";
import type { ScheduleRecord, StoreRepository } from "../store/repository";
import type { RunKernel, RunSummary } from "../kernel/loop";

export const MAX_RETRY_DELAY_MS = 15 * 60_000;

export function retryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new ValidationError("retry attempt must be a non-negative integer");
  return Math.min(MAX_RETRY_DELAY_MS, 2 ** Math.min(attempt, 30) * 5_000);
}

export type SchedulerRunResult = RunSummary & {
  scheduleId: string;
  leaseLost?: boolean;
};

export type SchedulerDaemonOptions = {
  repository: StoreRepository;
  kernel: RunKernel;
  owner?: string;
  now?: () => number;
  leaseRenewalMs?: number;
};

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function dueNextRun(schedule: ScheduleRecord, now: number): number | null {
  let next = nextOccurrence(schedule, schedule.nextRunAt ?? now);
  let guard = 0;
  while (next !== null && next <= now && guard < 10_000) {
    next = nextOccurrence(schedule, next);
    guard += 1;
  }
  return next;
}

export class SchedulerDaemon {
  private readonly repository: StoreRepository;
  private readonly kernel: RunKernel;
  private readonly owner: string;
  private readonly now: () => number;
  private readonly leaseRenewalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;

  constructor(options: SchedulerDaemonOptions) {
    this.repository = options.repository;
    this.kernel = options.kernel;
    this.owner = options.owner ?? `kestrel-scheduler-${randomUUID()}`;
    this.now = options.now ?? (() => Date.now());
    this.leaseRenewalMs = options.leaseRenewalMs ?? Math.max(100, Math.floor(SCHEDULE_LEASE_TIMEOUT_MS / 3));
    if (!Number.isInteger(this.leaseRenewalMs) || this.leaseRenewalMs <= 0) throw new ValidationError("leaseRenewalMs must be positive");
  }

  async tick(now = this.now()): Promise<SchedulerRunResult | null> {
    return this.runOnce(now);
  }

  async runOnce(now = this.now()): Promise<SchedulerRunResult | null> {
    const schedule = this.repository.claimDueSchedule(now, this.owner);
    if (schedule === null || schedule.leaseToken === null || schedule.leaseToken === undefined) return null;
    const leaseToken = schedule.leaseToken;
    this.repository.appendScheduleEvent(schedule.id, "schedule.claimed", { owner: this.owner, leaseToken }, schedule.taskId);

    const leaseController = new AbortController();
    let leaseLost = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const renew = () => {
      const renewalNow = this.now();
      if (this.repository.renewScheduleLease(schedule.id, this.owner, leaseToken, renewalNow)) {
        this.repository.appendScheduleEvent(schedule.id, "schedule.heartbeat", { owner: this.owner }, schedule.taskId);
      } else {
        leaseLost = true;
        leaseController.abort(new Error("scheduler lease lost"));
      }
    };
    heartbeat = setInterval(renew, this.leaseRenewalMs);
    heartbeat.unref?.();

    let summary: RunSummary;
    try {
      const workspace = validateScheduleWorkspace(schedule.workspace ?? "");
      if (!this.repository.hasScheduleLease(schedule.id, this.owner, leaseToken, now)) {
        leaseLost = true;
        leaseController.abort(new Error("scheduler lease lost"));
      }
      if (schedule.pendingRunId !== null && schedule.pendingRunId !== undefined) {
        summary = await this.kernel.resume(schedule.pendingRunId, { userId: "local", signal: leaseController.signal });
      } else {
        summary = await this.kernel.run({
          ...(schedule.taskId === null || schedule.taskId === undefined ? {} : { id: schedule.taskId }),
          title: schedule.name ?? schedule.id,
          prompt: schedule.prompt,
          workspace,
        }, {
          idempotencyKey: `schedule:${schedule.id}:${schedule.nextRunAt ?? now}`,
          userId: "local",
          signal: leaseController.signal,
        });
      }
    } catch (error) {
      summary = { taskId: schedule.taskId ?? "unknown", runId: "unknown", status: "failed", error: errorText(error) };
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }

    const finishedAt = this.now();
    if (leaseLost || !this.repository.hasScheduleLease(schedule.id, this.owner, leaseToken, finishedAt)) {
      leaseController.abort(new Error("scheduler lease lost"));
      this.repository.releaseScheduleLease(schedule.id, this.owner, leaseToken);
      return { scheduleId: schedule.id, ...summary, leaseLost: true };
    }
    const attempts = (schedule.attempts ?? 0) + 1;
    const blocked = summary.status === "blocked_on_approval";
    const successful = summary.status === "completed";
    const recurring = schedule.intervalMs !== null && schedule.intervalMs !== undefined || schedule.rrule !== null && schedule.rrule !== undefined;
    const nextRunAt = blocked
      ? dueNextRun(schedule, finishedAt)
      : successful
        ? dueNextRun(schedule, finishedAt)
        : attempts >= MAX_SCHEDULE_ATTEMPTS ? null : finishedAt + retryDelayMs(Math.max(0, attempts - 1));
    const terminalFailure = !successful && !blocked && attempts >= MAX_SCHEDULE_ATTEMPTS;
    const enabled = blocked ? recurring && nextRunAt !== null : nextRunAt !== null;
    const error = successful ? null : (summary.error ?? `scheduled run ended with ${summary.status}`);
    const updated = this.repository.finishScheduleRun({
      id: schedule.id,
      owner: this.owner,
      leaseToken,
      taskId: summary.taskId === "unknown" ? schedule.taskId : summary.taskId,
      nextRunAt,
      error,
      enabled,
      attempts: successful ? 0 : attempts,
      lastRunAt: finishedAt,
      pendingRunId: blocked ? summary.runId : null,
      pendingApprovalId: blocked ? (summary.approvalId ?? null) : null,
      now: finishedAt,
    });
    if (updated) {
      const eventTaskId = summary.taskId === "unknown" ? schedule.taskId : summary.taskId;
      this.repository.appendScheduleEvent(
        schedule.id,
        blocked ? "schedule.paused" : successful ? "schedule.completed" : terminalFailure ? "schedule.terminal" : "schedule.failed",
        { status: summary.status, nextRunAt, error },
        eventTaskId,
        summary.runId === "unknown" ? null : summary.runId,
      );
    }
    return { scheduleId: schedule.id, ...summary, ...(updated ? {} : { leaseLost: true }) };
  }

  start(intervalMs = 1_000, keepAlive = false): void {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new ValidationError("scheduler interval must be positive");
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = true;
      void this.tick().catch(() => undefined).finally(() => {
        this.active = false;
      });
    }, intervalMs);
    if (!keepAlive) this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export { MAX_SCHEDULE_ATTEMPTS, MIN_SCHEDULE_INTERVAL_MS, nextOccurrence, validateScheduleWorkspace } from "./expressions";
