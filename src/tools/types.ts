import type { ToolDefinition } from "../protocol/types";
import type { Repository } from "../store/repository";

export type { ToolDefinition } from "../protocol/types";

export const MAX_READ_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
export const MAX_SEARCH_MATCHES = 100;

export type ToolContext = {
  workspace: string;
  runId: string;
  repository: Repository;
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
  return {
    ...result,
    content: truncateUtf8(result.content, MAX_TOOL_OUTPUT_BYTES),
    ...(hasData ? { data: boundToolData(result.data) } : {}),
  };
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function boundArray(value: unknown[], maxBytes: number): unknown[] {
  const bounded: unknown[] = [];
  for (const item of value) {
    const candidate = boundToolData(item, Math.max(0, maxBytes - 2));
    const next = [...bounded, candidate];
    const nextBytes = jsonByteLength(next);
    if (nextBytes !== null && nextBytes <= maxBytes) {
      bounded.push(candidate);
    } else {
      break;
    }
  }
  return bounded;
}

function boundObject(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const candidate = boundToolData(value[key], Math.max(0, maxBytes - 2));
    const next = { ...bounded, [key]: candidate };
    const nextBytes = jsonByteLength(next);
    if (nextBytes !== null && nextBytes <= maxBytes) {
      bounded[key] = candidate;
    }
  }
  return bounded;
}

function boundToolData(value: unknown, maxBytes = MAX_TOOL_OUTPUT_BYTES): unknown {
  const currentBytes = jsonByteLength(value);
  if (currentBytes !== null && currentBytes <= maxBytes) return value;

  if (typeof value === "string") return truncateJsonString(value, maxBytes);
  if (Array.isArray(value)) return boundArray(value, maxBytes);
  if (typeof value === "object" && value !== null) return boundObject(value as Record<string, unknown>, maxBytes);

  return null;
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
