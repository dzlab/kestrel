import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceError, ValidationError } from "../src/errors";
import { openDatabase } from "../src/store/database";
import {
  historicalVersionOneChecksum,
  migrationChecksum,
  migrations,
  versionOneChecksum,
} from "../src/store/migrations";
import { SCHEDULE_LEASE_TIMEOUT_MS, StoreRepository } from "../src/store/repository";
import type { Message, ToolCall } from "../src/protocol/types";

function withDatabase<T>(callback: (path: string, open: () => Database) => T): T | Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-store-"));
  const path = join(directory, "kestrel.sqlite");
  const databases: Database[] = [];
  const open = () => {
    const database = openDatabase(path);
    databases.push(database);
    return database;
  };

  const cleanup = () => {
    for (const database of databases.reverse()) {
      try {
        database.close();
      } catch {
        // The test may have deliberately closed a connection before reopening it.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    const result = callback(path, open);
    if (result !== null && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function createRun(repository: StoreRepository) {
  const task = repository.createTask({
    title: "Store test",
    prompt: "Persist this task",
    workspace: "/tmp/workspace",
    maxSteps: 5,
  });

  return repository.startRun(task.id, `run-${task.id}`);
}

const historicalVersionOneSqlFrom0fed = `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (task_id, idempotency_key)
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, sequence_number)
      );

      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        confidence REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        prompt TEXT NOT NULL,
        cron TEXT,
        next_run_at INTEGER,
        enabled INTEGER NOT NULL,
        claimed_by TEXT,
        claimed_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE approvals (
        call_id TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        capability TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        decision TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (call_id, arguments_hash)
      );
    `;

const historicalVersionOneSqlFrom0084a0f = `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (task_id, idempotency_key)
      );

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, sequence_number)
      );

      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        confidence REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        prompt TEXT NOT NULL,
        cron TEXT,
        next_run_at INTEGER,
        enabled INTEGER NOT NULL,
        claimed_by TEXT,
        claimed_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE approvals (
        call_id TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        capability TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        decision TEXT NOT NULL,
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (call_id, arguments_hash)
      );

      CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls(call_id);
      CREATE INDEX idx_runs_task_id ON runs(task_id);
      CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence_number);
      CREATE INDEX idx_events_task_created ON events(task_id, created_at);
      CREATE INDEX idx_events_run_created ON events(run_id, created_at);
      CREATE INDEX idx_memories_created ON memories(created_at);
      CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at, claimed_by);
      CREATE INDEX idx_approvals_call_hash ON approvals(call_id, arguments_hash);
    `;

function createHistoricalDatabase(
  path: string,
  sql: string,
  checksum: string | null,
  seed: (database: Database) => void,
): void {
  const database = new Database(path);
  database.exec(sql);
  if (checksum === null) {
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    database.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, 1_700_000_000_000);
  } else {
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    database
      .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run(1, checksum, 1_700_000_000_000);
  }
  seed(database);
  database.close();
}

function createVersionTwoDatabase(
  path: string,
  seed: (database: Database) => void,
  historicalSql = historicalVersionOneSqlFrom0fed,
): void {
  createHistoricalDatabase(path, historicalSql, null, () => {});
  const database = new Database(path);
  database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
  database.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(versionOneChecksum);
  database.exec(migrations[1].sql);
  database
    .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
    .run(2, migrationChecksum(migrations[1].sql), Date.now());
  seed(database);
  database.close();
}

function expectCurrentSchema(database: Database): void {
  expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual(
    expect.arrayContaining([
      { name: "approvals" },
      { name: "events" },
      { name: "memories" },
      { name: "messages" },
      { name: "runs" },
      { name: "schedules" },
      { name: "schema_migrations" },
      { name: "tasks" },
      { name: "tool_calls" },
    ]),
  );
  expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all()).toEqual(
    expect.arrayContaining([
      { name: "idx_approvals_call_hash" },
      { name: "idx_events_run_created" },
      { name: "idx_events_task_created" },
      { name: "idx_memories_created" },
      { name: "idx_messages_run_sequence" },
      { name: "idx_runs_task_id" },
      { name: "idx_schedules_due" },
      { name: "idx_tool_calls_call_id" },
    ]),
  );
}

test("createTask persists the task and its initial created event", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);

    const task = repository.createTask({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      maxSteps: 10,
    });

    expect(database.query("SELECT title, prompt, workspace, max_steps FROM tasks WHERE id = ?").get(task.id)).toEqual({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      max_steps: 10,
    });
    const createdEvent = database
      .query("SELECT type, payload FROM events WHERE run_id IS NULL AND task_id = ?")
      .get(task.id) as { type: string; payload: string };
    expect(createdEvent.type).toBe("created");
    expect(JSON.parse(createdEvent.payload)).toMatchObject({
      title: "Write a report",
      prompt: "Create a report",
      workspace: "/tmp/workspace",
      maxSteps: 10,
    });

  });
});

test("version one checksum is derived from the immutable original SQL", () => {
  expect(versionOneChecksum).toBe(migrationChecksum(migrations[0].sql));
  expect(versionOneChecksum).toBe("5e89d34102619e0385648171289134a0eff1fc383e37c24d6f3298183a2710e0");
  expect(historicalVersionOneChecksum).toBe(migrationChecksum(historicalVersionOneSqlFrom0084a0f));
});

test("fresh databases contain every required table and index", () => {
  withDatabase((_path, open) => {
    const database = open();
    expectCurrentSchema(database);
  });
});

