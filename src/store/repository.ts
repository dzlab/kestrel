import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Message, ToolCall } from "../protocol/types";

type Row = Record<string, unknown>;

export type TaskRecord = {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  maxSteps: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type RunRecord = {
  id: string;
  taskId: string;
  idempotencyKey: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
};

export type ApprovalDecision = "pending" | "approved" | "denied";

export type ApprovalRecord = {
  callId: string;
  argumentsHash: string;
  capability: string;
  riskLevel: string;
  taskId?: string | null;
  runId?: string | null;
  decision: ApprovalDecision;
  requestedAt: number;
  resolvedAt?: number | null;
};

export type MemoryRecord = {
  id: string;
  kind: string;
  content: string;
  taskId?: string | null;
  runId?: string | null;
  metadata?: Record<string, unknown>;
  confidence?: number | null;
  createdAt?: number;
  updatedAt?: number;
};

export type ScheduleRecord = {
  id: string;
  prompt: string;
  nextRunAt: number;
  taskId?: string | null;
  cron?: string | null;
  enabled?: boolean;
  claimedBy?: string | null;
  claimedAt?: number | null;
  lastError?: string | null;
  createdAt?: number;
};

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    workspace: String(row.workspace),
    maxSteps: Number(row.max_steps),
    status: String(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function runFromRow(row: Row): RunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  };
}

