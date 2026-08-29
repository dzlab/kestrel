import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors";
import { openDatabase } from "./store/database";
import type { Database } from "bun:sqlite";

export const DEFAULT_DATA_DIR = join(homedir(), ".kestrel");
export const DEFAULT_MODEL_NAME = "kestrel";
export const DEFAULT_MODEL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOOL_CALLS = 24;
export const DEFAULT_MAX_TOKENS = 32_000;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_CONTEXT_BYTES = 32 * 1024;

export type KestrelConfig = {
  dataDir: string;
  databasePath: string;
  workspace: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelName: string;
  modelTimeoutMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxTokens: number;
  runTimeoutMs: number;
  toolTimeoutMs: number;
  contextBytes: number;
};

function absolutePath(value: string, base: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) throw new ValidationError(`${name} must be a non-empty path`);
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

export function ensureDataDirectory(path = DEFAULT_DATA_DIR): string {
  const directory = resolve(path);
  if (directory === parse(directory).root) throw new ValidationError("Kestrel data directory cannot be the filesystem root");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ValidationError("Kestrel data directory must be a real directory");
  chmodSync(directory, 0o700);
  return directory;
}

export function resolveDatabasePath(requested: string | undefined, dataDir = DEFAULT_DATA_DIR): string {
  const directory = resolve(dataDir);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new ValidationError("Kestrel data directory cannot be a symlink");
  }
  const value = requested?.trim();
  if (value === ":memory:") throw new ValidationError("CLI persistence cannot use an in-memory database");
  const databasePath = absolutePath(value === undefined || value.length === 0 ? "kestrel.sqlite" : value, directory, "database path");
  if (databasePath === parse(databasePath).root) throw new ValidationError("database path must name a file");
  rejectSymlinkAncestors(databasePath, directory);
  if (existsSync(databasePath)) {
    const stats = lstatSync(databasePath);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new ValidationError("database path must be a regular, non-symlink file");
  }
  return databasePath;
}

function rejectSymlinkAncestors(path: string, dataDir: string): void {
  const requestedRelative = relative(dataDir, path);
  const isUnderDataDir = requestedRelative === "" || (!requestedRelative.startsWith(`..${sep}`) && requestedRelative !== ".." && !isAbsolute(requestedRelative));
  const boundary = isUnderDataDir ? dataDir : parse(path).root;
  let current = path;
  while (current !== boundary) {
    try {
      if (lstatSync(current).isSymbolicLink() && dirname(current) !== parse(current).root) {
        throw new ValidationError("database path cannot traverse a symlink");
      }
    } catch (error) {
      if (error instanceof ValidationError) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    // macOS commonly exposes /var through a root-level symlink to /private/var.
    // It is outside the configured file path and is safe to traverse here.
    current = parent;
  }
}

function numericEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum?: number): number {
  const value = env[key];
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    throw new ValidationError(`${key} must be a positive integer${maximum === undefined ? "" : ` no greater than ${maximum}`}`);
  }
  return parsed;
}

function modelUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch (error) {
    throw new ValidationError(`KESTREL_MODEL_BASE_URL must be an http(s) URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value.replace(/\/+$/u, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KestrelConfig {
  const dataDir = ensureDataDirectory(env.KESTREL_DATA_DIR ?? DEFAULT_DATA_DIR);
  const workspace = absolutePath(env.KESTREL_WORKSPACE ?? cwd, cwd, "workspace");
  const modelName = env.KESTREL_MODEL_NAME?.trim() || DEFAULT_MODEL_NAME;
  return {
    dataDir,
    databasePath: resolveDatabasePath(env.KESTREL_DB, dataDir),
    workspace,
    modelBaseUrl: modelUrl(env.KESTREL_MODEL_BASE_URL),
    ...(env.KESTREL_MODEL_API_KEY === undefined ? {} : { modelApiKey: env.KESTREL_MODEL_API_KEY }),
    modelName,
    modelTimeoutMs: numericEnv(env, "KESTREL_MODEL_TIMEOUT_MS", DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
    maxTurns: numericEnv(env, "KESTREL_MAX_TURNS", DEFAULT_MAX_TURNS),
    maxToolCalls: numericEnv(env, "KESTREL_MAX_TOOL_CALLS", DEFAULT_MAX_TOOL_CALLS),
    maxTokens: numericEnv(env, "KESTREL_MAX_TOKENS", DEFAULT_MAX_TOKENS),
    runTimeoutMs: numericEnv(env, "KESTREL_RUN_TIMEOUT_MS", DEFAULT_RUN_TIMEOUT_MS),
    toolTimeoutMs: numericEnv(env, "KESTREL_TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS, DEFAULT_RUN_TIMEOUT_MS),
    contextBytes: numericEnv(env, "KESTREL_CONTEXT_BYTES", DEFAULT_CONTEXT_BYTES),
  };
}

export function openConfiguredDatabase(config: Pick<KestrelConfig, "dataDir" | "databasePath">): Database {
  const dataDir = ensureDataDirectory(config.dataDir);
  const databasePath = resolveDatabasePath(config.databasePath, dataDir);
  const parent = dirname(databasePath);
  const dataRelative = relative(dataDir, parent);
  if (dataRelative === "" || (!dataRelative.startsWith(`..${sep}`) && dataRelative !== ".." && !isAbsolute(dataRelative))) {
    ensureDataDirectory(parent);
  } else {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const database = openDatabase(databasePath);
  chmodSync(databasePath, 0o600);
  return database;
}