test("foreign keys reject records that reference missing parents", () => {
  withDatabase((_path, open) => {
    const database = open();
    expect(() =>
      database
        .query(
          `INSERT INTO runs (id, task_id, idempotency_key, status, started_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("orphan-run", "missing-task", "key", "running", 1),
    ).toThrow();
  });
});

test("store keeps integer columns and structured values in JSON text", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const task = repository.createTask({
      title: "Typed values",
      prompt: "Persist types",
      workspace: "/tmp/workspace",
      maxSteps: 7,
    });
    repository.saveMemory({ id: "memory-1", kind: "fact", content: "SQLite", metadata: { source: "test" } });

    expect(database.query("SELECT typeof(max_steps) AS type FROM tasks WHERE id = ?").get(task.id)).toEqual({
      type: "integer",
    });
    expect(database.query("SELECT typeof(metadata) AS type, metadata FROM memories WHERE id = ?").get("memory-1")).toEqual({
      type: "text",
      metadata: '{"source":"test"}',
    });
  });
});

test("events are appended in order without overwriting prior audit records", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const task = repository.createTask({
      title: "Audit trail",
      prompt: "Keep history",
      workspace: "/tmp/workspace",
      maxSteps: 1,
    });
    const run = repository.startRun(task.id, "event-key");

    repository.appendEvent(run.id, "started", { step: 1 });
    repository.appendEvent(run.id, "finished", { step: 2 });

    expect(
      database.query("SELECT type, payload FROM events WHERE run_id = ? ORDER BY id").all(run.id),
    ).toEqual([
      { type: "started", payload: '{"step":1}' },
      { type: "finished", payload: '{"step":2}' },
    ]);
  });
});

test("memory search caps an oversized limit at one hundred rows", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    for (let index = 0; index < 105; index += 1) {
      repository.saveMemory({ id: `memory-${index}`, kind: "fact", content: "bounded", metadata: {} });
    }

    expect(repository.searchMemories("bounded", 1_000)).toHaveLength(100);
  });
});

test("appendMessage preserves insertion order for a run", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const messages: Message[] = [
      { role: "user", content: "First" },
      { role: "assistant", content: "Second" },
      { role: "tool", content: "Third", toolCallId: "call-1" },
    ];

    for (const message of messages) {
      repository.appendMessage(run.id, message);
    }

    const rows = database
      .query("SELECT payload FROM messages WHERE run_id = ? ORDER BY sequence_number")
      .all(run.id) as Array<{ payload: string }>;
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual(messages);

  });
});

test("recordToolCall is idempotent by call ID", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "call-1", name: "fs.read", arguments: { path: "README.md" } };

    expect(repository.recordToolCall(run.id, call, "pending")).toBe(true);
    expect(repository.recordToolCall(run.id, call, "running")).toBe(false);
    expect(database.query("SELECT COUNT(*) AS count FROM tool_calls WHERE call_id = ?").get("call-1")).toEqual({
      count: 1,
    });

  });
});

test("recordToolCall treats object-key order as an identical replay", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    const run = createRun(repository);

    expect(repository.recordToolCall(run.id, { id: "ordered-call", name: "fs.read", arguments: { a: 1, b: 2 } }, "pending")).toBe(true);
    expect(repository.recordToolCall(run.id, { id: "ordered-call", name: "fs.read", arguments: { b: 2, a: 1 } }, "running")).toBe(false);
  });
});

test("recordToolCall rejects the same ID for a different run", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const firstRun = createRun(repository);
    const secondRun = createRun(repository);
    const call: ToolCall = { id: "shared-call", name: "fs.read", arguments: { path: "README.md" } };

    repository.recordToolCall(firstRun.id, call, "pending");

    expect(() => repository.recordToolCall(secondRun.id, call, "pending")).toThrow(PersistenceError);
  });
});

test("recordToolCall rejects the same ID for different canonical arguments", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const firstCall: ToolCall = { id: "argument-call", name: "fs.read", arguments: { path: "README.md" } };
    const conflictingCall: ToolCall = { id: "argument-call", name: "fs.read", arguments: { path: "secrets.txt" } };

    repository.recordToolCall(run.id, firstCall, "pending");

    expect(() => repository.recordToolCall(run.id, conflictingCall, "pending")).toThrow(PersistenceError);
  });
});

test("pending approvals survive reopening the database", () => {
  withDatabase((_path, open) => {
    const firstDatabase = open();
    const firstRepository = new StoreRepository(firstDatabase);
    const run = createRun(firstRepository);
    const approval = {
      callId: "call-approval",
      argumentsHash: "hash-1",
      capability: "shell.exec",
      riskLevel: "high",
      taskId: run.taskId,
      runId: run.id,
      decision: "pending",
      requestedAt: 1_700_000_000_000,
    } as const;

    firstRepository.saveApproval(approval);
    firstDatabase.close();

    const secondDatabase = open();
    const secondRepository = new StoreRepository(secondDatabase);
    expect(secondRepository.getApproval("call-approval", "hash-1")).toMatchObject(approval);
  });
});

test("claimDueSchedule returns a due job only once", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({
      id: "schedule-1",
      taskId: null,
      prompt: "Run the scheduled task",
      cron: null,
      nextRunAt: 1_000,
      enabled: true,
    });

    const claim = repository.claimDueSchedule(1_000, "worker-a");
    expect(claim).toMatchObject({ id: "schedule-1", claimedBy: "worker-a", claimedAt: 1_000 });
    expect(claim?.leaseToken).toEqual(expect.any(String));
    expect(repository.claimDueSchedule(1_000, "worker-b")).toBeNull();
  });
});

test("claimDueSchedule reclaims a stale lease with a new fencing token", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({ id: "recoverable-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    const firstClaim = repository.claimDueSchedule(1_000, "owner-a");
    const secondClaim = repository.claimDueSchedule(1_000 + SCHEDULE_LEASE_TIMEOUT_MS + 1, "owner-b");

    expect(firstClaim?.leaseToken).toEqual(expect.any(String));
    expect(secondClaim).toMatchObject({ id: "recoverable-schedule", claimedBy: "owner-b" });
    expect(secondClaim?.leaseToken).toEqual(expect.any(String));
    expect(secondClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);
    expect(repository.getSchedule("recoverable-schedule")?.leaseToken).toBe(secondClaim?.leaseToken);
  });
});

test("renewScheduleLease extends a live long-running lease", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    repository.createSchedule({ id: "renewable-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    const claim = repository.claimDueSchedule(1_000, "owner-a")!;
    const renewedAt = 1_000 + SCHEDULE_LEASE_TIMEOUT_MS - 1;

    expect(repository.renewScheduleLease("renewable-schedule", "owner-a", claim.leaseToken!, renewedAt)).toBe(true);
    expect(repository.getSchedule("renewable-schedule")).toMatchObject({
      claimedBy: "owner-a",
      claimedAt: renewedAt,
      leaseToken: claim.leaseToken,
    });
    expect(repository.claimDueSchedule(renewedAt + SCHEDULE_LEASE_TIMEOUT_MS - 1, "owner-b")).toBeNull();
  });
});

test("renewScheduleLease rejects a wrong owner or token without changing the lease", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    repository.createSchedule({ id: "protected-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    const claim = repository.claimDueSchedule(1_000, "owner-a")!;

    expect(repository.renewScheduleLease("protected-schedule", "owner-b", claim.leaseToken!, 2_000)).toBe(false);
    expect(repository.renewScheduleLease("protected-schedule", "owner-a", "wrong-token", 2_000)).toBe(false);
    expect(repository.getSchedule("protected-schedule")?.claimedAt).toBe(1_000);
  });
});

test("renewScheduleLease rejects a lease after it has been reclaimed", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    repository.createSchedule({ id: "reclaimed-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    const firstClaim = repository.claimDueSchedule(1_000, "owner-a")!;
    const secondClaim = repository.claimDueSchedule(1_000 + SCHEDULE_LEASE_TIMEOUT_MS + 1, "owner-b")!;

    expect(repository.renewScheduleLease("reclaimed-schedule", "owner-a", firstClaim.leaseToken!, 1_000 + SCHEDULE_LEASE_TIMEOUT_MS + 2)).toBe(
      false,
    );
    expect(repository.getSchedule("reclaimed-schedule")).toMatchObject({
      claimedBy: "owner-b",
      claimedAt: 1_000 + SCHEDULE_LEASE_TIMEOUT_MS + 1,
      leaseToken: secondClaim.leaseToken,
    });
  });
});

test("createSchedule rejects an owned schedule without a lease token", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());

    expect(() =>
      repository.createSchedule({
        id: "malformed-input-schedule",
        prompt: "Run once",
        nextRunAt: 1_000,
        enabled: true,
        claimedBy: "owner-a",
        claimedAt: 1_000,
        leaseToken: null,
      }),
    ).toThrow(PersistenceError);
  });
});

test("claimDueSchedule does not reclaim a malformed lease row", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({ id: "malformed-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    database.exec("PRAGMA ignore_check_constraints = ON");
    database.query("UPDATE schedules SET claimed_by = ?, claimed_at = NULL WHERE id = ?").run("dead-worker", "malformed-schedule");

    expect(repository.claimDueSchedule(1_000, "owner-b")).toBeNull();
  });
});

test("finishSchedule rejects a lease with a missing claim timestamp", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({ id: "malformed-finish-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });
    const claim = repository.claimDueSchedule(1_000, "owner-a")!;

    database.exec("PRAGMA ignore_check_constraints = ON");
    database.query("UPDATE schedules SET claimed_at = NULL WHERE id = ?").run("malformed-finish-schedule");

    expect(repository.finishSchedule("malformed-finish-schedule", "owner-a", claim.leaseToken!, null, null)).toBe(false);
  });
});

test("startRun reuses an existing run for the same idempotency key", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const task = repository.createTask({
      title: "Idempotent run",
      prompt: "Run once",
      workspace: "/tmp/workspace",
      maxSteps: 1,
    });

    const first = repository.startRun(task.id, "same-key");
    const second = repository.startRun(task.id, "same-key");

    expect(second).toEqual(first);
  });
});

test("finishToolCall rejects an unknown call", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);

    expect(() => repository.finishToolCall(run.id, "missing-call", { ok: true }, "completed")).toThrow(
      PersistenceError,
    );
  });
});

test("finishToolCall persists the result, state, and completion time", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "call-finished", name: "fs.read", arguments: { path: "README.md" } };

    repository.recordToolCall(run.id, call, "running");
    repository.finishToolCall(run.id, call.id, { ok: true }, "completed");

    expect(database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id)).toEqual({
      result: '{"ok":true}',
      state: "completed",
      finished_at: expect.any(Number),
    });
  });
});

test("finishToolCall treats an identical completion as an idempotent success", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "idempotent-finish", name: "fs.read", arguments: { path: "README.md" } };

    repository.recordToolCall(run.id, call, "running");
    repository.finishToolCall(run.id, call.id, { ok: true }, "completed");
    const firstCompletion = database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id);

    repository.finishToolCall(run.id, call.id, { ok: true }, "completed");

    expect(database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id)).toEqual(
      firstCompletion,
    );
  });
});

test("finishToolCall rejects a conflicting result without mutating the completion", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "conflicting-finish", name: "fs.read", arguments: { path: "README.md" } };

    repository.recordToolCall(run.id, call, "running");
    repository.finishToolCall(run.id, call.id, { ok: true }, "completed");
    const firstCompletion = database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id);

    expect(() => repository.finishToolCall(run.id, call.id, { ok: false }, "completed")).toThrow(PersistenceError);
    expect(database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id)).toEqual(
      firstCompletion,
    );
  });
});

test("finishToolCall rejects a conflicting state without mutating the completion", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const run = createRun(repository);
    const call: ToolCall = { id: "conflicting-state-finish", name: "fs.read", arguments: { path: "README.md" } };

    repository.recordToolCall(run.id, call, "running");
    repository.finishToolCall(run.id, call.id, { ok: true }, "completed");
    const firstCompletion = database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id);

    expect(() => repository.finishToolCall(run.id, call.id, { ok: true }, "failed")).toThrow(PersistenceError);
    expect(database.query("SELECT result, state, finished_at FROM tool_calls WHERE call_id = ?").get(call.id)).toEqual(
      firstCompletion,
    );
  });
});

test("searchMemories rejects non-positive limits", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);

    expect(() => repository.searchMemories("anything", 0)).toThrow(ValidationError);
    expect(() => repository.searchMemories("anything", -1)).toThrow(ValidationError);
  });
});

test("finishSchedule requires the current lease owner", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({
      id: "leased-schedule",
      prompt: "Run once",
      nextRunAt: 1_000,
      enabled: true,
    });
    const claim = repository.claimDueSchedule(1_000, "owner-a");

    expect(repository.finishSchedule("leased-schedule", "owner-b", "wrong-token", null, null)).toBe(false);
    expect(repository.finishSchedule("leased-schedule", "owner-a", claim!.leaseToken!, null, null)).toBe(true);
  });
});

test("finishSchedule rejects a late completion from a reclaimed lease", () => {
  withDatabase((_path, open) => {
    const repository = new StoreRepository(open());
    repository.createSchedule({ id: "fenced-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });

    const firstClaim = repository.claimDueSchedule(1_000, "owner-a")!;
    const secondClaim = repository.claimDueSchedule(1_000 + SCHEDULE_LEASE_TIMEOUT_MS + 1, "owner-b")!;

    expect(repository.finishSchedule("fenced-schedule", "owner-a", firstClaim.leaseToken!, null, null)).toBe(false);
    expect(repository.finishSchedule("fenced-schedule", "owner-b", secondClaim.leaseToken!, null, null)).toBe(true);
  });
});

test("two database connections elect one schedule claimant", async () => {
  await withDatabase(async (_path, open) => {
    const first = new StoreRepository(open());
    const second = new StoreRepository(open());
    first.createSchedule({
      id: "contended-schedule",
      prompt: "Run once",
      nextRunAt: 1_000,
      enabled: true,
    });

    const claims = await Promise.all([
      Promise.resolve().then(() => first.claimDueSchedule(1_000, "owner-a")),
      Promise.resolve().then(() => second.claimDueSchedule(1_000, "owner-b")),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });
});

test("migration rejects an unknown future version", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database
      .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run(999, "future", Date.now());
    database.close();

    expect(() => openDatabase(path)).toThrow(/future migration|unknown migration/i);
  });
});

test("migration rejects a checksum mismatch", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered");
    database.close();

    expect(() => openDatabase(path)).toThrow(/checksum/i);
  });
});

test("migration rejects a schema ledger without its primary key", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_original");
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    database.exec(
      "INSERT INTO schema_migrations (version, checksum, applied_at) SELECT version, checksum, applied_at FROM schema_migrations_original",
    );
    database.exec("DROP TABLE schema_migrations_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/primary key|schema_migrations/i);
  });
});

test("migration rejects duplicate schema ledger versions explicitly", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_original");
    database.exec("CREATE TABLE schema_migrations (version INTEGER, checksum TEXT, applied_at INTEGER)");
    database.exec(
      "INSERT INTO schema_migrations (version, checksum, applied_at) SELECT version, checksum, applied_at FROM schema_migrations_original",
    );
    database.exec(
      "INSERT INTO schema_migrations (version, checksum, applied_at) SELECT version, checksum, applied_at FROM schema_migrations_original WHERE version = 1",
    );
    database.exec("DROP TABLE schema_migrations_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/duplicate.*version|schema_migrations/i);
  });
});

test("migration rejects nullable schema ledger checksum and applied timestamp", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_original");
    database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT, applied_at INTEGER)");
    database.exec(
      "INSERT INTO schema_migrations (version, checksum, applied_at) SELECT version, checksum, applied_at FROM schema_migrations_original",
    );
    database.exec("DROP TABLE schema_migrations_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/not null|schema_migrations/i);
  });
});

test("migration rejects missing required tables and indexes", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP INDEX idx_schedules_due");
    database.exec("DROP TABLE memories");
    database.close();

    expect(() => openDatabase(path)).toThrow(/required (table|index)/i);
  });
});

test("migration rejects an altered required index", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP INDEX idx_schedules_due");
    database.exec("CREATE INDEX idx_schedules_due ON schedules(id)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/required index/i);
  });
});

test("migration rejects a partial unique tool-call index", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP INDEX idx_tool_calls_call_id");
    database.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls(call_id) WHERE state = 'completed'");
    database.close();

    expect(() => openDatabase(path)).toThrow(/required index/i);
  });
});

test("migration rejects redundant tool-call uniqueness constraints", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id_duplicate ON tool_calls(call_id)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/unique|tool.?call|index/i);
  });
});

test("migration rejects existing foreign-key violations", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .query(
        `INSERT INTO runs (id, task_id, idempotency_key, status, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("orphan-run", "missing-task", "orphan-key", "running", 1);
    database.close();

    expect(() => openDatabase(path)).toThrow(/foreign key|integrity|constraint/i);
  });
});

test("migration rejects a same-name table with an altered declared type", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE tasks RENAME TO tasks_original");
    database.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        max_steps TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    database.exec("DROP TABLE tasks_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/declared type|schema|tasks/i);
  });
});

test("migration rejects a required table with a missing primary key", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE tool_calls RENAME TO tool_calls_original");
    database.exec(`
      CREATE TABLE tool_calls (
        id INTEGER,
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `);
    database.exec("DROP TABLE tool_calls_original");
    database.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls(call_id)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/primary key|tool.?calls|schema/i);
  });
});