function approvalFromRow(row: Row): ApprovalRecord {
  return {
    callId: String(row.call_id),
    argumentsHash: String(row.arguments_hash),
    capability: String(row.capability),
    riskLevel: String(row.risk_level),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    decision: String(row.decision) as ApprovalDecision,
    requestedAt: Number(row.requested_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
  };
}

function memoryFromRow(row: Row): MemoryRecord {
  return {
    id: String(row.id),
    kind: String(row.kind),
    content: String(row.content),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function scheduleFromRow(row: Row): ScheduleRecord {
  return {
    id: String(row.id),
    prompt: String(row.prompt),
    nextRunAt: Number(row.next_run_at),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    cron: row.cron === null || row.cron === undefined ? null : String(row.cron),
    enabled: Number(row.enabled) === 1,
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  };
}

export class StoreRepository {
  constructor(private readonly database: Database) {}

  createTask(input: {
    title: string;
    prompt: string;
    workspace: string;
    maxSteps: number;
  }): TaskRecord {
    const id = randomUUID();
    const timestamp = Date.now();
    const transaction = this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, input.prompt, input.workspace, input.maxSteps, "pending", timestamp, timestamp);
      this.database
        .query("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(id, "created", json(input), timestamp);
    });
    transaction();

    return taskFromRow(this.database.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row);
  }

  startRun(taskId: string, idempotencyKey: string): RunRecord {
    const id = randomUUID();
    const startedAt = Date.now();
    this.database
      .query(
        `INSERT INTO runs (id, task_id, idempotency_key, status, started_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (task_id, idempotency_key) DO NOTHING`,
      )
      .run(id, taskId, idempotencyKey, "running", startedAt);

    return runFromRow(
      this.database
        .query("SELECT * FROM runs WHERE task_id = ? AND idempotency_key = ?")
        .get(taskId, idempotencyKey) as Row,
    );
  }

  appendMessage(runId: string, message: Message): void {
    const transaction = this.database.transaction(() => {
      const row = this.database
        .query("SELECT COALESCE(MAX(sequence_number), -1) + 1 AS sequence_number FROM messages WHERE run_id = ?")
        .get(runId) as { sequence_number: number };
      this.database
        .query("INSERT INTO messages (run_id, sequence_number, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, row.sequence_number, json(message), Date.now());
    });
    transaction();
  }

  appendEvent(runId: string, type: string, payload: unknown): void {
    this.database
      .query("INSERT INTO events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(runId, type, json(payload), Date.now());
  }

  recordToolCall(runId: string, call: ToolCall, state: string): boolean {
    const result = this.database
      .query(
        `INSERT INTO tool_calls (run_id, call_id, name, arguments, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_id) DO NOTHING`,
      )
      .run(runId, call.id, call.name, json(call.arguments), state, Date.now());

    return result.changes === 1;
  }

  finishToolCall(runId: string, callId: string, result: unknown, state: string): void {
    this.database
      .query(
        `UPDATE tool_calls
         SET result = ?, state = ?, finished_at = ?
         WHERE run_id = ? AND call_id = ?`,
      )
      .run(json(result), state, Date.now(), runId, callId);
  }

  saveApproval(input: ApprovalRecord): void {
    this.database
      .query(
        `INSERT INTO approvals
          (call_id, arguments_hash, task_id, run_id, capability, risk_level, decision, requested_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (call_id, arguments_hash) DO UPDATE SET
           task_id = excluded.task_id,
           run_id = excluded.run_id,
           capability = excluded.capability,
           risk_level = excluded.risk_level,
           decision = excluded.decision,
           requested_at = excluded.requested_at,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        input.callId,
        input.argumentsHash,
        input.taskId ?? null,
        input.runId ?? null,
        input.capability,
        input.riskLevel,
        input.decision,
        input.requestedAt,
        input.resolvedAt ?? null,
      );
  }

  getApproval(callId: string, argumentsHash: string): ApprovalRecord | null {
    const row = this.database
      .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
      .get(callId, argumentsHash) as Row | null;
    return row === null ? null : approvalFromRow(row);
  }

  saveMemory(input: MemoryRecord): void {
    const timestamp = Date.now();
    this.database
      .query(
        `INSERT INTO memories
          (id, task_id, run_id, kind, content, metadata, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           task_id = excluded.task_id,
           run_id = excluded.run_id,
           kind = excluded.kind,
           content = excluded.content,
           metadata = excluded.metadata,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.taskId ?? null,
        input.runId ?? null,
        input.kind,
        input.content,
        json(input.metadata ?? {}),
        input.confidence ?? null,
        input.createdAt ?? timestamp,
        input.updatedAt ?? timestamp,
      );
  }

  searchMemories(query: string, limit: number): MemoryRecord[] {
    const rows = this.database
      .query(
        `SELECT * FROM memories
         WHERE content LIKE ? OR metadata LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(`%${query}%`, `%${query}%`, limit) as Row[];
    return rows.map(memoryFromRow);
  }

  createSchedule(input: ScheduleRecord): void {
    this.database
      .query(
        `INSERT INTO schedules
          (id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.taskId ?? null,
        input.prompt,
        input.cron ?? null,
        input.nextRunAt,
        input.enabled === false ? 0 : 1,
        input.claimedBy ?? null,
        input.claimedAt ?? null,
        input.lastError ?? null,
        input.createdAt ?? Date.now(),
      );
  }

  claimDueSchedule(now: number, owner: string): ScheduleRecord | null {
    const transaction = this.database.transaction(() => {
      const row = this.database
        .query(
          `SELECT id FROM schedules
           WHERE enabled = 1 AND next_run_at <= ? AND claimed_by IS NULL
           ORDER BY next_run_at, id
           LIMIT 1`,
        )
        .get(now) as { id: string } | null;
      if (row === null) {
        return null;
      }

      const updated = this.database
        .query(
          `UPDATE schedules
           SET claimed_by = ?, claimed_at = ?
           WHERE id = ? AND enabled = 1 AND next_run_at <= ? AND claimed_by IS NULL`,
        )
        .run(owner, now, row.id, now);
      if (updated.changes !== 1) {
        return null;
      }

      return scheduleFromRow(this.database.query("SELECT * FROM schedules WHERE id = ?").get(row.id) as Row);
    });

    return transaction();
  }

  finishSchedule(id: string, nextRunAt: number | null, error: string | null): void {
    this.database
      .query(
        `UPDATE schedules
         SET next_run_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL,
             enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END
         WHERE id = ?`,
      )
      .run(nextRunAt, error, nextRunAt, id);
  }
}

export { StoreRepository as Repository };
