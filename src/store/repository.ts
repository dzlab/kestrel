import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ConversationMessageRecord,
  ConversationRecord,
  ConversationRole,
} from "../conversations/types";
import { PersistenceError, ValidationError } from "../errors";
import { parseMessage } from "../protocol/validation";
import type { Message, RunStatus, ToolCall } from "../protocol/types";
import { immediateTransaction } from "./transaction";
import { redactUnknown } from "../tools/redaction";

type Row = Record<string, unknown>;

const MAX_CONVERSATION_LIST_LIMIT = 100;
const MAX_CONVERSATION_MESSAGE_LIMIT = 1_000;
const MAX_CONVERSATION_TASK_LIMIT = 1_000;
const MAX_EVENT_PAGE_LIMIT = 1_000;

export type TaskRecord = {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  maxSteps: number;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
};

export type RunRecord = {
  id: string;
  taskId: string;
  idempotencyKey: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  options: RunOptionsSnapshot;
};

export type RunOptionsSnapshot = {
  modelName?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  timeoutMs?: number;
  toolTimeoutMs?: number;
  contextBytes?: number;
  userId?: string;
};

export type ToolCallRecord = {
  runId: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  state: string;
  result: unknown | null;
  createdAt: number;
  finishedAt: number | null;
};

export type EventRecord = {
  id: number;
  runId: string | null;
  taskId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type ApprovalDecision = "pending" | "approved" | "denied";

export type TaskStatus = "pending" | RunStatus;

export type ApprovalRecord = {
  callId: string;
  argumentsHash: string;
  tool?: string;
  capability: string;
  riskLevel: string;
  taskId?: string | null;
  runId?: string | null;
  decision: ApprovalDecision;
  requestedAt: number;
  expiresAt?: number;
  resolvedAt?: number | null;
  consumedAt?: number | null;
  expiredAt?: number | null;
  version?: number;
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
  scope?: string;
  userId?: string;
  tags?: string[];
  source?: string;
  sourceTaskId?: string;
  sourceRunId?: string | null;
  expiresAt?: number | null;
};

export type MemorySearchOptions = {
  scope?: string;
  userId?: string;
  taskId?: string | null;
  now?: number;
  maxBytes?: number;
};

export type ScheduleRecord = {
  id: string;
  name?: string;
  workspace?: string;
  prompt: string;
  nextRunAt: number | null;
  taskId?: string | null;
  cron?: string | null;
  rrule?: string | null;
  intervalMs?: number | null;
  timeZone?: string;
  enabled?: boolean;
  claimedBy?: string | null;
  owner?: string | null;
  claimedAt?: number | null;
  leaseUntil?: number | null;
  leaseToken?: string | null;
  attempts?: number;
  lastRunAt?: number | null;
  pendingRunId?: string | null;
  pendingApprovalId?: string | null;
  lastError?: string | null;
  createdAt?: number;
};

export const SCHEDULE_LEASE_TIMEOUT_MS = 60_000;

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function messageFromRow(row: Row): Message {
  try {
    return parseMessage(parseJson<unknown>(row.payload));
  } catch (error) {
    throw new PersistenceError("persisted message is malformed", { cause: error });
  }
}

function toolCallFromRow(row: Row): ToolCallRecord {
  let args: Record<string, unknown>;
  let result: unknown | null = null;
  try {
    args = parseJson<Record<string, unknown>>(row.arguments);
    if (row.result !== null && row.result !== undefined) result = parseJson<unknown>(row.result);
  } catch (error) {
    throw new PersistenceError("persisted tool call payload is malformed", { cause: error });
  }
  return {
    runId: String(row.run_id),
    callId: String(row.call_id),
    name: String(row.name),
    arguments: args,
    state: String(row.state),
    result,
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  };
}

function eventFromRow(row: Row): EventRecord {
  try {
    return {
      id: Number(row.id),
      runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
      taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
      type: String(row.type),
      payload: redactUnknown(parseJson<unknown>(row.payload)),
      createdAt: Number(row.created_at),
    };
  } catch (error) {
    throw new PersistenceError("persisted event payload is malformed", { cause: error });
  }
}

const runStatuses: readonly RunStatus[] = [
  "running",
  "completed",
  "failed",
  "blocked_on_approval",
  "budget_exhausted",
  "cancelled",
];

const taskStatuses: readonly TaskStatus[] = ["pending", ...runStatuses];

function parseRunStatus(value: unknown): RunStatus {
  if (typeof value !== "string" || !runStatuses.includes(value as RunStatus)) {
    throw new PersistenceError(`invalid persisted run status: ${String(value)}`);
  }
  return value as RunStatus;
}

function parseTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !taskStatuses.includes(value as TaskStatus)) {
    throw new PersistenceError(`invalid persisted task status: ${String(value)}`);
  }
  return value as TaskStatus;
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    prompt: String(row.prompt),
    workspace: String(row.workspace),
    maxSteps: Number(row.max_steps),
    status: parseTaskStatus(row.status),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function conversationFromRow(row: Row): ConversationRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    workspace: String(row.workspace),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const conversationRoles: readonly ConversationRole[] = ["user", "assistant"];

function parseConversationRole(value: unknown): ConversationRole {
  if (typeof value !== "string" || !conversationRoles.includes(value as ConversationRole)) {
    throw new PersistenceError(`invalid persisted conversation role: ${String(value)}`);
  }
  return value as ConversationRole;
}

