import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations";

export function openDatabase(path = ":memory:"): Database {
  const database = new Database(path);
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 250;");
    runMigrations(database);
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the migration error if closing a failed handle also fails.
    }
    throw error;
  }
}

export const createDatabase = openDatabase;
