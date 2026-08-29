import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeModel } from "../src/model/fake";
import type { ModelResponse } from "../src/protocol/types";
import { ApprovalManager } from "../src/policy/approvals";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import { createScheduleTools, validateScheduleInput } from "../src/tools/schedule";
import { createToolRegistry } from "../src/tools/registry";
import { RunKernel } from "../src/kernel";
import { SchedulerDaemon, retryDelayMs } from "../src/scheduler/daemon";

function assistant(content: string): ModelResponse {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}

function setup(model: FakeModel = new FakeModel([assistant("scheduled task complete")])) {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-scheduler-"));
  const database = openDatabase(join(directory, "kestrel.sqlite"));
  const repository = new StoreRepository(database);
  const approvals = new ApprovalManager(repository);
  const registry = createToolRegistry({ approvals });
  const kernel = new RunKernel({ model, repository, registry, approvals, modelName: "test" });
  const cleanup = () => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { directory, database, repository, approvals, kernel, model, cleanup };
}

test("validates bounded prompts, explicit timezones, safe expressions, and minimum intervals", () => {
  expect(() => validateScheduleInput({ name: "check", prompt: "x", intervalMs: 59_999, timeZone: "UTC" }))
    .toThrow(/interval/i);
  expect(() => validateScheduleInput({ name: "check", prompt: "x", intervalMs: 60_000 }))
    .toThrow(/timezone/i);
  expect(() => validateScheduleInput({ name: "check", prompt: "x", rrule: "FREQ=SECONDLY;BYHOUR=1", timeZone: "UTC" }))
    .toThrow(/rrule|expression/i);
  expect(() => validateScheduleInput({ name: "check", prompt: "x", at: "2026-08-28T10:00:00", timeZone: "UTC" }))
    .toThrow(/timezone|offset/i);
  expect(() => validateScheduleInput({ name: "check", prompt: "x".repeat(5_000), at: "2026-08-28T10:00:00Z", timeZone: "UTC" }))
    .toThrow(/prompt/i);
  expect(validateScheduleInput({ name: "check", prompt: "x", intervalMs: 60_000, timeZone: "UTC" }))
    .toMatchObject({ intervalMs: 60_000, timeZone: "UTC" });
});

test("registers exactly the schedule tools and creates/lists/cancels without deleting history", async () => {
  const state = setup();
  try {
    const tools = createScheduleTools();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "schedule.list",
      "schedule.create",
      "schedule.cancel",
    ]);
    const context = { workspace: state.directory, runId: "tool-run", repository: state.repository };
    const created = await tools.find((tool) => tool.definition.name === "schedule.create")!.execute(
      { name: "Hourly check", prompt: "check the files", intervalMs: 60_000, timeZone: "UTC" },
      context,
    );
    expect(created.ok).toBe(true);
    const scheduleId = (created.data as { id: string }).id;
    expect((await tools.find((tool) => tool.definition.name === "schedule.list")!.execute({}, context)).data)
      .toMatchObject([{ id: scheduleId, name: "Hourly check", enabled: true, intervalMs: 60_000, timeZone: "UTC" }]);
    const cancelled = await tools.find((tool) => tool.definition.name === "schedule.cancel")!.execute({ id: scheduleId }, context);
    expect(cancelled.ok).toBe(true);
    expect(state.repository.getSchedule(scheduleId)).toMatchObject({ enabled: false });
    expect(state.database.query("SELECT COUNT(*) AS count FROM schedules WHERE id = ?").get(scheduleId)).toEqual({ count: 1 });
  } finally {
    state.cleanup();
  }
});

test("runOnce claims and completes one-shot work, computes the next interval, and prevents duplicate workers", async () => {
  const state = setup();
  try {
    state.repository.createSchedule({
      id: "interval-schedule",
      name: "Interval check",
      workspace: state.directory,
      prompt: "check",
      intervalMs: 60_000,
      timeZone: "UTC",
      nextRunAt: 1_000,
      enabled: true,
    });
    const first = new SchedulerDaemon({ repository: state.repository, kernel: state.kernel, owner: "worker-a", now: () => 1_000 });
    const second = new SchedulerDaemon({ repository: state.repository, kernel: state.kernel, owner: "worker-b", now: () => 1_000 });
    const [firstResult, secondResult] = await Promise.all([first.runOnce(1_000), second.runOnce(1_000)]);
    expect([firstResult, secondResult].filter((result) => result !== null)).toHaveLength(1);
    expect(state.repository.getSchedule("interval-schedule")).toMatchObject({ nextRunAt: 61_000, enabled: true, claimedBy: null, leaseToken: null });
    expect(state.model.requests).toHaveLength(1);
  } finally {
    state.cleanup();
  }
});

test("stale leases recover with a new token and stale workers cannot fence the new completion", async () => {
  const state = setup();
  try {
    state.repository.createSchedule({ id: "fenced", name: "Fenced", workspace: state.directory, prompt: "run", nextRunAt: 1_000, enabled: true });
    const old = state.repository.claimDueSchedule(1_000, "old-worker")!;
    const recovered = state.repository.claimDueSchedule(1_000 + 60_001, "new-worker")!;
    expect(recovered.leaseToken).not.toBe(old.leaseToken);
    expect(state.repository.finishSchedule("fenced", "old-worker", old.leaseToken!, null, "stale")).toBe(false);
    expect(state.repository.finishSchedule("fenced", "new-worker", recovered.leaseToken!, null, null)).toBe(true);
  } finally {
    state.cleanup();
  }
});

test("failed runs persist the error and use bounded retry backoff", async () => {
  const state = setup(new FakeModel([assistant("")]));
  try {
    state.repository.createSchedule({ id: "failing", name: "Failing", workspace: state.directory, prompt: "run", nextRunAt: 1_000, enabled: true });
    const daemon = new SchedulerDaemon({ repository: state.repository, kernel: state.kernel, owner: "worker", now: () => 1_000 });
    const result = await daemon.runOnce(1_000);
    expect(result?.status).toBe("failed");
    expect(state.repository.getSchedule("failing")).toMatchObject({ nextRunAt: 6_000, attempts: 1, lastError: expect.stringMatching(/assistant|final/i) });
    expect(retryDelayMs(30)).toBe(15 * 60_000);
  } finally {
    state.cleanup();
  }
});

test("scheduled risky work pauses at the same approval boundary", async () => {
  const state = setup(new FakeModel([
    { message: { role: "assistant", content: "", toolCalls: [{ id: "scheduled-shell", name: "shell.exec", arguments: { argv: ["echo", "unsafe"] } }] }, finishReason: "tool_calls" },
  ]));
  try {
    state.repository.createSchedule({ id: "approval", name: "Approval", workspace: state.directory, prompt: "run the command", nextRunAt: 1_000, enabled: true });
    const daemon = new SchedulerDaemon({ repository: state.repository, owner: "worker", kernel: state.kernel, now: () => 1_000 });
    const result = await daemon.runOnce(1_000);
    expect(result?.status).toBe("blocked_on_approval");
    expect(state.approvals.get("scheduled-shell")?.status).toBe("pending");
    expect(state.repository.getSchedule("approval")).toMatchObject({ claimedBy: null, leaseToken: null, enabled: false, pendingRunId: result?.runId });
  } finally {
    state.cleanup();
  }
});
