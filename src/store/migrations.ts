import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { PersistenceError } from "../errors";

export type Migration = {
  version: number;
  sql: string;
};

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
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
    `,
  },
];

const requiredTableColumns: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ["version", "checksum", "applied_at"],
  tasks: ["id", "title", "prompt", "workspace", "max_steps", "status", "created_at", "updated_at"],
  runs: ["id", "task_id", "idempotency_key", "status", "started_at", "finished_at"],
  messages: ["id", "run_id", "sequence_number", "payload", "created_at"],
  tool_calls: ["id", "run_id", "call_id", "name", "arguments", "state", "result", "created_at", "finished_at"],
  events: ["id", "task_id", "run_id", "type", "payload", "created_at"],
  memories: ["id", "task_id", "run_id", "kind", "content", "metadata", "confidence", "created_at", "updated_at"],
  schedules: ["id", "task_id", "prompt", "cron", "next_run_at", "enabled", "claimed_by", "claimed_at", "last_error", "created_at"],
  approvals: ["call_id", "arguments_hash", "task_id", "run_id", "capability", "risk_level", "decision", "requested_at", "resolved_at"],
};

const requiredIndexes = [
  { name: "idx_tool_calls_call_id", table: "tool_calls", unique: true, columns: ["call_id"] },
  { name: "idx_runs_task_id", table: "runs", unique: false, columns: ["task_id"] },
  { name: "idx_messages_run_sequence", table: "messages", unique: false, columns: ["run_id", "sequence_number"] },
  { name: "idx_events_task_created", table: "events", unique: false, columns: ["task_id", "created_at"] },
  { name: "idx_events_run_created", table: "events", unique: false, columns: ["run_id", "created_at"] },
  { name: "idx_memories_created", table: "memories", unique: false, columns: ["created_at"] },
  { name: "idx_schedules_due", table: "schedules", unique: false, columns: ["enabled", "next_run_at", "claimed_by"] },
  { name: "idx_approvals_call_hash", table: "approvals", unique: false, columns: ["call_id", "arguments_hash"] },
] as const;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function fail(message: string): never {
  throw new PersistenceError(message);
}

function assertSchemaMigrationsShape(database: Database): void {
  const columns = database
    .query("PRAGMA table_info('schema_migrations')")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const requiredColumn of requiredTableColumns.schema_migrations) {
    if (!names.has(requiredColumn)) {
      fail(`schema_migrations is missing required column ${requiredColumn}`);
    }
  }
}

function assertRequiredSchema(database: Database): void {
  for (const [table, columns] of Object.entries(requiredTableColumns)) {
    const object = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name: string } | null;
    if (object === null) {
      fail(`required table is missing: ${table}`);
    }

    const actualColumns = database.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
    const actualNames = new Set(actualColumns.map((column) => column.name));
    for (const column of columns) {
      if (!actualNames.has(column)) {
        fail(`required table ${table} is missing column ${column}`);
      }
    }
  }

  for (const index of requiredIndexes) {
    const indexes = database.query(`PRAGMA index_list('${index.table}')`).all() as Array<{
      name: string;
      unique: number;
    }>;
    const actual = indexes.find((candidate) => candidate.name === index.name);
    if (actual === undefined || Number(actual.unique) !== (index.unique ? 1 : 0)) {
      fail(`required index is missing or altered: ${index.name}`);
    }

    const columns = database.query(`PRAGMA index_info('${index.name}')`).all() as Array<{
      name: string;
      seqno: number;
    }>;
    const actualColumns = columns.sort((left, right) => left.seqno - right.seqno).map((column) => column.name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(index.columns)) {
      fail(`required index is missing or altered: ${index.name}`);
    }
  }
}

export function runMigrations(database: Database): void {
  const transaction = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    assertSchemaMigrationsShape(database);

    const knownMigrations = new Map(migrations.map((migration) => [migration.version, migration]));
    const appliedRows = database.query("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      checksum: string;
    }>;
    const applied = new Set<number>();

    for (const row of appliedRows) {
      const migration = knownMigrations.get(row.version);
      if (migration === undefined) {
        fail(`unknown migration version ${row.version}; database requires a newer Kestrel version`);
      }

      const expectedChecksum = migrationChecksum(migration.sql);
      if (row.checksum !== expectedChecksum) {
        fail(`migration ${row.version} checksum mismatch`);
      }
      applied.add(row.version);
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      database.exec(migration.sql);
      database
        .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migrationChecksum(migration.sql), Date.now());
    }

    assertRequiredSchema(database);
  });

  transaction.immediate();
}

export const migrate = runMigrations;