test("migration rejects a required NOT NULL column made nullable", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE tool_calls RENAME TO tool_calls_original");
    database.exec(`
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `);
    database.exec("DROP TABLE tool_calls_original");
    database.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls(call_id)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/not null|tool.?calls|schema/i);
  });
});

test("migration rejects a same-name table with a missing foreign key", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE runs RENAME TO runs_original");
    database.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (task_id, idempotency_key)
      )
    `);
    database.exec("DROP TABLE runs_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/foreign key|relationship|runs/i);
  });
});

test("migration rejects a messages table missing its composite uniqueness constraint", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_messages_run_sequence");
    database.exec("ALTER TABLE messages RENAME TO messages_original");
    database.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec("DROP TABLE messages_original");
    database.exec("CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence_number)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/unique|messages|schema/i);
  });
});

test("migration rejects a runs table with an altered composite uniqueness constraint", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE runs RENAME TO runs_original");
    database.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (task_id, started_at)
      )
    `);
    database.exec("DROP TABLE runs_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/unique|runs|schema/i);
  });
});

test("migration rejects a schedule table with a tautological enabled CHECK", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_schedules_due");
    database.exec("ALTER TABLE schedules RENAME TO schedules_original");
    database.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        prompt TEXT NOT NULL,
        cron TEXT,
        next_run_at INTEGER,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1) OR 1 = 1),
        claimed_by TEXT,
        claimed_at INTEGER,
        lease_token TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec("DROP TABLE schedules_original");
    database.exec("CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at, claimed_by)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/constraint|schedule|schema/i);
  });
});

