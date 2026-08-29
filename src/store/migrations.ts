import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { PersistenceError } from "../errors";

export type Migration = {
  version: number;
  sql: string;
  prepare?: (database: Database) => void;
};

// Keep this SQL byte-for-byte compatible with the v1 migration shipped in 0fed501.
const versionOneSql = `
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

const versionTwoSql = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(call_id);
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_run_sequence ON messages(run_id, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_run_created ON events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at, claimed_by);
      CREATE INDEX IF NOT EXISTS idx_approvals_call_hash ON approvals(call_id, arguments_hash);

      CREATE TRIGGER IF NOT EXISTS tasks_status_insert_guard
      BEFORE INSERT ON tasks
      WHEN NEW.status NOT IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
      BEGIN SELECT RAISE(ABORT, 'invalid task status'); END;

      CREATE TRIGGER IF NOT EXISTS tasks_status_update_guard
      BEFORE UPDATE OF status ON tasks
      WHEN NEW.status NOT IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
      BEGIN SELECT RAISE(ABORT, 'invalid task status'); END;

      CREATE TRIGGER IF NOT EXISTS runs_status_insert_guard
      BEFORE INSERT ON runs
      WHEN NEW.status NOT IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
      BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;

      CREATE TRIGGER IF NOT EXISTS runs_status_update_guard
      BEFORE UPDATE OF status ON runs
      WHEN NEW.status NOT IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
      BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;
    `;

export const versionOneChecksum = "35a5325463baa76e76db95fb84a46bd41d40aa26d4414776bb855785fb0ac129";

export const migrations: readonly Migration[] = [
  { version: 1, sql: versionOneSql },
  { version: 2, sql: versionTwoSql, prepare: prepareVersionTwo },
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

const requiredTriggers = [
  "tasks_status_insert_guard",
  "tasks_status_update_guard",
  "runs_status_insert_guard",
  "runs_status_update_guard",
] as const;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function expectedChecksum(migration: Migration): string {
  const checksum = migrationChecksum(migration.sql);
  if (migration.version === 1 && checksum !== versionOneChecksum) {
    fail("bundled version-1 migration does not match its historical checksum");
  }
  return migration.version === 1 ? versionOneChecksum : checksum;
}

function fail(message: string): never {
  throw new PersistenceError(message);
}

function prepareVersionTwo(database: Database): void {
  if (tableColumns(database, "schema_migrations").has("checksum")) {
    return;
  }

  database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  const updated = database
    .query("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
    .run(versionOneChecksum);
  if (updated.changes !== 1) {
    fail("cannot establish the historical version-1 checksum");
  }
}

function tableColumns(database: Database, table: string): Set<string> {
  return new Set(
    (database.query(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

function hasTable(database: Database, table: string): boolean {
  return database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== null;
}

function assertSchemaMigrationsShape(database: Database): boolean {
  if (!hasTable(database, "schema_migrations")) {
    fail("schema_migrations table is missing");
  }

  const columns = tableColumns(database, "schema_migrations");
  for (const requiredColumn of ["version", "applied_at"] as const) {
    if (!columns.has(requiredColumn)) {
      fail(`schema_migrations is missing required column ${requiredColumn}`);
    }
  }
  return columns.has("checksum");
}

function assertRequiredSchema(database: Database): void {
  for (const [table, columns] of Object.entries(requiredTableColumns)) {
    if (!hasTable(database, table)) {
      fail(`required table is missing: ${table}`);
    }

    const actualColumns = tableColumns(database, table);
    for (const column of columns) {
      if (!actualColumns.has(column)) {
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

  for (const trigger of requiredTriggers) {
    if (
      database
        .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger) === null
    ) {
      fail(`required trigger is missing: ${trigger}`);
    }
  }

  if (
    database
      .query(
        `SELECT 1 AS invalid FROM tasks
         WHERE status NOT IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
         LIMIT 1`,
      )
      .get() !== null
  ) {
    fail("tasks contains an invalid persisted status");
  }
  if (
    database
      .query(
        `SELECT 1 AS invalid FROM runs
         WHERE status NOT IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted')
         LIMIT 1`,
      )
      .get() !== null
  ) {
    fail("runs contains an invalid persisted status");
  }
}

function assertAppliedChecksums(
  database: Database,
  rows: Array<{ version: number; checksum: string | null }>,
): void {
  const knownMigrations = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of rows) {
    const migration = knownMigrations.get(row.version);
    if (migration === undefined) {
      fail(`unknown migration version ${row.version}; database requires a newer Kestrel version`);
    }
    if (row.checksum !== expectedChecksum(migration)) {
      fail(`migration ${row.version} checksum mismatch`);
    }
  }
}

export function runMigrations(database: Database): void {
  const transaction = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    let hasChecksum = assertSchemaMigrationsShape(database);
    const knownMigrations = new Map(migrations.map((migration) => [migration.version, migration]));
    const versionRows = database.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    const applied = new Set(versionRows.map((row) => row.version));
    for (const row of versionRows) {
      if (!knownMigrations.has(row.version)) {
        fail(`unknown migration version ${row.version}; database requires a newer Kestrel version`);
      }
    }
    for (let index = 1; index < migrations.length; index += 1) {
      if (applied.has(migrations[index].version) && !applied.has(migrations[index - 1].version)) {
        fail(`migration history skips version ${migrations[index - 1].version}`);
      }
    }

    if (hasChecksum) {
      assertAppliedChecksums(
        database,
        database.query("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{
          version: number;
          checksum: string | null;
        }>,
      );
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      migration.prepare?.(database);
      hasChecksum = assertSchemaMigrationsShape(database);

      database.exec(migration.sql);
      if (hasChecksum) {
        database
          .query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, expectedChecksum(migration), Date.now());
      } else {
        database
          .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, Date.now());
      }
      applied.add(migration.version);
    }

    if (!hasChecksum) {
      fail("schema_migrations checksum upgrade was not applied");
    }
    assertAppliedChecksums(
      database,
      database.query("SELECT version, checksum FROM schema_migrations ORDER BY version").all() as Array<{
        version: number;
        checksum: string | null;
      }>,
    );
    assertRequiredSchema(database);
  });

  transaction.immediate();
}

export const migrate = runMigrations;
