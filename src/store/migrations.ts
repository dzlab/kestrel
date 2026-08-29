import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { PersistenceError } from "../errors";
import { immediateTransaction } from "./transaction";

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

// This is the byte-for-byte v1 SQL shipped in 0084a0f. That release folded
// the indexes into v1, added status CHECK constraints, and moved tool-call
// uniqueness to an explicit index.
const historicalVersionOneSql = `
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

const versionThreeSql = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(call_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at, claimed_by);
      CREATE INDEX IF NOT EXISTS idx_approvals_call_hash ON approvals(call_id, arguments_hash);
    `;

const versionFourSql = `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(call_id);
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_messages_run_sequence ON messages(run_id, sequence_number);
      CREATE INDEX IF NOT EXISTS idx_events_task_created ON events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_run_created ON events(run_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at, claimed_by);
      CREATE INDEX IF NOT EXISTS idx_approvals_call_hash ON approvals(call_id, arguments_hash);
    `;

// This is the immutable v1 SQL from 0fed501.  The 0084a0f v1 SQL is retained
// below as a historical checksum because that release changed v1 in place.
export const versionOneChecksum = migrationChecksum(versionOneSql);
export const historicalVersionOneChecksum =
  "3553adbe9019bbe2e3868ad43e4d74ed0834f1465ada668514046e570686d8aa";

export const migrations: readonly Migration[] = [
  { version: 1, sql: versionOneSql },
  { version: 2, sql: versionTwoSql, prepare: prepareVersionTwo },
  { version: 3, sql: versionThreeSql, prepare: prepareVersionThree },
  { version: 4, sql: versionFourSql, prepare: prepareVersionFour },
];

type ColumnDefinition = { name: string; type: string };

