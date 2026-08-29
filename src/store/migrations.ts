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

// This is the immutable v1 SQL from 0fed501.  The 0084a0f v1 SQL is retained
// below as a historical checksum because that release changed v1 in place.
export const versionOneChecksum = migrationChecksum(versionOneSql);
export const historicalVersionOneChecksum =
  "3553adbe9019bbe2e3868ad43e4d74ed0834f1465ada668514046e570686d8aa";

export const migrations: readonly Migration[] = [
  { version: 1, sql: versionOneSql },
  { version: 2, sql: versionTwoSql, prepare: prepareVersionTwo },
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

type ForeignKeyDefinition = { table: string; from: string; to: string };

const requiredForeignKeys: Readonly<Record<string, readonly ForeignKeyDefinition[]>> = {
  schema_migrations: [],
  tasks: [],
  runs: [{ table: "tasks", from: "task_id", to: "id" }],
  messages: [{ table: "runs", from: "run_id", to: "id" }],
  tool_calls: [{ table: "runs", from: "run_id", to: "id" }],
  events: [
    { table: "tasks", from: "task_id", to: "id" },
    { table: "runs", from: "run_id", to: "id" },
  ],
  memories: [
    { table: "tasks", from: "task_id", to: "id" },
    { table: "runs", from: "run_id", to: "id" },
  ],
  schedules: [{ table: "tasks", from: "task_id", to: "id" }],
  approvals: [
    { table: "tasks", from: "task_id", to: "id" },
    { table: "runs", from: "run_id", to: "id" },
  ],
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

  database.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
  const updated = database
    .query("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
    .run(versionOneChecksum);
  if (updated.changes !== 1) {
    fail("cannot establish the historical version-1 checksum");
  }
}

type TableInfoRow = { name: string; type: string };

function tableInfo(database: Database, table: string): TableInfoRow[] {
  return database.query(`PRAGMA table_info('${table}')`).all() as TableInfoRow[];
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
    if (actualColumn.type.toUpperCase() !== requiredColumn.type) {
      fail(`required table ${table} column ${requiredColumn.name} has an altered declared type`);
    }
  }
}

function assertForeignKeys(database: Database, table: string, expected: readonly ForeignKeyDefinition[]): void {
  const actual = (
    database.query(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
      table: string;
      from: string;
      to: string;
    }>
  )
    .map((foreignKey) => `${foreignKey.table}:${foreignKey.from}:${foreignKey.to}`)
    .sort();
  const required = expected.map((foreignKey) => `${foreignKey.table}:${foreignKey.from}:${foreignKey.to}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(`required foreign-key relationships are missing or altered on ${table}`);
  }
}

function normalizedSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*;\s*$/, "")
    .trim();
}

type SchemaLineage = {
  checksum: string;
  tableDefinitions: ReadonlyMap<string, string>;
  indexDefinitions: ReadonlyMap<string, string>;
};

function definitionsFromSql(sql: string, pattern: RegExp): ReadonlyMap<string, string> {
  const definitions = new Map<string, string>();
  for (const match of sql.matchAll(pattern)) {
    definitions.set(match[1], normalizedSql(match[0]));
  }
  return definitions;
}

const tableDefinitionPattern = /CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([\s\S]*?\)\s*;/gi;
const indexDefinitionPattern = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+([A-Za-z_][A-Za-z0-9_]*)\s+ON\s+[A-Za-z_][A-Za-z0-9_]*\s*\([\s\S]*?\)\s*;/gi;

const originalVersionOneLineage: SchemaLineage = {
  checksum: versionOneChecksum,
  tableDefinitions: definitionsFromSql(versionOneSql, tableDefinitionPattern),
  indexDefinitions: definitionsFromSql(versionOneSql, indexDefinitionPattern),
};

const hardenedVersionOneLineage: SchemaLineage = {
  checksum: historicalVersionOneChecksum,
  tableDefinitions: definitionsFromSql(historicalVersionOneSql, tableDefinitionPattern),
  indexDefinitions: definitionsFromSql(historicalVersionOneSql, indexDefinitionPattern),
};

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
  for (const [table, expectedSql] of lineage.tableDefinitions) {
    const actual = database
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | null;
    if (actual === null || normalizedSql(actual.sql) !== expectedSql) {
      fail(`migration 1 checksum does not match the schema lineage for table ${table}`);
    }
  }

  if (!checkIndexes) {
    return;
  }

  const actualIndexes = new Map(
    (
      database
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
        .all() as Array<{ name: string; sql: string }>
    ).map((index) => [index.name, normalizedSql(index.sql)]),
  );
  if (actualIndexes.size !== lineage.indexDefinitions.size) {
    fail("migration 1 checksum does not match the schema lineage indexes");
  }
  for (const [name, expectedSql] of lineage.indexDefinitions) {
    if (actualIndexes.get(name) !== expectedSql) {
      fail(`migration 1 checksum does not match the schema lineage index ${name}`);
    }
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

function assertRequiredSchema(database: Database): void {
  for (const [table, columns] of Object.entries(requiredTableColumns)) {
    if (!hasTable(database, table)) {
      fail(`required table is missing: ${table}`);
    }
    assertTableColumns(database, table, columns);
    assertForeignKeys(database, table, requiredForeignKeys[table]);
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
    assertLineageSchema(database, schemaLineageFor(database, true), false);
    assertRequiredSchema(database);
  });

  transaction.immediate();
}

export const migrate = runMigrations;
