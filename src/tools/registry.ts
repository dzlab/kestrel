import { ValidationError } from "../errors";
import { parseToolCall } from "../protocol/validation";
import { createFilesystemTools } from "./filesystem";
import { createSearchTool } from "./search";
import { boundToolResult } from "./types";
import type { Tool, ToolContext, ToolResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchema(value: unknown, schema: Record<string, unknown>, path: string): void {
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!isRecord(value)) {
      throw new ValidationError(`${path} must be an object`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const field of required) {
      if (typeof field !== "string" || value[field] === undefined) {
        throw new ValidationError(`${path}.${String(field)} is required`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new ValidationError(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined && isRecord(propertySchema)) {
        validateSchema(value[key], propertySchema, `${path}.${key}`);
      }
    }
    return;
  }

  if (schemaType === "string" && typeof value !== "string") {
    throw new ValidationError(`${path} must be a string`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new ValidationError(`${path} must be a finite number`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new ValidationError(`${path} must be a boolean`);
  }
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, content: message };
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = [...createFilesystemTools(), createSearchTool()]) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: Tool): void {
    const name = tool.definition.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new ValidationError("tool definition name must be non-empty");
    }
    if (this.tools.has(name)) {
      throw new ValidationError(`duplicate tool definition: ${name}`);
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  definitions(): Tool["definition"][] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const call = parseToolCall(input);
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      throw new ValidationError(`unknown tool: ${call.name}`);
    }
    validateSchema(call.arguments, tool.definition.inputSchema, "arguments");
    try {
      return boundToolResult(await tool.execute(call.arguments, context));
    } catch (error) {
      return boundToolResult(failure(error));
    }
  }

  dispatch(input: unknown, context: ToolContext): Promise<ToolResult> {
    return this.execute(input, context);
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

export { ToolRegistry as Registry };
