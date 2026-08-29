import { createHash } from "node:crypto";
import { ValidationError } from "../errors";
import type { MemoryRecord as PersistedMemoryRecord, MemorySearchOptions, StoreRepository } from "../store/repository";
import type { MemoryRecord, MemorySaveInput, MemorySearchInput } from "./types";

export const DEFAULT_MEMORY_RESULTS = 20;
export const MAX_MEMORY_RESULTS = 100;
export const DEFAULT_MEMORY_BYTES = 16 * 1024;
export const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_MEMORY_CONTENT_BYTES = 16 * 1024;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_BYTES = 128;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function memoryId(input: MemorySaveInput, tags: string[]): string {
  if (input.id !== undefined) return input.id;
  return `memory-${createHash("sha256").update(canonical({
    scope: input.scope,
    userId: input.userId,
    taskId: input.taskId,
    content: input.content,
    tags,
    source: input.source,
    sourceTaskId: input.sourceTaskId,
  })).digest("hex")}`;
}

function normalizeTags(tags: readonly string[]): string[] {
  if (tags.length > MAX_MEMORY_TAGS) throw new ValidationError(`memory tags cannot exceed ${MAX_MEMORY_TAGS} items`);
  const normalized = tags.map((tag) => {
    if (typeof tag !== "string" || tag.trim().length === 0) throw new ValidationError("memory tags must be non-empty strings");
    if (Buffer.byteLength(tag, "utf8") > MAX_MEMORY_TAG_BYTES) throw new ValidationError("memory tag is too large");
    return tag.trim().toLocaleLowerCase("en-US");
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function validateCommon(input: MemorySaveInput): string[] {
  if (input.scope !== "user" && input.scope !== "task") throw new ValidationError("memory scope must be user or task");
  if (input.userId.trim().length === 0) throw new ValidationError("memory user id must be non-empty");
  if (input.scope === "task" && (input.taskId === null || input.taskId.trim().length === 0)) {
    throw new ValidationError("task-scoped memory requires a task id");
  }
  if (input.content.trim().length === 0) throw new ValidationError("memory content must be non-empty");
  if (Buffer.byteLength(input.content, "utf8") > MAX_MEMORY_CONTENT_BYTES) throw new ValidationError("memory content is too large");
  if (input.source.trim().length === 0) throw new ValidationError("memory source must be non-empty");
  if (input.sourceTaskId.trim().length === 0) throw new ValidationError("memory source task id must be non-empty");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new ValidationError("memory confidence must be between 0 and 1");
  }
  if (input.expiresAt !== undefined && input.expiresAt !== null && (!Number.isFinite(input.expiresAt) || input.expiresAt < 0)) {
    throw new ValidationError("memory expiry must be a non-negative timestamp");
  }
  return normalizeTags(input.tags);
}

function fromPersisted(record: PersistedMemoryRecord): MemoryRecord {
  if (record.scope !== "user" && record.scope !== "task") throw new ValidationError("persisted memory has an invalid scope");
  return {
    id: record.id,
    scope: record.scope,
    userId: record.userId ?? "legacy",
    taskId: record.taskId ?? null,
    content: record.content,
    tags: record.tags ?? [],
    source: record.source ?? record.taskId ?? "legacy",
    sourceTaskId: record.sourceTaskId ?? "legacy",
    confidence: record.confidence ?? 0,
    runId: record.sourceRunId ?? record.runId ?? null,
    createdAt: record.createdAt ?? 0,
    updatedAt: record.updatedAt ?? 0,
    expiresAt: record.expiresAt ?? null,
  };
}

export class MemoryStore {
  constructor(private readonly repository: StoreRepository, private readonly clock: () => number = () => Date.now()) {}

  save(input: MemorySaveInput): MemoryRecord {
    const now = input.now ?? this.clock();
    const tags = validateCommon(input);
    if (this.repository.getTask(input.sourceTaskId) === null) {
      throw new ValidationError("memory source task was not found");
    }
    const id = memoryId(input, tags);
    const persisted: PersistedMemoryRecord = {
      id,
      kind: "fact",
      content: input.content,
      taskId: input.taskId,
      runId: input.runId,
      metadata: {},
      confidence: input.confidence,
      createdAt: now,
      updatedAt: now,
      scope: input.scope,
      userId: input.userId,
      tags,
      source: input.source,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.runId,
      expiresAt: input.expiresAt ?? null,
    };
    this.repository.saveMemory(persisted);
    return fromPersisted(this.repository.getMemory(id) ?? persisted);
  }

  search(input: MemorySearchInput): MemoryRecord[] {
    if (input.userId.trim().length === 0) throw new ValidationError("memory user id must be non-empty");
    if (input.scope === "task" && (input.taskId === null || input.taskId.trim().length === 0)) {
      throw new ValidationError("task-scoped memory search requires a task id");
    }
    const maxResults = input.maxResults ?? DEFAULT_MEMORY_RESULTS;
    const maxBytes = input.maxBytes ?? DEFAULT_MEMORY_BYTES;
    if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > MAX_MEMORY_RESULTS) throw new ValidationError(`memory max results must be between 1 and ${MAX_MEMORY_RESULTS}`);
    if (!Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_MEMORY_BYTES) throw new ValidationError(`memory max bytes must be between 2 and ${MAX_MEMORY_BYTES}`);
    const options: MemorySearchOptions = {
      scope: input.scope,
      userId: input.userId,
      taskId: input.taskId,
      now: input.now ?? this.clock(),
      maxBytes,
    };
    return this.repository.searchMemories(input.query, maxResults, options).map(fromPersisted);
  }
}
