import type { ToolDefinition } from "../protocol/types";
import type { Repository } from "../store/repository";

export type { ToolDefinition } from "../protocol/types";

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
export const MAX_SEARCH_MATCHES = 100;

export type ToolContext = {
  workspace: string;
  runId: string;
  toolCallId?: string;
  approvalConsumed?: boolean;
  taskId?: string | null;
  userId?: string;
  repository: Repository;
  signal?: AbortSignal;
  secretPatterns?: readonly (string | RegExp)[];
};

export type ToolResult = {
  ok: boolean;
  content: string;
  data?: unknown;
  redactions?: string[];
};

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export { isTrustedBuiltInTool } from "./trust";

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function boundToolResult(result: ToolResult): ToolResult {
  const hasData = Object.prototype.hasOwnProperty.call(result, "data") && result.data !== undefined;
  const hasRedactions = Object.prototype.hasOwnProperty.call(result, "redactions") && result.redactions !== undefined;
  const fieldShareBytes = Math.floor(MAX_TOOL_OUTPUT_BYTES / (1 + Number(hasData) + Number(hasRedactions)));
  const data = hasData ? boundToolData(result.data, fieldShareBytes) : undefined;
  const redactions = hasRedactions ? boundToolData(result.redactions, fieldShareBytes) : undefined;
  return {
    ok: result.ok,
    content: boundToolContent(
      result.ok,
      result.content,
      data,
      Array.isArray(redactions) ? (redactions as string[]) : undefined,
    ),
    ...(data === undefined ? {} : { data }),
    ...(Array.isArray(redactions) ? { redactions: redactions as string[] } : {}),
  };
}

function boundToolContent(ok: boolean, value: string, data: unknown, redactions: string[] | undefined): string {
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(value, middle);
    const bytes = jsonByteLength({
      ok,
      content: candidate,
      ...(data === undefined ? {} : { data }),
      ...(redactions === undefined ? {} : { redactions }),
    });
    if (bytes !== null && bytes <= MAX_TOOL_OUTPUT_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function boundArray(value: unknown[], maxBytes: number): unknown[] | undefined {
  if (maxBytes < 2) return undefined;
  const bounded: unknown[] = [];
  for (const item of value) {
    const currentBytes = jsonByteLength(bounded) ?? 2;
    const separatorBytes = bounded.length === 0 ? 0 : 1;
    const candidate = boundToolData(item, Math.max(0, maxBytes - currentBytes - separatorBytes));
    if (candidate === undefined) break;
    const next = [...bounded, candidate];
    const nextBytes = jsonByteLength(next);
    if (nextBytes !== null && nextBytes <= maxBytes) {
      bounded.push(candidate);
    } else {
      break;
    }
  }
  return jsonByteLength(bounded) !== null && jsonByteLength(bounded)! <= maxBytes ? bounded : undefined;
}

function boundObject(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> | undefined {
  if (maxBytes < 2) return undefined;
  const bounded: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const currentBytes = jsonByteLength(bounded) ?? 2;
    const separatorBytes = Object.keys(bounded).length === 0 ? 0 : 1;
    const keyBytes = Buffer.byteLength(JSON.stringify(key), "utf8");
    const candidate = boundToolData(value[key], Math.max(0, maxBytes - currentBytes - separatorBytes - keyBytes - 1));
    if (candidate === undefined) continue;
    const next = { ...bounded, [key]: candidate };
    const nextBytes = jsonByteLength(next);
    if (nextBytes !== null && nextBytes <= maxBytes) {
      bounded[key] = candidate;
    }
  }
  return jsonByteLength(bounded) !== null && jsonByteLength(bounded)! <= maxBytes ? bounded : undefined;
}

function boundToolData(value: unknown, maxBytes: number): unknown | undefined {
  if (maxBytes < 0) return undefined;
  if (typeof value === "string") {
    const bounded = truncateJsonString(value, maxBytes);
    return jsonByteLength(bounded) !== null && jsonByteLength(bounded)! <= maxBytes ? bounded : undefined;
  }
  if (Array.isArray(value)) return boundArray(value, maxBytes);
  if (typeof value === "object" && value !== null) return boundObject(value as Record<string, unknown>, maxBytes);

  const serialized = jsonByteLength(value);
  return serialized !== null && serialized <= maxBytes ? value : undefined;
}

function truncateJsonString(value: string, maxBytes: number): string {
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(value, middle);
    const bytes = jsonByteLength(candidate);
    if (bytes !== null && bytes <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