const requiredTableColumns: Readonly<Record<string, readonly ColumnDefinition[]>> = {
  schema_migrations: [
    { name: "version", type: "INTEGER" },
    { name: "checksum", type: "TEXT" },
    { name: "applied_at", type: "INTEGER" },
  ],
  tasks: [
    { name: "id", type: "TEXT" },
    { name: "title", type: "TEXT" },
    { name: "prompt", type: "TEXT" },
    { name: "workspace", type: "TEXT" },
    { name: "max_steps", type: "INTEGER" },
    { name: "status", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
    { name: "updated_at", type: "INTEGER" },
  ],
  runs: [
    { name: "id", type: "TEXT" },
    { name: "task_id", type: "TEXT" },
    { name: "idempotency_key", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "started_at", type: "INTEGER" },
    { name: "finished_at", type: "INTEGER" },
  ],
  messages: [
    { name: "id", type: "INTEGER" },
    { name: "run_id", type: "TEXT" },
    { name: "sequence_number", type: "INTEGER" },
    { name: "payload", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
  ],
  tool_calls: [
    { name: "id", type: "INTEGER" },
    { name: "run_id", type: "TEXT" },
    { name: "call_id", type: "TEXT" },
    { name: "name", type: "TEXT" },
    { name: "arguments", type: "TEXT" },
    { name: "state", type: "TEXT" },
    { name: "result", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
    { name: "finished_at", type: "INTEGER" },
  ],
  events: [
    { name: "id", type: "INTEGER" },
    { name: "task_id", type: "TEXT" },
    { name: "run_id", type: "TEXT" },
    { name: "type", type: "TEXT" },
    { name: "payload", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
  ],
  memories: [
    { name: "id", type: "TEXT" },
    { name: "task_id", type: "TEXT" },
    { name: "run_id", type: "TEXT" },
    { name: "kind", type: "TEXT" },
    { name: "content", type: "TEXT" },
    { name: "metadata", type: "TEXT" },
    { name: "confidence", type: "REAL" },
    { name: "created_at", type: "INTEGER" },
    { name: "updated_at", type: "INTEGER" },
  ],
  schedules: [
    { name: "id", type: "TEXT" },
    { name: "task_id", type: "TEXT" },
    { name: "prompt", type: "TEXT" },
    { name: "cron", type: "TEXT" },
    { name: "next_run_at", type: "INTEGER" },
    { name: "enabled", type: "INTEGER" },
    { name: "claimed_by", type: "TEXT" },
    { name: "claimed_at", type: "INTEGER" },
    { name: "lease_token", type: "TEXT" },
    { name: "last_error", type: "TEXT" },
    { name: "created_at", type: "INTEGER" },
  ],
  approvals: [
    { name: "call_id", type: "TEXT" },
    { name: "arguments_hash", type: "TEXT" },
    { name: "task_id", type: "TEXT" },
    { name: "run_id", type: "TEXT" },
    { name: "capability", type: "TEXT" },
    { name: "risk_level", type: "TEXT" },
    { name: "decision", type: "TEXT" },
    { name: "requested_at", type: "INTEGER" },
    { name: "resolved_at", type: "INTEGER" },
  ],
};

const requiredPrimaryKeys: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  schema_migrations: { version: 1 },
  tasks: { id: 1 },
  runs: { id: 1 },
  messages: { id: 1 },
  tool_calls: { id: 1 },
  events: { id: 1 },
  memories: { id: 1 },
  schedules: { id: 1 },
  approvals: { call_id: 1, arguments_hash: 2 },
};

const requiredNotNullColumns: Readonly<Record<string, readonly string[]>> = {
  schema_migrations: ["checksum", "applied_at"],
  tasks: ["title", "prompt", "workspace", "max_steps", "status", "created_at", "updated_at"],
  runs: ["task_id", "idempotency_key", "status", "started_at"],
  messages: ["run_id", "sequence_number", "payload", "created_at"],
  tool_calls: ["run_id", "call_id", "name", "arguments", "state", "created_at"],
  events: ["type", "payload", "created_at"],
  memories: ["kind", "content", "metadata", "created_at", "updated_at"],
  schedules: ["prompt", "enabled", "created_at"],
  approvals: ["call_id", "arguments_hash", "capability", "risk_level", "decision", "requested_at"],
};

type ForeignKeyDefinition = {
  table: string;
  from: string;
  to: string;
  onDelete: string;
  onUpdate: string;
  match: string;
};

const defaultForeignKeyActions = {
  onDelete: "NO ACTION",
  onUpdate: "NO ACTION",
  match: "NONE",
} as const;

function foreignKey(table: string, from: string, to: string): ForeignKeyDefinition {
  return { table, from, to, ...defaultForeignKeyActions };
}

const requiredForeignKeys: Readonly<Record<string, readonly ForeignKeyDefinition[]>> = {
  schema_migrations: [],
  tasks: [],
  runs: [foreignKey("tasks", "task_id", "id")],
  messages: [foreignKey("runs", "run_id", "id")],
  tool_calls: [foreignKey("runs", "run_id", "id")],
  events: [
    foreignKey("tasks", "task_id", "id"),
    foreignKey("runs", "run_id", "id"),
  ],
  memories: [
    foreignKey("tasks", "task_id", "id"),
    foreignKey("runs", "run_id", "id"),
  ],
  schedules: [foreignKey("tasks", "task_id", "id")],
  approvals: [
    foreignKey("tasks", "task_id", "id"),
    foreignKey("runs", "run_id", "id"),
  ],
};

const requiredTableUniqueConstraints = [
  { table: "runs", columns: ["task_id", "idempotency_key"] },
  { table: "messages", columns: ["run_id", "sequence_number"] },
] as const;

const requiredIndexes = [
  {
    name: "idx_tool_calls_call_id",
    table: "tool_calls",
    unique: true,
    columns: ["call_id"],
    sql: "create unique index idx_tool_calls_call_id on tool_calls(call_id)",
  },
  {
    name: "idx_runs_task_id",
    table: "runs",
    unique: false,
    columns: ["task_id"],
    sql: "create index idx_runs_task_id on runs(task_id)",
  },
  {
    name: "idx_messages_run_sequence",
    table: "messages",
    unique: false,
    columns: ["run_id", "sequence_number"],
    sql: "create index idx_messages_run_sequence on messages(run_id, sequence_number)",
  },
  {
    name: "idx_events_task_created",
    table: "events",
    unique: false,
    columns: ["task_id", "created_at"],
    sql: "create index idx_events_task_created on events(task_id, created_at)",
  },
  {
    name: "idx_events_run_created",
    table: "events",
    unique: false,
    columns: ["run_id", "created_at"],
    sql: "create index idx_events_run_created on events(run_id, created_at)",
  },
  {
    name: "idx_memories_created",
    table: "memories",
    unique: false,
    columns: ["created_at"],
    sql: "create index idx_memories_created on memories(created_at)",
  },
  {
    name: "idx_schedules_due",
    table: "schedules",
    unique: false,
    columns: ["enabled", "next_run_at", "claimed_by"],
    sql: "create index idx_schedules_due on schedules(enabled, next_run_at, claimed_by)",
  },
  {
    name: "idx_approvals_call_hash",
    table: "approvals",
    unique: false,
    columns: ["call_id", "arguments_hash"],
    sql: "create index idx_approvals_call_hash on approvals(call_id, arguments_hash)",
  },
] as const;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function expectedChecksum(migration: Migration): string {
  return migrationChecksum(migration.sql);
}

function fail(message: string): never {
  throw new PersistenceError(message);
}

function prepareVersionTwo(database: Database): void {
  const hasChecksum = tableInfo(database, "schema_migrations").some((column) => column.name === "checksum");
  assertPreVersionTwoLineage(database, hasChecksum);
  if (hasChecksum) {
    return;
  }

  database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''");
  const updated = database
    .query("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
    .run(versionOneChecksum);
  if (updated.changes !== 1) {
    fail("cannot establish the historical version-1 checksum");
  }
}

function prepareVersionThree(database: Database): void {
  assertScheduleLeaseTuples(database);
  const toolCallsSequence = database
    .query("SELECT seq FROM sqlite_sequence WHERE name = 'tool_calls'")
    .get() as { seq: number } | null;
  const ledgerColumns = tableInfo(database, "schema_migrations");
  if (ledgerColumns.some((column) => column.name === "checksum" && column.notnull !== 1)) {
    database.exec(`
      CREATE TABLE schema_migrations_v3 (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO schema_migrations_v3 (version, applied_at, checksum)
        SELECT version, applied_at, checksum FROM schema_migrations;
      DROP TABLE schema_migrations;
      ALTER TABLE schema_migrations_v3 RENAME TO schema_migrations;
    `);
  }

  database.exec(`
    CREATE TABLE schedules_v3 (
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
      created_at INTEGER NOT NULL,
      CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
    );
    INSERT INTO schedules_v3
      (id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, lease_token, last_error, created_at)
    SELECT id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, NULL, last_error, created_at
    FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_v3 RENAME TO schedules;

    CREATE TABLE approvals_v3 (
      call_id TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id),
      run_id TEXT REFERENCES runs(id),
      capability TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'denied')),
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      PRIMARY KEY (call_id, arguments_hash)
    );
    INSERT INTO approvals_v3
      (call_id, arguments_hash, task_id, run_id, capability, risk_level, decision, requested_at, resolved_at)
    SELECT call_id, arguments_hash, task_id, run_id, capability, risk_level, decision, requested_at, resolved_at
    FROM approvals;
    DROP TABLE approvals;
    ALTER TABLE approvals_v3 RENAME TO approvals;

    CREATE TABLE tool_calls_v3 (
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
    INSERT INTO tool_calls_v3
      (id, run_id, call_id, name, arguments, state, result, created_at, finished_at)
    SELECT id, run_id, call_id, name, arguments, state, result, created_at, finished_at
    FROM tool_calls;
    DROP TABLE tool_calls;
    ALTER TABLE tool_calls_v3 RENAME TO tool_calls;
  `);

  if (toolCallsSequence !== null) {
    const currentSequence = database
      .query("SELECT seq FROM sqlite_sequence WHERE name = 'tool_calls'")
      .get() as { seq: number } | null;
    if (currentSequence === null) {
      database.query("INSERT INTO sqlite_sequence (name, seq) VALUES ('tool_calls', ?)").run(toolCallsSequence.seq);
    } else if (currentSequence.seq < toolCallsSequence.seq) {
      database.query("UPDATE sqlite_sequence SET seq = ? WHERE name = 'tool_calls'").run(toolCallsSequence.seq);
    }
  }
}

function prepareVersionFour(database: Database): void {
  assertScheduleLeaseTuples(database);

  database.exec(`
    CREATE TABLE schedules_v4 (
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
      created_at INTEGER NOT NULL,
      CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
    );
    INSERT INTO schedules_v4
      (id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, lease_token, last_error, created_at)
    SELECT id, task_id, prompt, cron, next_run_at, enabled, claimed_by, claimed_at, lease_token, last_error, created_at
    FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_v4 RENAME TO schedules;
  `);
}

type TableInfoRow = { name: string; type: string; notnull: number; pk: number };

function tableInfo(database: Database, table: string): TableInfoRow[] {
  return database.query(`PRAGMA table_info('${table}')`).all() as TableInfoRow[];
}

function assertScheduleLeaseTuples(database: Database): void {
  const malformed = database
    .query(
      `SELECT id FROM schedules
       WHERE (claimed_by IS NULL AND claimed_at IS NOT NULL)
          OR (claimed_by IS NOT NULL AND claimed_at IS NULL)
       LIMIT 1`,
    )
    .get() as { id: string } | null;
  if (malformed !== null) {
    fail(`schedule ${malformed.id} has a malformed lease tuple`);
  }
}

function hasTable(database: Database, table: string): boolean {
  return database
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== null;
}

function assertSchemaMigrationsShape(database: Database, allowLegacyNullableChecksum = false): boolean {
  if (!hasTable(database, "schema_migrations")) {
    fail("schema_migrations table is missing");
  }

  const duplicate = database
    .query(
      "SELECT version FROM schema_migrations GROUP BY version HAVING COUNT(*) > 1 LIMIT 1",
    )
    .get() as { version: number } | null;
  if (duplicate !== null) {
    fail(`schema_migrations contains duplicate version ${duplicate.version}`);
  }

  const columns = tableInfo(database, "schema_migrations");
  const expected = columns.some((column) => column.name === "checksum")
    ? requiredTableColumns.schema_migrations
    : requiredTableColumns.schema_migrations.filter((column) => column.name !== "checksum");
  if (columns.length !== expected.length) {
    fail("schema_migrations has an altered column layout");
  }
  for (const requiredColumn of expected) {
    const actual = columns.find((column) => column.name === requiredColumn.name);
    if (actual === undefined) {
      fail(`schema_migrations is missing required column ${requiredColumn.name}`);
    }
    if (actual.type.toUpperCase() !== requiredColumn.type) {
      fail(`schema_migrations column ${requiredColumn.name} has an altered declared type`);
    }
    const expectedPrimaryKey = requiredPrimaryKeys.schema_migrations[requiredColumn.name] ?? 0;
    if (actual.pk !== expectedPrimaryKey) {
      fail(`schema_migrations column ${requiredColumn.name} has altered primary-key metadata`);
    }
    const expectedNotNull = requiredNotNullColumns.schema_migrations.includes(requiredColumn.name) ? 1 : 0;
    if (
      actual.notnull !== expectedNotNull &&
      !(requiredColumn.name === "checksum" && allowLegacyNullableChecksum && actual.notnull === 0)
    ) {
      fail(`schema_migrations column ${requiredColumn.name} has altered NOT NULL metadata`);
    }
  }
  return expected.length === requiredTableColumns.schema_migrations.length;
}

function assertTableColumns(database: Database, table: string, expected: readonly ColumnDefinition[]): void {
  const actual = tableInfo(database, table);
  if (actual.length !== expected.length) {
    fail(`required table ${table} has an altered column layout`);
  }
  for (const [index, requiredColumn] of expected.entries()) {
    const actualColumn = table === "schema_migrations"
      ? actual.find((column) => column.name === requiredColumn.name)
      : actual[index];
    if (actualColumn?.name !== requiredColumn.name) {
      fail(`required table ${table} has an altered column layout`);
    }
    if (actualColumn === undefined || actualColumn.type.toUpperCase() !== requiredColumn.type) {
      fail(`required table ${table} column ${requiredColumn.name} has an altered declared type`);
    }
    const expectedPrimaryKey = requiredPrimaryKeys[table]?.[requiredColumn.name] ?? 0;
    if (actualColumn.pk !== expectedPrimaryKey) {
      fail(`required table ${table} column ${requiredColumn.name} has altered primary-key metadata`);
    }
    const expectedNotNull = requiredNotNullColumns[table]?.includes(requiredColumn.name) ? 1 : 0;
    if (actualColumn.notnull !== expectedNotNull) {
      fail(`required table ${table} column ${requiredColumn.name} has altered NOT NULL metadata`);
    }
  }
}

function assertForeignKeys(database: Database, table: string, expected: readonly ForeignKeyDefinition[]): void {
  const actual = (
    database.query(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
      on_update: string;
      match: string;
    }>
  )
    .map(
      (foreignKey) =>
        `${foreignKey.table}:${foreignKey.from}:${foreignKey.to}:${foreignKey.on_delete}:${foreignKey.on_update}:${foreignKey.match}`,
    )
    .sort();
  const required = expected
    .map(
      (foreignKey) =>
        `${foreignKey.table}:${foreignKey.from}:${foreignKey.to}:${foreignKey.onDelete}:${foreignKey.onUpdate}:${foreignKey.match}`,
    )
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(`required foreign-key relationships are missing or altered on ${table}`);
  }
}

function indexColumns(database: Database, indexName: string): string[] {
  return (database.query(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string; seqno: number }>)
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => column.name);
}

function assertTableUniqueConstraints(database: Database): void {
  for (const table of new Set(requiredTableUniqueConstraints.map((constraint) => constraint.table))) {
    const required = requiredTableUniqueConstraints
      .filter((constraint) => constraint.table === table)
      .map((constraint) => constraint.columns.join(","))
      .sort();
    const actual = (
      database.query(`PRAGMA index_list('${table}')`).all() as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>
    )
      .filter(
        (index) =>
          Number(index.unique) === 1 &&
          String(index.origin).toLowerCase() === "u" &&
          Number(index.partial) === 0,
      )
      .map((index) => indexColumns(database, index.name).join(","))
      .sort();

    if (JSON.stringify(actual) !== JSON.stringify(required)) {
      fail(`required table-level uniqueness is missing or altered on ${table}`);
    }
  }
}

function normalizedSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .replace(/\s*;\s*$/, "")
    .trim();
}

type SchemaLineage = {
  checksum: string;
  hasIndexes: boolean;
  hasInlineStatusChecks: boolean;
  hasInlineToolCallUnique: boolean;
};

const originalVersionOneLineage: SchemaLineage = {
  checksum: versionOneChecksum,
  hasIndexes: false,
  hasInlineStatusChecks: false,
  hasInlineToolCallUnique: true,
};

const hardenedVersionOneLineage: SchemaLineage = {
  checksum: historicalVersionOneChecksum,
  hasIndexes: true,
  hasInlineStatusChecks: true,
  hasInlineToolCallUnique: false,
};

const taskStatusValues = "'pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted'";
const runStatusValues = "'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted'";

function expectedLineageTableSql(table: "tasks" | "runs", hasInlineStatusChecks: boolean): string {
  const status = table === "tasks" ? taskStatusValues : runStatusValues;
  const statusColumn = hasInlineStatusChecks
    ? `status TEXT NOT NULL CHECK (status IN (${status}))`
    : "status TEXT NOT NULL";
  if (table === "tasks") {
    return normalizedSql(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        ${statusColumn},
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }
  return normalizedSql(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id),
      idempotency_key TEXT NOT NULL,
      ${statusColumn},
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE (task_id, idempotency_key)
    )
  `);
}

function expectedLineageToolCallsSql(hasInlineUnique: boolean): string {
  return normalizedSql(`
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      call_id TEXT NOT NULL${hasInlineUnique ? " UNIQUE" : ""},
      name TEXT NOT NULL,
      arguments TEXT NOT NULL,
      state TEXT NOT NULL,
      result TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    )
  `);
}

const schemaLineages = new Map<string, SchemaLineage>([
  [originalVersionOneLineage.checksum, originalVersionOneLineage],
  [hardenedVersionOneLineage.checksum, hardenedVersionOneLineage],
]);

function appliedVersionOneChecksum(database: Database): string | null {
  const row = database
    .query("SELECT checksum FROM schema_migrations WHERE version = 1")
    .get() as { checksum: string | null } | null;
  return row?.checksum ?? null;
}

function schemaLineageFor(database: Database, hasChecksum: boolean): SchemaLineage {
  if (!hasChecksum) {
    return originalVersionOneLineage;
  }
  const checksum = appliedVersionOneChecksum(database);
  const lineage = checksum === null ? undefined : schemaLineages.get(checksum);
  if (lineage === undefined) {
    fail("migration 1 checksum does not identify a supported schema lineage");
  }
  return lineage;
}

function assertLineageSchema(database: Database, lineage: SchemaLineage, checkIndexes: boolean): void {
  const legacyColumns = Object.fromEntries(
    Object.entries(requiredTableColumns).map(([table, columns]) => [
      table,
      columns.filter((column) => column.name !== "lease_token"),
    ]),
  ) as Record<string, readonly ColumnDefinition[]>;
  if (checkIndexes) {
    for (const [table, columns] of Object.entries(legacyColumns)) {
      if (table === "schema_migrations") {
        continue;
      }
      if (!hasTable(database, table)) {
        fail(`migration 1 checksum does not match the schema lineage for table ${table}`);
      }
      assertTableColumns(database, table, columns);
      assertForeignKeys(database, table, requiredForeignKeys[table]);
    }
    assertTableUniqueConstraints(database);
  }

  for (const table of ["tasks", "runs"] as const) {
    const row = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | null;
    if (
      row === null ||
      normalizedSql(row.sql) !== expectedLineageTableSql(table as "tasks" | "runs", lineage.hasInlineStatusChecks)
    ) {
      fail(`migration 1 checksum does not match the schema lineage for table ${table}`);
    }
  }

  if (!checkIndexes) {
    return;
  }

  const toolCalls = database
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'")
    .get() as { sql: string } | null;
  if (
    toolCalls === null ||
    normalizedSql(toolCalls.sql) !== expectedLineageToolCallsSql(lineage.hasInlineToolCallUnique)
  ) {
    fail("migration 1 checksum does not match the schema lineage for tool_calls");
  }

  const actualIndexes = database
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
    .all() as Array<{ name: string }>;
  if (lineage.hasIndexes) {
    if (actualIndexes.length !== requiredIndexes.length) {
      fail("migration 1 checksum does not match the schema lineage indexes");
    }
    for (const index of requiredIndexes) {
      const actual = database
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index.name) as { sql: string | null } | null;
      if (actual === null || actual.sql === null || normalizedSql(actual.sql) !== normalizedSql(index.sql)) {
        fail(`migration 1 checksum does not match the schema lineage index ${index.name}`);
      }
    }
  } else if (actualIndexes.length !== 0) {
    fail("migration 1 checksum does not match the schema lineage indexes");
  }
}

function assertPreVersionTwoLineage(database: Database, hasChecksum: boolean): void {
  const lineage = schemaLineageFor(database, hasChecksum);
  assertLineageSchema(database, lineage, true);
}

const requiredTriggerDefinitions = [
  {
    name: "tasks_status_insert_guard",
    sql: "CREATE TRIGGER tasks_status_insert_guard BEFORE INSERT ON tasks WHEN NEW.status NOT IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted') BEGIN SELECT RAISE(ABORT, 'invalid task status'); END;",
  },
  {
    name: "tasks_status_update_guard",
    sql: "CREATE TRIGGER tasks_status_update_guard BEFORE UPDATE OF status ON tasks WHEN NEW.status NOT IN ('pending', 'running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted') BEGIN SELECT RAISE(ABORT, 'invalid task status'); END;",
  },
  {
    name: "runs_status_insert_guard",
    sql: "CREATE TRIGGER runs_status_insert_guard BEFORE INSERT ON runs WHEN NEW.status NOT IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted') BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;",
  },
  {
    name: "runs_status_update_guard",
    sql: "CREATE TRIGGER runs_status_update_guard BEFORE UPDATE OF status ON runs WHEN NEW.status NOT IN ('running', 'completed', 'failed', 'blocked_on_approval', 'budget_exhausted') BEGIN SELECT RAISE(ABORT, 'invalid run status'); END;",
  },
] as const;

const requiredTableDefinitions = [
  {
    table: "schedules",
    sql: normalizedSql(`
      CREATE TABLE "schedules" (
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
        created_at INTEGER NOT NULL,
        CHECK ((claimed_by IS NULL) = (claimed_at IS NULL))
      )
    `),
  },
  {
    table: "approvals",
    sql: normalizedSql(`
      CREATE TABLE "approvals" (
        call_id TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        capability TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'denied')),
        requested_at INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (call_id, arguments_hash)
      )
    `),
  },
] as const;

const requiredCurrentTableDefinitions = [
  {
    table: "messages",
    sql: normalizedSql(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        sequence_number INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, sequence_number)
      )
    `),
  },
  {
    table: "events",
    sql: normalizedSql(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id),
        run_id TEXT REFERENCES runs(id),
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),
  },
  {
    table: "tool_calls",
    sql: normalizedSql(`
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
      )
    `),
  },
  {
    table: "memories",
    sql: normalizedSql(`
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
      )
    `),
  },
] as const;