function conversationMessageFromRow(row: Row): ConversationMessageRecord {
  return {
    conversationId: String(row.conversation_id),
    sequenceNumber: Number(row.sequence_number),
    role: parseConversationRole(row.role),
    content: String(row.content),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    createdAt: Number(row.created_at),
  };
}

function requireNonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${name} must be non-empty text`);
  }
  return value;
}

function requireLimit(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ValidationError(`${name} must be between 1 and ${maximum}`);
  }
}

function requireConversationRole(value: unknown): ConversationRole {
  if (typeof value !== "string" || !conversationRoles.includes(value as ConversationRole)) {
    throw new ValidationError("conversation message role must be user or assistant");
  }
  return value as ConversationRole;
}

function runFromRow(row: Row): RunRecord {
  let options: RunOptionsSnapshot = {};
  if (row.options !== null && row.options !== undefined) {
    try {
      const parsed = parseJson<unknown>(row.options);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) options = parsed as RunOptionsSnapshot;
    } catch (error) {
      throw new PersistenceError("persisted run options are malformed", { cause: error });
    }
  }
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    idempotencyKey: String(row.idempotency_key),
    status: parseRunStatus(row.status),
    startedAt: Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    options,
  };
}

function approvalFromRow(row: Row): ApprovalRecord {
  return {
    callId: String(row.call_id),
    argumentsHash: String(row.arguments_hash),
    tool: row.tool === null || row.tool === undefined ? undefined : String(row.tool),
    capability: String(row.capability),
    riskLevel: String(row.risk_level),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    decision: parseApprovalDecision(row.decision),
    requestedAt: Number(row.requested_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? undefined : Number(row.expires_at),
    resolvedAt: row.resolved_at === null || row.resolved_at === undefined ? null : Number(row.resolved_at),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : Number(row.consumed_at),
    expiredAt: row.expired_at === null || row.expired_at === undefined ? null : Number(row.expired_at),
    version: Number(row.version),
  };
}

const approvalDecisions: readonly ApprovalDecision[] = ["pending", "approved", "denied"];

function parseApprovalDecision(value: unknown): ApprovalDecision {
  if (typeof value !== "string" || !approvalDecisions.includes(value as ApprovalDecision)) {
    throw new PersistenceError(`invalid persisted approval decision: ${String(value)}`);
  }
  return value as ApprovalDecision;
}

function memoryFromRow(row: Row): MemoryRecord {
  let metadata: Record<string, unknown>;
  let tags: string[];
  try {
    metadata = parseJson<Record<string, unknown>>(row.metadata);
    const parsedTags = parseJson<unknown>(row.tags ?? "[]");
    if (!Array.isArray(parsedTags) || parsedTags.some((tag) => typeof tag !== "string")) {
      throw new Error("tags must be an array of strings");
    }
    tags = parsedTags;
  } catch (error) {
    throw new PersistenceError("persisted memory payload is malformed", { cause: error });
  }
  return {
    id: String(row.id),
    kind: String(row.kind),
    content: String(row.content),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    runId: row.run_id === null || row.run_id === undefined ? null : String(row.run_id),
    metadata,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    scope: row.scope === null || row.scope === undefined ? "legacy" : String(row.scope),
    userId: row.user_id === null || row.user_id === undefined ? "legacy" : String(row.user_id),
    tags,
    source: row.source === null || row.source === undefined ? "legacy" : String(row.source),
    sourceTaskId: row.source_task_id === null || row.source_task_id === undefined ? "legacy" : String(row.source_task_id),
    sourceRunId: row.source_run_id === null || row.source_run_id === undefined
      ? (row.run_id === null || row.run_id === undefined ? null : String(row.run_id))
      : String(row.source_run_id),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  };
}

function scheduleFromRow(row: Row): ScheduleRecord {
  if (row.enabled !== 0 && row.enabled !== 1) {
    throw new PersistenceError(`invalid persisted schedule enabled value: ${String(row.enabled)}`);
  }
  const hasClaimedBy = row.claimed_by !== null && row.claimed_by !== undefined;
  const hasClaimedAt = row.claimed_at !== null && row.claimed_at !== undefined;
  const hasLeaseToken = row.lease_token !== null && row.lease_token !== undefined;
  const hasLeaseUntil = row.lease_until !== null && row.lease_until !== undefined;
  if (hasClaimedBy !== hasClaimedAt || hasClaimedBy !== hasLeaseToken || hasClaimedBy !== hasLeaseUntil) {
    throw new PersistenceError(`invalid persisted schedule lease tuple for ${String(row.id)}`);
  }
  return {
    id: String(row.id),
    name: row.name === null || row.name === undefined || String(row.name).length === 0 ? String(row.id) : String(row.name),
    workspace: row.workspace === null || row.workspace === undefined ? "" : String(row.workspace),
    prompt: String(row.prompt),
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : Number(row.next_run_at),
    taskId: row.task_id === null || row.task_id === undefined ? null : String(row.task_id),
    cron: row.cron === null || row.cron === undefined ? null : String(row.cron),
    rrule: row.rrule === null || row.rrule === undefined ? null : String(row.rrule),
    intervalMs: row.interval_ms === null || row.interval_ms === undefined ? null : Number(row.interval_ms),
    timeZone: row.time_zone === null || row.time_zone === undefined ? "UTC" : String(row.time_zone),
    enabled: row.enabled === 1,
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    owner: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
    leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
    leaseToken: row.lease_token === null || row.lease_token === undefined ? null : String(row.lease_token),
    attempts: row.attempts === null || row.attempts === undefined ? 0 : Number(row.attempts),
    lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : Number(row.last_run_at),
    pendingRunId: row.pending_run_id === null || row.pending_run_id === undefined ? null : String(row.pending_run_id),
    pendingApprovalId: row.pending_approval_id === null || row.pending_approval_id === undefined ? null : String(row.pending_approval_id),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: Number(row.created_at),
  };
}

export class StoreRepository {
  constructor(private readonly database: Database) {}

  createConversation(input: { title: string; workspace: string }): ConversationRecord {
    const title = requireNonEmptyText(input.title, "conversation title");
    const workspace = requireNonEmptyText(input.workspace, "conversation workspace");
    const id = randomUUID();
    const timestamp = Date.now();
    this.database
      .query(
        `INSERT INTO conversations (id, title, workspace, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, title, workspace, timestamp, timestamp);
    return conversationFromRow(this.database.query("SELECT * FROM conversations WHERE id = ?").get(id) as Row);
  }

  listConversations(limit = 50): ConversationRecord[] {
    requireLimit(limit, "conversation history limit", MAX_CONVERSATION_LIST_LIMIT);
    const rows = this.database
      .query("SELECT * FROM conversations ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(conversationFromRow);
  }

  getConversation(conversationId: string): ConversationRecord | null {
    const row = this.database.query("SELECT * FROM conversations WHERE id = ?").get(conversationId) as Row | null;
    return row === null ? null : conversationFromRow(row);
  }

  createConversationTurn(
    conversationId: string,
    input: { title: string; content: string; maxSteps: number },
  ): { conversationMessage: ConversationMessageRecord; task: TaskRecord } {
    const title = requireNonEmptyText(input.title, "task title");
    const content = requireNonEmptyText(input.content, "conversation message content");
    if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps <= 0) {
      throw new ValidationError("task max steps must be a positive integer");
    }

    return immediateTransaction(this.database, () => {
      const conversationRow = this.database
        .query("SELECT * FROM conversations WHERE id = ?")
        .get(conversationId) as Row | null;
      if (conversationRow === null) throw new PersistenceError(`conversation ${conversationId} was not found`);
      const conversation = conversationFromRow(conversationRow);
      const taskId = randomUUID();
      const timestamp = Date.now();

      this.database
        .query(
          `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, title, content, conversation.workspace, input.maxSteps, "pending", timestamp, timestamp);
      this.database
        .query("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(
          taskId,
          "created",
          json(redactUnknown({ title, prompt: content, workspace: conversation.workspace, maxSteps: input.maxSteps })),
          timestamp,
        );
      this.database
        .query("INSERT INTO conversation_tasks (task_id, conversation_id, created_at) VALUES (?, ?, ?)")
        .run(taskId, conversationId, timestamp);

      const sequence = this.database
        .query(
          `SELECT COALESCE(MAX(sequence_number), -1) + 1 AS sequence_number
           FROM conversation_messages WHERE conversation_id = ?`,
        )
        .get(conversationId) as { sequence_number: number };
      this.database
        .query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence_number, role, content, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(conversationId, sequence.sequence_number, "user", content, null, timestamp);
      this.database
        .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(timestamp, conversationId);

      const messageRow = this.database
        .query("SELECT * FROM conversation_messages WHERE conversation_id = ? AND sequence_number = ?")
        .get(conversationId, sequence.sequence_number) as Row;
      const taskRow = this.database.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row;
      return { conversationMessage: conversationMessageFromRow(messageRow), task: taskFromRow(taskRow) };
    });
  }

  appendConversationMessage(
    conversationId: string,
    input: { role: ConversationRole; content: string; runId?: string | null },
  ): ConversationMessageRecord {
    const role = requireConversationRole(input.role);
    const content = requireNonEmptyText(input.content, "conversation message content");
    if (input.runId !== undefined && input.runId !== null) {
      requireNonEmptyText(input.runId, "conversation message run ID");
    }

    return immediateTransaction(this.database, () => {
      if (this.database.query("SELECT 1 FROM conversations WHERE id = ?").get(conversationId) === null) {
        throw new PersistenceError(`conversation ${conversationId} was not found`);
      }
      if (
        input.runId !== undefined &&
        input.runId !== null &&
        this.database
          .query(
            `SELECT 1 FROM runs
             INNER JOIN conversation_tasks ON conversation_tasks.task_id = runs.task_id
             WHERE runs.id = ? AND conversation_tasks.conversation_id = ?`,
          )
          .get(input.runId, conversationId) === null
      ) {
        throw new PersistenceError(`run ${input.runId} does not belong to conversation ${conversationId}`);
      }
      const sequence = this.database
        .query(
          `SELECT COALESCE(MAX(sequence_number), -1) + 1 AS sequence_number
           FROM conversation_messages WHERE conversation_id = ?`,
        )
        .get(conversationId) as { sequence_number: number };
      const timestamp = Date.now();
      this.database
        .query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence_number, role, content, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(conversationId, sequence.sequence_number, role, content, input.runId ?? null, timestamp);
      this.database
        .query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(timestamp, conversationId);
      const row = this.database
        .query("SELECT * FROM conversation_messages WHERE conversation_id = ? AND sequence_number = ?")
        .get(conversationId, sequence.sequence_number) as Row;
      return conversationMessageFromRow(row);
    });
  }

  listConversationMessages(conversationId: string, limit = 100): ConversationMessageRecord[] {
    requireLimit(limit, "conversation message limit", MAX_CONVERSATION_MESSAGE_LIMIT);
    const rows = this.database
      .query(
        `SELECT * FROM (
           SELECT * FROM conversation_messages
           WHERE conversation_id = ?
           ORDER BY sequence_number DESC
           LIMIT ?
         ) ORDER BY sequence_number ASC`,
      )
      .all(conversationId, limit) as Row[];
    return rows.map(conversationMessageFromRow);
  }

  listConversationTasks(conversationId: string, limit = 100): TaskRecord[] {
    requireLimit(limit, "conversation task limit", MAX_CONVERSATION_TASK_LIMIT);
    const rows = this.database
      .query(
        `SELECT tasks.* FROM (
           SELECT task_id, created_at FROM conversation_tasks
           WHERE conversation_id = ?
           ORDER BY created_at DESC, task_id DESC
           LIMIT ?
         ) AS recent
         INNER JOIN tasks ON tasks.id = recent.task_id
         ORDER BY recent.created_at ASC, recent.task_id ASC`,
      )
      .all(conversationId, limit) as Row[];
    return rows.map(taskFromRow);
  }

  listTasks(limit = 50): TaskRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new ValidationError("task history limit must be between 1 and 100");
    }
    const rows = this.database
      .query("SELECT * FROM tasks ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(taskFromRow);
  }

  getTask(taskId: string): TaskRecord | null {
    const row = this.database.query("SELECT * FROM tasks WHERE id = ?").get(taskId) as Row | null;
    return row === null ? null : taskFromRow(row);
  }

  createTask(input: {
    title: string;
    prompt: string;
    workspace: string;
    maxSteps: number;
  }): TaskRecord {
    const id = randomUUID();
    const timestamp = Date.now();
    immediateTransaction(this.database, () => {
      this.database
        .query(
          `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.title, input.prompt, input.workspace, input.maxSteps, "pending", timestamp, timestamp);
      this.database
        .query("INSERT INTO events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(id, "created", json(redactUnknown(input)), timestamp);
    });

    return taskFromRow(this.database.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row);
  }

  startRun(taskId: string, idempotencyKey: string, options: RunOptionsSnapshot = {}): RunRecord {
    const id = randomUUID();
    const startedAt = Date.now();
    return immediateTransaction(this.database, () => {
      this.database
        .query(
          `INSERT INTO runs (id, task_id, idempotency_key, status, started_at, options)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (task_id, idempotency_key) DO NOTHING`,
        )
        .run(id, taskId, idempotencyKey, "running", startedAt, json(options));

      return runFromRow(
        this.database
          .query("SELECT * FROM runs WHERE task_id = ? AND idempotency_key = ?")
          .get(taskId, idempotencyKey) as Row,
      );
    });
  }

  getRun(runId: string): RunRecord | null {
    const row = this.database.query("SELECT * FROM runs WHERE id = ?").get(runId) as Row | null;
    return row === null ? null : runFromRow(row);
  }

  getLatestRunForTask(taskId: string): RunRecord | null {
    const row = this.database
      .query("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as Row | null;
    return row === null ? null : runFromRow(row);
  }

  getMessages(runId: string): Message[] {
    const rows = this.database
      .query("SELECT * FROM messages WHERE run_id = ? ORDER BY sequence_number")
      .all(runId) as Row[];
    return rows.map(messageFromRow);
  }

  getEvents(runId: string): EventRecord[] {
    const rows = this.database
      .query("SELECT * FROM events WHERE run_id = ? ORDER BY id")
      .all(runId) as Row[];
    return rows.map(eventFromRow);
  }

  getEventsAfter(runId: string, eventId: number, limit = 100): EventRecord[] {
    if (!Number.isSafeInteger(eventId) || eventId < 0) {
      throw new ValidationError("event cursor must be a non-negative integer");
    }
    requireLimit(limit, "event page limit", MAX_EVENT_PAGE_LIMIT);
    const rows = this.database
      .query("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
      .all(runId, eventId, limit) as Row[];
    return rows.map(eventFromRow);
  }

  appendMessage(runId: string, message: Message): void {
    immediateTransaction(this.database, () => {
      const row = this.database
        .query("SELECT COALESCE(MAX(sequence_number), -1) + 1 AS sequence_number FROM messages WHERE run_id = ?")
        .get(runId) as { sequence_number: number };
      this.database
        .query("INSERT INTO messages (run_id, sequence_number, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, row.sequence_number, json(message), Date.now());
    });
  }

  initializeRunMessages(runId: string, messages: readonly Message[]): boolean {
    return immediateTransaction(this.database, () => {
      const run = this.database.query("SELECT task_id FROM runs WHERE id = ?").get(runId) as { task_id: string } | null;
      if (run === null) throw new PersistenceError(`run ${runId} was not found`);
      const existingMessage = this.database.query("SELECT 1 FROM messages WHERE run_id = ? LIMIT 1").get(runId);
      const startedEvent = this.database
        .query("SELECT 1 FROM events WHERE run_id = ? AND type = ? LIMIT 1")
        .get(runId, "run.started");
      if (existingMessage !== null || startedEvent !== null) return false;

      const timestamp = Date.now();
      for (let sequenceNumber = 0; sequenceNumber < messages.length; sequenceNumber += 1) {
        this.database
          .query("INSERT INTO messages (run_id, sequence_number, payload, created_at) VALUES (?, ?, ?, ?)")
          .run(runId, sequenceNumber, json(messages[sequenceNumber]!), timestamp);
      }
      this.database
        .query("INSERT INTO events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, "run.started", json({ taskId: run.task_id }), timestamp);
      return true;
    });
  }

  getToolCall(callId: string): ToolCallRecord | null {
    const row = this.database.query("SELECT * FROM tool_calls WHERE call_id = ?").get(callId) as Row | null;
    return row === null ? null : toolCallFromRow(row);
  }

  getToolCalls(runId: string): ToolCallRecord[] {
    const rows = this.database
      .query("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY created_at, id")
      .all(runId) as Row[];
    return rows.map(toolCallFromRow);
  }

  updateToolCallState(runId: string, callId: string, state: string): void {
    immediateTransaction(this.database, () => {
      const update = this.database
        .query("UPDATE tool_calls SET state = ? WHERE run_id = ? AND call_id = ? AND finished_at IS NULL")
        .run(state, runId, callId);
      if (update.changes !== 1) {
        throw new PersistenceError(`tool call ${callId} is not an unfinished call for run ${runId}`);
      }
    });
  }

  updateRunStatus(runId: string, status: RunStatus): RunRecord {
    if (!runStatuses.includes(status)) throw new ValidationError(`invalid run status: ${status}`);
    return immediateTransaction(this.database, () => {
      const now = Date.now();
      const finishedAt = status === "running" ? null : now;
      const update = this.database
        .query("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
        .run(status, finishedAt, runId);
      if (update.changes !== 1) throw new PersistenceError(`run ${runId} was not found`);
      const run = runFromRow(this.database.query("SELECT * FROM runs WHERE id = ?").get(runId) as Row);
      this.database
        .query("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, run.taskId);
      return run;
    });
  }

  appendEvent(runId: string, type: string, payload: unknown): void {
    immediateTransaction(this.database, () => {
      this.database
        .query("INSERT INTO events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)")
        .run(runId, type, json(redactUnknown(payload)), Date.now());
    });
  }

  recordToolCall(runId: string, call: ToolCall, state: string): boolean {
    const argumentsJson = canonicalJson(call.arguments);
    return immediateTransaction(this.database, () => {
      const result = this.database
        .query(
          `INSERT INTO tool_calls (run_id, call_id, name, arguments, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (call_id) DO NOTHING`,
        )
        .run(runId, call.id, call.name, argumentsJson, state, Date.now());

      if (result.changes === 1) {
        return true;
      }

      const existing = this.database
        .query("SELECT run_id, name, arguments FROM tool_calls WHERE call_id = ?")
        .get(call.id) as { run_id: string; name: string; arguments: string } | null;
      if (
        existing === null ||
        existing.run_id !== runId ||
        existing.name !== call.name ||
        canonicalArguments(existing.arguments) !== argumentsJson
      ) {
        throw new PersistenceError(`tool call ID ${call.id} conflicts with an existing call`);
      }
      return false;
    });
  }

  finishToolCall(runId: string, callId: string, result: unknown, state: string): void {
    immediateTransaction(this.database, () => {
      const resultJson = json(redactUnknown(result));
      const update = this.database
        .query(
          `UPDATE tool_calls
           SET result = ?, state = ?, finished_at = ?
           WHERE run_id = ? AND call_id = ? AND finished_at IS NULL`,
        )
        .run(resultJson, state, Date.now(), runId, callId);
      if (update.changes === 1) {
        return;
      }

      const existing = this.database
        .query("SELECT run_id, result, state, finished_at FROM tool_calls WHERE call_id = ?")
        .get(callId) as { run_id: string; result: string | null; state: string; finished_at: number | null } | null;
      if (
        existing !== null &&
        existing.run_id === runId &&
        existing.finished_at !== null &&
        existing.result === resultJson &&
        existing.state === state
      ) {
        return;
      }

      throw new PersistenceError(`tool call ${callId} was not found for run ${runId}`);
    });
  }

  saveApproval(input: ApprovalRecord): ApprovalRecord {
    return immediateTransaction(this.database, () => {
      const inserted = this.database
        .query(
          `INSERT INTO approvals
            (call_id, arguments_hash, tool, task_id, run_id, capability, risk_level, decision, requested_at, expires_at, resolved_at, consumed_at, expired_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (call_id, arguments_hash) DO NOTHING`,
        )
        .run(
          input.callId,
          input.argumentsHash,
          input.tool ?? "",
          input.taskId ?? null,
          input.runId ?? null,
          input.capability,
          input.riskLevel,
          input.decision,
          input.requestedAt,
          input.expiresAt ?? input.requestedAt + 300_000,
          input.resolvedAt ?? null,
          input.consumedAt ?? null,
          input.expiredAt ?? null,
          input.version ?? 0,
        );
      const stored = approvalFromRow(this.database
        .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
        .get(input.callId, input.argumentsHash) as Row);
      if (inserted.changes === 1) {
        this.database
          .query("INSERT INTO events (task_id, run_id, type, payload, created_at) SELECT task_id, run_id, ?, ?, ? FROM approvals WHERE call_id = ? AND arguments_hash = ?")
          .run("approval.requested", json({ callId: input.callId, argumentsHash: input.argumentsHash }), input.resolvedAt ?? Date.now(), input.callId, input.argumentsHash);
      }
      return stored;
    });
  }

  getApproval(callId: string, argumentsHash: string): ApprovalRecord | null {
    const row = this.database
      .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
      .get(callId, argumentsHash) as Row | null;
    return row === null ? null : approvalFromRow(row);
  }

  getApprovalByCallId(callId: string): ApprovalRecord | null {
    const row = this.database
      .query("SELECT * FROM approvals WHERE call_id = ? ORDER BY requested_at DESC LIMIT 1")
      .get(callId) as Row | null;
    return row === null ? null : approvalFromRow(row);
  }

  updateApprovalDecision(
    callId: string,
    argumentsHash: string,
    expectedVersion: number,
    expectedDecision: "pending",
    decision: "approved" | "denied",
    now: number,
  ): ApprovalRecord | null {
    return immediateTransaction(this.database, () => {
      const updated = this.database
        .query(
          `UPDATE approvals SET decision = ?, resolved_at = ?, version = version + 1
           WHERE call_id = ? AND arguments_hash = ? AND version = ? AND decision = ?
             AND consumed_at IS NULL AND expired_at IS NULL AND expires_at > ?`,
        )
        .run(decision, now, callId, argumentsHash, expectedVersion, expectedDecision, now);
      if (updated.changes !== 1) return null;
      const record = approvalFromRow(this.database.query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?").get(callId, argumentsHash) as Row);
      this.appendApprovalEvent(record, `approval.${decision}`, now);
      return record;
    });
  }

  consumeApproval(callId: string, argumentsHash: string, now: number, expectedVersion: number): ApprovalRecord | null {
    return immediateTransaction(this.database, () => {
      const current = this.database
        .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
        .get(callId, argumentsHash) as Row | null;
      if (current === null) return null;
      const record = approvalFromRow(current);
      if (record.consumedAt !== null && record.consumedAt !== undefined) return null;
      if (record.expiredAt !== null && record.expiredAt !== undefined) return null;
      if (record.decision !== "approved" || record.version !== expectedVersion) return null;
      if (record.expiresAt === undefined || now >= record.expiresAt) {
        this.expireApprovalInTransaction(record, now, expectedVersion, "approved");
        return null;
      }
      const updated = this.database
        .query(
          `UPDATE approvals SET consumed_at = ?, resolved_at = ?, version = version + 1
           WHERE call_id = ? AND arguments_hash = ? AND version = ? AND decision = 'approved'
             AND consumed_at IS NULL AND expired_at IS NULL AND expires_at > ?`,
        )
        .run(now, now, callId, argumentsHash, expectedVersion, now);
      if (updated.changes !== 1) return null;
      const consumed = approvalFromRow(this.database
        .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
        .get(callId, argumentsHash) as Row);
      this.appendApprovalEvent(consumed, "approval.consumed", now);
      return consumed;
    });
  }

  expireApproval(callId: string, argumentsHash: string, now: number, expectedVersion: number): ApprovalRecord | null {
    return immediateTransaction(this.database, () => {
      const row = this.database
        .query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?")
        .get(callId, argumentsHash) as Row | null;
      return row === null ? null : this.expireApprovalInTransaction(approvalFromRow(row), now, expectedVersion);
    });
  }

  private expireApprovalInTransaction(record: ApprovalRecord, now: number, expectedVersion: number, expectedDecision?: "pending" | "approved"): ApprovalRecord | null {
    if (record.expiredAt !== null && record.expiredAt !== undefined) return record;
    if (record.expiresAt === undefined || now < record.expiresAt) return record;
    const updated = this.database
      .query(
        `UPDATE approvals SET expired_at = ?, resolved_at = ?, version = version + 1
         WHERE call_id = ? AND arguments_hash = ? AND version = ? AND decision IN ('pending', 'approved')
           AND (? IS NULL OR decision = ?) AND consumed_at IS NULL AND expired_at IS NULL`,
      )
      .run(now, now, record.callId, record.argumentsHash, expectedVersion, expectedDecision ?? null, expectedDecision ?? null);
    if (updated.changes !== 1) return approvalFromRow(this.database.query("SELECT * FROM approvals WHERE call_id = ? AND arguments_hash = ?").get(record.callId, record.argumentsHash) as Row);
    const expired = { ...record, expiredAt: now, resolvedAt: now, version: (record.version ?? 0) + 1 };
    this.appendApprovalEvent(expired, "approval.expired", now);
    return expired;
  }

  private appendApprovalEvent(record: ApprovalRecord, type: string, createdAt: number): void {
    this.database
      .query("INSERT INTO events (task_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(record.taskId ?? null, record.runId ?? null, type, json({ callId: record.callId, argumentsHash: record.argumentsHash }), createdAt);
  }

  saveMemory(input: MemoryRecord): void {
    const timestamp = Date.now();
    immediateTransaction(this.database, () => {
      this.database
        .query(
          `INSERT INTO memories
            (id, task_id, run_id, kind, content, metadata, confidence, created_at, updated_at,
             scope, user_id, tags, source, source_run_id, expires_at, source_task_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             task_id = excluded.task_id,
             run_id = excluded.run_id,
             kind = excluded.kind,
             content = excluded.content,
             metadata = excluded.metadata,
             confidence = excluded.confidence,
             scope = excluded.scope,
             user_id = excluded.user_id,
             tags = excluded.tags,
             source = excluded.source,
             source_task_id = excluded.source_task_id,
             source_run_id = excluded.source_run_id,
             expires_at = excluded.expires_at,
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
          input.scope ?? "legacy",
          input.userId ?? "legacy",
          json(input.tags ?? []),
          input.source ?? input.taskId ?? "legacy",
          input.sourceRunId ?? input.runId ?? null,
          input.expiresAt ?? null,
          input.sourceTaskId ?? "legacy",
        );
    });
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.database.query("SELECT * FROM memories WHERE id = ?").get(id) as Row | null;
    return row === null ? null : memoryFromRow(row);
  }

  listMemories(limit = 50): MemoryRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new ValidationError("memory inspection limit must be between 1 and 100");
    }
    return (this.database
      .query("SELECT * FROM memories ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?")
      .all(limit) as Row[]).map(memoryFromRow);
  }

  searchMemories(query: string, limit: number, options: MemorySearchOptions = {}): MemoryRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ValidationError("memory search limit must be a positive integer");
    }
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 2)) {
      throw new ValidationError("memory search byte limit must be at least two bytes");
    }

    const cappedLimit = Math.min(limit, 100);
    const now = options.now ?? Date.now();
    const scoped = options.userId !== undefined;
    const clauses = ["(expires_at IS NULL OR expires_at > ?)"];
    const parameters: Array<string | number | null> = [now];
    if (scoped) {
      clauses.push("user_id = ?");
      parameters.push(options.userId!);
      if (options.scope === "user") {
        clauses.push("scope = 'user'");
      } else if (options.scope === "task") {
        if (options.taskId === undefined || options.taskId === null) {
          throw new ValidationError("task-scoped memory search requires a task id");
        }
        clauses.push("scope = 'task' AND task_id = ?");
        parameters.push(options.taskId);
      } else {
        clauses.push("(scope = 'user' OR (scope = 'task' AND task_id = ?))");
        parameters.push(options.taskId ?? null);
      }
    }
    const rows = this.database
      .query(`SELECT * FROM memories WHERE ${clauses.join(" AND ")}`)
      .all(...parameters) as Row[];
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    const tokens = normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const ranked = rows
      .map((row) => {
        const record = memoryFromRow(row);
        const content = record.content.toLocaleLowerCase("en-US");
        const tags = (record.tags ?? []).map((tag) => tag.toLocaleLowerCase("en-US"));
        let score = normalizedQuery.length === 0 ? 0 : content.includes(normalizedQuery) ? 1 : 0;
        for (const token of tokens) {
          if (tags.some((tag) => tag === token)) score += 10;
          if (content.split(/[^\p{L}\p{N}_-]+/u).includes(token)) score += 4;
        }
        return { record, score };
      })
      .filter(({ score }) => normalizedQuery.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || (right.record.updatedAt ?? 0) - (left.record.updatedAt ?? 0) || left.record.id.localeCompare(right.record.id));

    const result: MemoryRecord[] = [];
    const maxBytes = options.maxBytes;
    for (const { record } of ranked) {
      if (result.length >= cappedLimit) break;
      const candidate = [...result, record];
      if (maxBytes !== undefined && Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) break;
      result.push(record);
    }
    return result;
  }

  createSchedule(input: ScheduleRecord): void {
    const hasClaimedBy = input.claimedBy !== null && input.claimedBy !== undefined;
    const hasClaimedAt = input.claimedAt !== null && input.claimedAt !== undefined;
    const hasLeaseToken = input.leaseToken !== null && input.leaseToken !== undefined;
    const hasLeaseUntil = input.leaseUntil !== null && input.leaseUntil !== undefined;
    if (hasClaimedBy !== hasClaimedAt || hasClaimedBy !== hasLeaseToken || hasClaimedBy !== hasLeaseUntil) {
      throw new PersistenceError("schedule claimed_by, claimed_at, and lease_token must be all set or all null");
    }
    immediateTransaction(this.database, () => {
      this.database
        .query(
          `INSERT INTO schedules
            (id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, lease_token, last_error, created_at,
             name, workspace, rrule, interval_ms, time_zone, lease_until, attempts, last_run_at, pending_run_id, pending_approval_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.leaseToken ?? null,
          input.lastError ?? null,
          input.createdAt ?? Date.now(),
          input.name ?? input.id,
          input.workspace ?? "",
          input.rrule ?? null,
          input.intervalMs ?? null,
          input.timeZone ?? "UTC",
          input.leaseUntil ?? null,
          input.attempts ?? 0,
          input.lastRunAt ?? null,
          input.pendingRunId ?? null,
          input.pendingApprovalId ?? null,
        );
    });
  }

  claimDueSchedule(now: number, owner: string): ScheduleRecord | null {
    return immediateTransaction(this.database, () => {
      const row = this.database
        .query(
          `SELECT id FROM schedules
           WHERE enabled = 1 AND next_run_at <= ?
             AND (
               (claimed_by IS NULL AND claimed_at IS NULL AND lease_token IS NULL)
               OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_token IS NOT NULL
                   AND (lease_until IS NULL OR lease_until <= ?))
             )
           ORDER BY next_run_at, id
           LIMIT 1`,
        )
        .get(now, now) as { id: string } | null;
      if (row === null) {
        return null;
      }

      const leaseToken = randomUUID();
      const updated = this.database
        .query(
          `UPDATE schedules
           SET claimed_by = ?, claimed_at = ?, lease_token = ?, lease_until = ?
           WHERE id = ? AND enabled = 1 AND next_run_at <= ?
             AND (
               (claimed_by IS NULL AND claimed_at IS NULL AND lease_token IS NULL)
               OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_token IS NOT NULL
                   AND (lease_until IS NULL OR lease_until <= ?))
             )`,
        )
        .run(owner, now, leaseToken, now + SCHEDULE_LEASE_TIMEOUT_MS, row.id, now, now);
      if (updated.changes !== 1) {
        return null;
      }

      return scheduleFromRow(this.database.query("SELECT * FROM schedules WHERE id = ?").get(row.id) as Row);
    });
  }

  renewScheduleLease(id: string, owner: string, leaseToken: string, now: number): boolean {
    return immediateTransaction(this.database, () => {
      const update = this.database
        .query(
          `UPDATE schedules
           SET claimed_at = ?, lease_until = ?
           WHERE id = ? AND claimed_by = ? AND lease_token = ?
             AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND lease_token IS NOT NULL
             AND (lease_until IS NULL OR lease_until > ?)`,
        )
        .run(now, now + SCHEDULE_LEASE_TIMEOUT_MS, id, owner, leaseToken, now);
      return update.changes === 1;
    });
  }

  hasScheduleLease(id: string, owner: string, leaseToken: string, now: number): boolean {
    return this.database.query(
      `SELECT 1 FROM schedules
       WHERE id = ? AND claimed_by = ? AND lease_token = ?
         AND claimed_at IS NOT NULL AND lease_until IS NOT NULL AND lease_until > ?`,
    ).get(id, owner, leaseToken, now) !== null;
  }

  finishSchedule(
    id: string,
    owner: string,
    leaseToken: string,
    nextRunAt: number | null,
    error: string | null,
  ): boolean {
    return immediateTransaction(this.database, () => {
      const update = this.database
        .query(
          `UPDATE schedules
           SET next_run_at = ?, last_error = ?, claimed_by = NULL, claimed_at = NULL, lease_token = NULL, lease_until = NULL,
               enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END
           WHERE id = ? AND claimed_by = ? AND claimed_at IS NOT NULL AND lease_token IS NOT NULL AND lease_token = ?`,
        )
        .run(nextRunAt, error, nextRunAt, id, owner, leaseToken);
      return update.changes === 1;
    });
  }

  listSchedules(): ScheduleRecord[] {
    return (this.database.query("SELECT * FROM schedules ORDER BY created_at, id").all() as Row[]).map(scheduleFromRow);
  }

  cancelSchedule(id: string): boolean {
    return immediateTransaction(this.database, () => {
      const update = this.database
        .query("UPDATE schedules SET enabled = 0, next_run_at = NULL, claimed_by = NULL, claimed_at = NULL, lease_token = NULL, lease_until = NULL WHERE id = ?")
        .run(id);
      return update.changes === 1;
    });
  }

  releaseScheduleLease(id: string, owner: string, leaseToken: string): boolean {
    return immediateTransaction(this.database, () => {
      const update = this.database
        .query(
          `UPDATE schedules SET claimed_by = NULL, claimed_at = NULL, lease_token = NULL, lease_until = NULL
           WHERE id = ? AND claimed_by = ? AND lease_token = ?`,
        )
        .run(id, owner, leaseToken);
      return update.changes === 1;
    });
  }

  finishScheduleRun(input: {
    id: string;
    owner: string;
    leaseToken: string;
    taskId?: string | null;
    nextRunAt: number | null;
    error: string | null;
    enabled: boolean;
    attempts: number;
    lastRunAt: number;
    pendingRunId?: string | null;
    pendingApprovalId?: string | null;
    now?: number;
  }): boolean {
    return immediateTransaction(this.database, () => {
      const now = input.now ?? Date.now();
      const update = this.database
        .query(
          `UPDATE schedules
           SET task_id = COALESCE(?, task_id), next_run_at = ?, last_error = ?, enabled = ?, attempts = ?, last_run_at = ?,
               pending_run_id = ?, pending_approval_id = ?, claimed_by = NULL, claimed_at = NULL, lease_token = NULL, lease_until = NULL
           WHERE id = ? AND claimed_by = ? AND lease_token = ?`,
        )
        .run(
          input.taskId ?? null,
          input.nextRunAt,
          input.error,
          input.enabled ? 1 : 0,
          input.attempts,
          input.lastRunAt,
          input.pendingRunId ?? null,
          input.pendingApprovalId ?? null,
          input.id,
          input.owner,
          input.leaseToken,
        );
      return update.changes === 1;
    });
  }

  appendScheduleEvent(scheduleId: string, type: string, payload: unknown, taskId?: string | null, runId?: string | null): void {
    immediateTransaction(this.database, () => {
      this.database
        .query("INSERT INTO events (task_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(taskId ?? null, runId ?? null, type, json({ scheduleId, ...((payload !== null && typeof payload === "object") ? payload : { value: payload }) }), Date.now());
    });
  }

  getSchedule(id: string): ScheduleRecord | null {
    const row = this.database.query("SELECT * FROM schedules WHERE id = ?").get(id) as Row | null;
    return row === null ? null : scheduleFromRow(row);
  }
}

function canonicalArguments(value: string): string {
  try {
    return canonicalJson(parseJson(value));
  } catch (error) {
    throw new PersistenceError("persisted tool-call arguments are not valid JSON", { cause: error });
  }
}

export { StoreRepository as Repository };
