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
  return {
    ...result,
    content: truncateUtf8(result.content, MAX_TOOL_OUTPUT_BYTES),
  };
}