const currentSchemaMigrationsDefinition = normalizedSql(`
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    checksum TEXT NOT NULL DEFAULT ''
  )
`);

const historicalSchemaMigrationsDefinition = normalizedSql(`
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )
`);

function assertRequiredSchema(database: Database): void {
  for (const [table, columns] of Object.entries(requiredTableColumns)) {
    if (!hasTable(database, table)) {
      fail(`required table is missing: ${table}`);
    }
    assertTableColumns(database, table, columns);
    assertForeignKeys(database, table, requiredForeignKeys[table]);
  }

  for (const requiredTable of requiredTableDefinitions) {
    const actual = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(requiredTable.table) as { sql: string } | null;
    if (actual === null || normalizedSql(actual.sql) !== requiredTable.sql) {
      fail(`required table constraint is missing or altered: ${requiredTable.table}`);
    }
  }

  const expectedSchemaMigrationsDefinition = appliedVersionOneChecksum(database) === historicalVersionOneChecksum
    ? historicalSchemaMigrationsDefinition
    : currentSchemaMigrationsDefinition;
  const schemaMigrationsDefinition = database
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { sql: string } | null;
  if (
    schemaMigrationsDefinition === null ||
    normalizedSql(schemaMigrationsDefinition.sql) !== expectedSchemaMigrationsDefinition
  ) {
    fail("schema_migrations has an altered table definition");
  }

  for (const requiredTable of requiredCurrentTableDefinitions) {
    const actual = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(requiredTable.table) as { sql: string } | null;
    if (actual === null || normalizedSql(actual.sql) !== requiredTable.sql) {
      fail(`required table definition is missing or altered: ${requiredTable.table}`);
    }
  }

  assertTableUniqueConstraints(database);

  for (const index of requiredIndexes) {
    const indexes = database.query(`PRAGMA index_list('${index.table}')`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const actual = indexes.find((candidate) => candidate.name === index.name);
    if (
      actual === undefined ||
      Number(actual.unique) !== (index.unique ? 1 : 0) ||
      Number(actual.partial) !== 0
    ) {
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

    const actualDefinition = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(index.name) as { sql: string | null } | null;
    if (
      actualDefinition === null ||
      actualDefinition.sql === null ||
      normalizedSql(actualDefinition.sql) !== normalizedSql(index.sql)
    ) {
      fail(`required index is missing or altered: ${index.name}`);
    }
  }

  for (const trigger of requiredTriggerDefinitions) {
    const actual = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger.name) as { sql: string } | null;
    if (actual === null) {
      fail(`required trigger is missing: ${trigger.name}`);
    }
    if (normalizedSql(actual.sql) !== normalizedSql(trigger.sql)) {
      fail(`required trigger is missing or altered: ${trigger.name}`);
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

  if (
    database
      .query("SELECT 1 AS invalid FROM approvals WHERE decision NOT IN ('pending', 'approved', 'denied') LIMIT 1")
      .get() !== null
  ) {
    fail("approvals contains an invalid persisted decision");
  }
  if (
    database.query("SELECT 1 AS invalid FROM schedules WHERE enabled NOT IN (0, 1) LIMIT 1").get() !== null
  ) {
    fail("schedules contains an invalid persisted enabled value");
  }

  const toolCallIndexes = database.query("PRAGMA index_list('tool_calls')").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>;
  const toolCallUniqueIndexes = toolCallIndexes.filter((index) => {
    if (Number(index.unique) !== 1 || Number(index.partial) !== 0) {
      return false;
    }
    const columns = database.query(`PRAGMA index_info('${index.name}')`).all() as Array<{
      name: string;
      seqno: number;
    }>;
    return columns.sort((left, right) => left.seqno - right.seqno).map((column) => column.name).join(",") === "call_id";
  });
  if (
    toolCallUniqueIndexes.length !== 1 ||
    toolCallUniqueIndexes[0]?.name !== "idx_tool_calls_call_id"
  ) {
    fail("tool_calls must have exactly one non-partial unique call_id constraint");
  }

  assertScheduleLeaseTuples(database);

  const expectedTables = new Set([...Object.keys(requiredTableColumns), "sqlite_sequence"]);
  const unexpectedTable = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  if (unexpectedTable.some((table) => !expectedTables.has(table.name))) {
    fail("database contains an unexpected table");
  }

  const unexpectedIndex = database
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
    .all() as Array<{ name: string }>;
  const expectedIndexNames: Set<string> = new Set(requiredIndexes.map((index) => index.name));
  if (unexpectedIndex.some((index) => !expectedIndexNames.has(index.name))) {
    fail("database contains an unexpected index");
  }

  const actualTriggers = database
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  const expectedTriggerNames: Set<string> = new Set(requiredTriggerDefinitions.map((trigger) => trigger.name));
  if (actualTriggers.some((trigger) => !expectedTriggerNames.has(trigger.name))) {
    fail("database contains an unexpected trigger");
  }

  const foreignKeyViolations = database.query("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    fail(`foreign-key integrity check failed with ${foreignKeyViolations.length} violation(s)`);
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
    const acceptedChecksums = migration.version === 1
      ? [versionOneChecksum, historicalVersionOneChecksum]
      : [expectedChecksum(migration)];
    if (row.checksum === null || !acceptedChecksums.includes(row.checksum)) {
      fail(`migration ${row.version} checksum mismatch`);
    }
  }
}

export function runMigrations(database: Database): void {
  immediateTransaction(database, () => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const versionThreeApplied = database
      .query("SELECT 1 AS applied FROM schema_migrations WHERE version = 3")
      .get() !== null;
    let hasChecksum = assertSchemaMigrationsShape(database, !versionThreeApplied);
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
    assertLineageSchema(database, schemaLineageFor(database, true), false);
    assertRequiredSchema(database);
  });

}

export const migrate = runMigrations;