test("migration rejects an approval table with an altered decision CHECK", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_approvals_call_hash");
    database.exec("ALTER TABLE approvals RENAME TO approvals_original");
    database.exec(`
      CREATE TABLE approvals (
        call_id TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        capability TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'denied') OR 1 = 1),
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (call_id, arguments_hash)
      )
    `);
    database.exec("DROP TABLE approvals_original");
    database.exec("CREATE INDEX idx_approvals_call_hash ON approvals(call_id, arguments_hash)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/constraint|approval|schema/i);
  });
});

test("migration rejects a persisted half-populated schedule lease", () => {
  withDatabase((path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    repository.createSchedule({ id: "malformed-migration-schedule", prompt: "Run once", nextRunAt: 1_000, enabled: true });
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .query("UPDATE schedules SET claimed_by = ?, claimed_at = ?, lease_token = NULL WHERE id = ?")
      .run("dead-worker", 1_000, "malformed-migration-schedule");
    database.close();

    expect(() => openDatabase(path)).toThrow(/lease|claim|schedule|schema/i);
  });
});

test("migration rejects a messages table without AUTOINCREMENT", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_messages_run_sequence");
    database.exec("ALTER TABLE messages RENAME TO messages_original");
    database.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, sequence_number)
      )
    `);
    database.exec("INSERT INTO messages SELECT * FROM messages_original");
    database.exec("DROP TABLE messages_original");
    database.exec("CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence_number)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/messages|schema|autoincrement/i);
  });
});

test("migration rejects an events table with an altered default", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_events_task_created");
    database.exec("DROP INDEX idx_events_run_created");
    database.exec("ALTER TABLE events RENAME TO events_original");
    database.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0
      )
    `);
    database.exec("INSERT INTO events SELECT * FROM events_original");
    database.exec("DROP TABLE events_original");
    database.exec("CREATE INDEX idx_events_task_created ON events(task_id, created_at)");
    database.exec("CREATE INDEX idx_events_run_created ON events(run_id, created_at)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/events|schema|default/i);
  });
});

