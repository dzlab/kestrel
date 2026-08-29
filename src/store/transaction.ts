import type { Database } from "bun:sqlite";

const MAX_TRANSACTION_ATTEMPTS = 4;

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "SQLITE_BUSY" || /SQLITE_BUSY|database is locked/i.test(String(candidate.message));
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Run a multi-statement write transaction with one bounded busy-retry policy. */
export function immediateTransaction<T>(database: Database, callback: () => T): T {
  let delay = 1;
  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return database.transaction(callback).immediate();
    } catch (error) {
      if (!isBusyError(error) || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
        throw error;
      }
      pause(delay);
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}
