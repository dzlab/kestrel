import { ValidationError } from "../errors";
import { MemoryStore } from "./store";
import { assertSafeMemory } from "./security";
import type { MemoryScope } from "./types";
import { registerTrustedBuiltInTool } from "../tools/types";
import type { Tool, ToolContext, ToolResult } from "../tools/types";

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new ValidationError(`${name} must be a string`);
  return value;
}

function scopeArgument(args: Record<string, unknown>): MemoryScope {
  const value = args.scope ?? "task";
  if (value !== "user" && value !== "task") throw new ValidationError("scope must be user or task");
  return value;
}

function tagsArgument(args: Record<string, unknown>): string[] {
  const value = args.tags ?? [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) throw new ValidationError("tags must be an array of strings");
  return value;
}

const saveTool: Tool = registerTrustedBuiltInTool({
  definition: {
    name: "memory.save",
    description: "Save an explicitly supplied, bounded fact or decision in the current user/task namespace.",
    capability: "memory",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        scope: { type: "string" },
        expiresAt: { type: "number" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const content = stringArgument(args, "content");
    const tags = tagsArgument(args);
    assertSafeMemory(content, tags, context.secretPatterns ?? []);
    const scope = scopeArgument(args);
    const userId = context.userId ?? "local";
    const taskId = context.taskId ?? null;
    const record = new MemoryStore(context.repository).save({
      scope,
      userId,
      taskId: scope === "task" ? taskId : null,
      content,
      tags,
      source: taskId ?? "interactive",
      runId: context.runId,
      expiresAt: args.expiresAt === undefined ? null : (args.expiresAt as number),
    });
    return { ok: true, content: JSON.stringify({ saved: true, id: record.id }), data: record };
  },
});

const searchTool: Tool = registerTrustedBuiltInTool({
  definition: {
    name: "memory.search",
    description: "Search bounded untrusted memory records in the current user/task namespace.",
    capability: "memory",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        scope: { type: "string" },
        maxResults: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = stringArgument(args, "query");
    const recordScope = args.scope === undefined ? undefined : scopeArgument(args);
    const records = new MemoryStore(context.repository).search({
      query,
      scope: recordScope,
      userId: context.userId ?? "local",
      taskId: context.taskId ?? null,
      maxResults: args.maxResults as number | undefined,
      maxBytes: args.maxBytes as number | undefined,
    });
    const data = { untrusted: true, records };
    return { ok: true, content: JSON.stringify(data), data };
  },
});

export function createMemoryTools(): Tool[] {
  return [saveTool, searchTool];
}

export { saveTool, searchTool };
