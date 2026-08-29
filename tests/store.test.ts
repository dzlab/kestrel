import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistenceError, ValidationError } from "../src/errors";
import { openDatabase } from "../src/store/database";
import { migrations } from "../src/store/migrations";
import { StoreRepository } from "../src/store/repository";
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

    expect(repository.claimDueSchedule(1_000, "worker-a")).toMatchObject({ id: "schedule-1" });
    expect(repository.claimDueSchedule(1_000, "worker-b")).toBeNull();
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
    repository.claimDueSchedule(1_000, "owner-a");

    expect(repository.finishSchedule("leased-schedule", "owner-b", null, null)).toBe(false);
    expect(repository.finishSchedule("leased-schedule", "owner-a", null, null)).toBe(true);
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

test("fresh databases apply the complete migration history", () => {
  withDatabase((_path, open) => {
    const database = open();
    const versions = database
      .query("SELECT version, checksum FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number; checksum: string }>;

    expect(versions.map((migration) => migration.version)).toEqual([1, 2]);
    expect(versions.every((migration) => migration.checksum.length === 64)).toBe(true);
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'").get()).toEqual({
      name: "approvals",
    });
    expect(database.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_schedules_due'").get()).toEqual({
      name: "idx_schedules_due",
    });
  });
});

test("legacy version-1 databases upgrade without losing data", () => {
  withDatabase((path, open) => {
    const legacy = new Database(path);
    legacy.exec(migrations.find((migration) => migration.version === 1)?.sql ?? "");
    legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    legacy.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, 1_700_000_000_000);
    legacy
      .query(
        `INSERT INTO tasks (id, title, prompt, workspace, max_steps, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-task", "Legacy", "Keep this task", "/tmp/workspace", 3, "pending", 1_700_000_000_000, 1_700_000_000_000);
    legacy.close();

    const database = open();
    expect(database.query("SELECT title FROM tasks WHERE id = ?").get("legacy-task")).toEqual({ title: "Legacy" });
    expect(database.query("PRAGMA table_info('schema_migrations')").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "checksum" })]),
    );
    expect(database.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
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
