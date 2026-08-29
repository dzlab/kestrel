import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations";

export function openDatabase(path = ":memory:"): Database {
  const database = new Database(path);
  database.exec("PRAGMA foreign_keys = ON;");
  runMigrations(database);
  return database;
}

export const createDatabase = openDatabase;