test("migration rejects a tool_calls table without AUTOINCREMENT", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_tool_calls_call_id");
    database.exec("ALTER TABLE tool_calls RENAME TO tool_calls_original");
    database.exec(`
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        state TEXT NOT NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      )
    `);
    database.exec("INSERT INTO tool_calls SELECT * FROM tool_calls_original");
    database.exec("DROP TABLE tool_calls_original");
    database.exec("CREATE UNIQUE INDEX idx_tool_calls_call_id ON tool_calls(call_id)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/tool.?calls|schema|autoincrement/i);
  });
});

test("migration rejects a memories table with an altered default", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_memories_created");
    database.exec("ALTER TABLE memories RENAME TO memories_original");
    database.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        confidence REAL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    database.exec("INSERT INTO memories SELECT * FROM memories_original");
    database.exec("DROP TABLE memories_original");
    database.exec("CREATE INDEX idx_memories_created ON memories(created_at)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/memories|schema|default/i);
  });
});

test("migration rejects a schema ledger with an altered default", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_original");
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL DEFAULT 'tampered'
      )
    `);
    database.exec("INSERT INTO schema_migrations SELECT * FROM schema_migrations_original");
    database.exec("DROP TABLE schema_migrations_original");
    database.close();

    expect(() => openDatabase(path)).toThrow(/schema_migrations|schema|default/i);
  });
});

test("migration rejects altered foreign-key actions", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("DROP INDEX idx_events_task_created");
    database.exec("DROP INDEX idx_events_run_created");
    database.exec("ALTER TABLE events RENAME TO events_original");
    database.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    database.exec("DROP TABLE events_original");
    database.exec("CREATE INDEX idx_events_task_created ON events(task_id, created_at)");
    database.exec("CREATE INDEX idx_events_run_created ON events(run_id, created_at)");
    database.close();

    expect(() => openDatabase(path)).toThrow(/foreign key|events|schema/i);
  });
});

test("migration rejects a missing status guard", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP TRIGGER tasks_status_update_guard");
    database.close();

    expect(() => openDatabase(path)).toThrow(/trigger|status/i);
  });
});

test("migration rejects a same-name status guard with altered behavior", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP TRIGGER tasks_status_update_guard");
    database.exec(`
      CREATE TRIGGER tasks_status_update_guard
      BEFORE UPDATE OF status ON tasks
      WHEN 1 = 0
      BEGIN SELECT RAISE(ABORT, 'invalid task status'); END
    `);
    database.close();

    expect(() => openDatabase(path)).toThrow(/trigger|status/i);
  });
});

test("migration rejects a historical status expression with altered behavior", () => {
  withDatabase((path) => {
    const alteredHistoricalSql = historicalVersionOneSqlFrom0084a0f.replace(
      "status IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')",
      "status IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted') OR 1 = 1",
    );
    createHistoricalDatabase(path, alteredHistoricalSql, historicalVersionOneChecksum, () => {});

    expect(() => openDatabase(path)).toThrow(/lineage|schema|status|checksum/i);
  });
});

test("migration rejects a legacy schema without the inline tool-call uniqueness", () => {
  withDatabase((path) => {
    const alteredLegacySql = historicalVersionOneSqlFrom0fed.replace(
      "call_id TEXT NOT NULL UNIQUE",
      "call_id TEXT NOT NULL",
    );
    createHistoricalDatabase(path, alteredLegacySql, null, () => {});

    expect(() => openDatabase(path)).toThrow(/lineage|tool.?calls|unique|schema/i);
  });
});

test("version-three migration rejects an altered legacy schedule default before rebuilding it", () => {
  withDatabase((path) => {
    const alteredLegacySql = historicalVersionOneSqlFrom0fed.replace(
      "last_error TEXT,\n        created_at INTEGER NOT NULL",
      "last_error TEXT,\n        created_at INTEGER NOT NULL DEFAULT 0",
    );
    createVersionTwoDatabase(path, () => {}, alteredLegacySql);

    expect(() => openDatabase(path)).toThrow(/lineage|schedule|default|schema/i);
  });
});

test("version-three migration rejects an altered legacy approval CHECK before rebuilding it", () => {
  withDatabase((path) => {
    const alteredLegacySql = historicalVersionOneSqlFrom0fed.replace(
      "decision TEXT NOT NULL,\n        requested_at INTEGER NOT NULL",
      "decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'denied')),\n        requested_at INTEGER NOT NULL",
    );
    createVersionTwoDatabase(path, () => {}, alteredLegacySql);

    expect(() => openDatabase(path)).toThrow(/lineage|approval|constraint|schema/i);
  });
});

test("version-four migration rejects an altered current schedule definition before rebuilding it", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.exec("DROP INDEX idx_schedules_due");
    database.exec("ALTER TABLE schedules RENAME TO schedules_original");
    database.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id),
        prompt TEXT NOT NULL,
        cron TEXT,
        next_run_at INTEGER,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        claimed_by TEXT,
        claimed_at INTEGER,
        lease_token TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
      )
    `);
    database.exec("INSERT INTO schedules SELECT * FROM schedules_original");
    database.exec("DROP TABLE schedules_original");
    database.exec("CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at, claimed_by)");
    database.query("DELETE FROM schema_migrations WHERE version IN (4, 5)").run();
    database.close();

    expect(() => openDatabase(path)).toThrow(/schedule|default|schema/i);
  });
});

