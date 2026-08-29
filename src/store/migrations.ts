import type { Database } from "bun:sqlite";

type Migration = {
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
    `,
  },
];

export function runMigrations(database: Database): void {
  const transaction = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set(
      (database.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }

      database.exec(migration.sql);
      database
        .query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
    }
  });

  transaction();
}

export const migrate = runMigrations;