test("migration rejects a current schema carrying the historical v1 checksum", () => {
  withDatabase((path, open) => {
    open().close();
    const database = new Database(path);
    database.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(historicalVersionOneChecksum);
    database.close();

    expect(() => openDatabase(path)).toThrow(/lineage|schema|checksum/i);
  });
});

test("migration rejects a historical schema carrying the current v1 checksum", () => {
  withDatabase((path, open) => {
    createHistoricalDatabase(path, historicalVersionOneSqlFrom0084a0f, versionOneChecksum, () => {});

    expect(() => openDatabase(path)).toThrow(/lineage|schema|checksum/i);
  });
});

test("fresh databases apply the complete migration history", () => {
  withDatabase((_path, open) => {
    const database = open();
    const versions = database
      .query("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; checksum: string }>;

    expect(versions).toEqual([
      { version: 1, checksum: "5e89d34102619e0385648171289134a0eff1fc383e37c24d6f3298183a2710e0" },
      { version: 2, checksum: "28020c0d96b13e8f0ac0394c299c19dc53d9c531a38dbb1187a544c9932ba47c" },
      { version: 3, checksum: migrationChecksum(migrations[2].sql) },
      { version: 4, checksum: migrationChecksum(migrations[3].sql) },
      { version: 5, checksum: migrationChecksum(migrations[4].sql) },
    ]);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()).toEqual({
      name: "approvals",
    });
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_schedules_due'").get()).toEqual({
      name: "idx_schedules_due",
    });
  });
});

test("fresh databases keep tool-call uniqueness in one explicit index", () => {
  withDatabase((_path, open) => {
    const database = open();
    const indexes = database.query("PRAGMA index_list('tool_calls')").all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const callIdUniqueIndexes = indexes.filter((index) => {
      if (Number(index.unique) !== 1 || Number(index.partial) !== 0) {
        return false;
      }
      const columns = database.query(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string; seqno: number }>;
      return columns.sort((left, right) => left.seqno - right.seqno).map((column) => column.name).join(",") === "call_id";
    });

    expect(callIdUniqueIndexes).toEqual([
      expect.objectContaining({ name: "idx_tool_calls_call_id", unique: 1, partial: 0 }),
    ]);
  });
});

test("legacy version-1 databases upgrade without losing data", () => {
  withDatabase((path, open) => {
    createHistoricalDatabase(path, historicalVersionOneSqlFrom0fed, null, (database) => {
      database
        .query(
          `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy-task", "Legacy", "Keep this task", "/tmp/workspace", 3, "pending", 1_700_000_000_000, 1_700_000_000_000);
    });

    const database = open();
    expect(database.query("SELECT title FROM tasks WHERE id = ?").get("legacy-task")).toEqual({ title: "Legacy" });
    expect(database.query("PRAGMA table_info('schema_migrations')").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "checksum" })]),
    );
    expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(database.query("SELECT version, checksum FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, checksum: "5e89d34102619e0385648171289134a0eff1fc383e37c24d6f3298183a2710e0" },
      { version: 2, checksum: "28020c0d96b13e8f0ac0394c299c19dc53d9c531a38dbb1187a544c9932ba47c" },
      { version: 3, checksum: migrationChecksum(migrations[2].sql) },
      { version: 4, checksum: migrationChecksum(migrations[3].sql) },
      { version: 5, checksum: migrationChecksum(migrations[4].sql) },
    ]);
    expectCurrentSchema(database);
  });
});

test("claimed legacy schedules upgrade with a new lease token", () => {
  withDatabase((path, open) => {
    createVersionTwoDatabase(path, (database) => {
      database
        .query(
          `INSERT INTO schedules
             (id, prompt, next_run_at, enabled, claimed_by, claimed_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy-claimed-schedule", "Run once", 1_000, 1, "legacy-owner", 1_234, 1_000);
    });

    const database = open();
    const schedule = new StoreRepository(database).getSchedule("legacy-claimed-schedule");

    expect(schedule).toMatchObject({
      id: "legacy-claimed-schedule",
      claimedBy: "legacy-owner",
      claimedAt: 1_234,
      leaseToken: expect.any(String),
    });
  });
});

test("hardened historical version-one databases upgrade without losing data", () => {
  withDatabase((path, open) => {
    createHistoricalDatabase(
      path,
      historicalVersionOneSqlFrom0084a0f,
      "3553adbe9019bbe2e3868ad43e4d74ed0834f1465ada668514046e570686d8aa",
      (database) => {
        database
          .query(
            `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("hardened-task", "Hardened", "Keep this task", "/tmp/workspace", 4, "pending", 1_700_000_000_000, 1_700_000_000_000);
      },
    );

    const database = open();
    expect(database.query("SELECT title FROM tasks WHERE id = ?").get("hardened-task")).toEqual({ title: "Hardened" });
    expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
    expect(database.query("SELECT version, checksum FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, checksum: "3553adbe9019bbe2e3868ad43e4d74ed0834f1465ada668514046e570686d8aa" },
      { version: 2, checksum: "28020c0d96b13e8f0ac0394c299c19dc53d9c531a38dbb1187a544c9932ba47c" },
      { version: 3, checksum: migrationChecksum(migrations[2].sql) },
      { version: 4, checksum: migrationChecksum(migrations[3].sql) },
      { version: 5, checksum: migrationChecksum(migrations[4].sql) },
    ]);
    expectCurrentSchema(database);
  });
});

test("version-three rebuild preserves store indexes, guards, and tool-call AUTOINCREMENT", () => {
  withDatabase((path, open) => {
    createVersionTwoDatabase(path, (database) => {
      database
        .query(
          `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("v3-task", "V3", "Preserve schema", "/tmp/workspace", 1, "pending", 1, 1);
      database
        .query("INSERT INTO runs (id, task_id, idempotency_key, status, started_at) VALUES (?, ?, ?, ?, ?)")
        .run("v3-run", "v3-task", "v3-key", "running", 1);
      database
        .query(
          `INSERT INTO tool_calls
             (id, run_id, call_id, name, arguments, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(41, "v3-run", "v3-call-old", "fs.read", "{}", "completed", 1);
      database.query("DELETE FROM tool_calls WHERE id = ?").run(41);
    });

    const database = open();
    expectCurrentSchema(database);
    expect(database.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({ count: 4 });

    const repository = new StoreRepository(database);
    expect(repository.recordToolCall("v3-run", { id: "v3-call-new", name: "fs.read", arguments: {} }, "pending")).toBe(true);
    expect(database.query("SELECT id FROM tool_calls WHERE call_id = ?").get("v3-call-new")).toEqual({ id: 42 });
  });
});

test("version-two databases with a legacy nullable checksum upgrade to the hardened ledger", () => {
  withDatabase((path, open) => {
    createHistoricalDatabase(path, historicalVersionOneSqlFrom0fed, null, () => {});
    const database = new Database(path);
    database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    database.query("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(versionOneChecksum);
    database.exec(migrations[1].sql);
    database
      .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
      .run(2, migrationChecksum(migrations[1].sql), Date.now());
    database.close();

    const upgraded = open();
    expect(upgraded.query("PRAGMA table_info('schema_migrations')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "checksum", notnull: 1 }),
        expect.objectContaining({ name: "applied_at", notnull: 1 }),
        expect.objectContaining({ name: "version", pk: 1 }),
      ]),
    );
    expect(upgraded.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
    ]);
  });
});

test("migration rolls back partial schema and closes after failure", () => {
  withDatabase((path) => {
    const database = new Database(path);
    database.exec("CREATE TABLE runs (id TEXT PRIMARY KEY)");
    database.close();

    expect(() => openDatabase(path)).toThrow();

    const reopened = new Database(path);
    expect(reopened.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get()).toBeNull();
    reopened.close();
  });
});

test("required persisted task and run statuses are checked by SQLite", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    const task = repository.createTask({
      title: "Status check",
      prompt: "Keep status valid",
      workspace: "/tmp/workspace",
      maxSteps: 1,
    });
    const run = repository.startRun(task.id, "status-key");

    expect(() => database.query("UPDATE tasks SET status = ? WHERE id = ?").run("unknown", task.id)).toThrow();
    expect(() => database.query("UPDATE runs SET status = ? WHERE id = ?").run("unknown", run.id)).toThrow();
  });
});

test("approval and schedule persisted domains are checked by SQLite", () => {
  withDatabase((_path, open) => {
    const database = open();
    expect(() =>
      database
        .query(
          `INSERT INTO approvals
             (call_id, arguments_hash, capability, risk_level, decision, requested_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("call-domain", "hash", "shell.exec", "high", "unknown", 1),
    ).toThrow();
    expect(() =>
      database
        .query(
          `INSERT INTO schedules (id, prompt, next_run_at, enabled, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("schedule-domain", "Run once", 1_000, 2, 1),
    ).toThrow();
    expect(() =>
      database
        .query(
          `INSERT INTO schedules
             (id, prompt, next_run_at, enabled, claimed_by, claimed_at, lease_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("schedule-lease-domain", "Run once", 1_000, 1, "owner-a", 1_000, null, 1),
    ).toThrow();
  });
});

test("decoding rejects tampered approval and schedule domains", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .query(
        `INSERT INTO approvals
           (call_id, arguments_hash, capability, risk_level, decision, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("tampered-approval", "hash", "shell.exec", "high", "unknown", 1);
    database
      .query(
        `INSERT INTO schedules (id, prompt, next_run_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("tampered-schedule", "Run once", 1_000, 2, 1);

    expect(() => repository.getApproval("tampered-approval", "hash")).toThrow(PersistenceError);
    expect(() => repository.getSchedule("tampered-schedule")).toThrow(PersistenceError);
  });
});

test("decoding rejects a claimed schedule with a missing lease token", () => {
  withDatabase((_path, open) => {
    const database = open();
    const repository = new StoreRepository(database);
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .query(
        `INSERT INTO schedules
           (id, prompt, next_run_at, enabled, claimed_by, claimed_at, lease_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("tampered-lease", "Run once", 1_000, 1, "owner-a", 1_000, null, 1);

    expect(() => repository.getSchedule("tampered-lease")).toThrow(PersistenceError);
  });
});

test("contended writes use bounded SQLITE_BUSY handling across database connections", () => {
  withDatabase((_path, open) => {
    const firstDatabase = open();
    const secondDatabase = open();
    const first = new StoreRepository(firstDatabase);
    const second = new StoreRepository(secondDatabase);
    const task = first.createTask({ title: "Contention", prompt: "Write", workspace: "/tmp/workspace", maxSteps: 1 });
    const run = first.startRun(task.id, "contention-run");

    firstDatabase.exec("BEGIN IMMEDIATE");
    secondDatabase.exec("PRAGMA busy_timeout = 0");
    expect(() => second.appendMessage(run.id, { role: "user", content: "blocked" })).toThrow(/busy|locked/i);
    firstDatabase.exec("ROLLBACK");

    second.appendMessage(run.id, { role: "assistant", content: "after release" });
    second.appendEvent(run.id, "second", { ok: true });

    expect(firstDatabase.query("SELECT COUNT(*) AS count FROM messages WHERE run_id = ?").get(run.id)).toEqual({ count: 1 });
    expect(firstDatabase.query("SELECT COUNT(*) AS count FROM events WHERE run_id = ?").get(run.id)).toEqual({ count: 1 });
  });
});

test("a transient cross-process lock is retried until the write succeeds", async () => {
  await withDatabase(async (path, open) => {
    const firstDatabase = open();
    const secondDatabase = open();
    const firstRepository = new StoreRepository(firstDatabase);
    const secondRepository = new StoreRepository(secondDatabase);
    const task = firstRepository.createTask({ title: "Retry", prompt: "Retry", workspace: "/tmp/workspace", maxSteps: 1 });
    const run = firstRepository.startRun(task.id, "retry-run");

    const child = Bun.spawn([
      process.execPath,
      "-e",
      `import {Database} from "bun:sqlite";
const database = new Database(process.argv[1]);
database.exec("PRAGMA busy_timeout = 0");
database.exec("BEGIN IMMEDIATE");
console.log("locked");
setTimeout(() => { database.exec("ROLLBACK"); database.close(); }, 5);`,
      path,
    ], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const firstOutput = await reader.read();
    expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");

    secondDatabase.exec("PRAGMA busy_timeout = 0");
    secondRepository.appendEvent(run.id, "retried", { ok: true });
    expect(firstDatabase.query("SELECT type FROM events WHERE run_id = ?").all(run.id)).toEqual([
      { type: "retried" },
    ]);
    expect(await child.exited).toBe(0);
  });
});
