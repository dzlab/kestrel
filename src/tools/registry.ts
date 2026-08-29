import { ValidationError } from "../errors";
import { parseToolCall } from "../protocol/validation";
import { createFilesystemTools } from "./filesystem";
import { createSearchTool } from "./search";
import { boundToolResult } from "./types";
import type { Tool, ToolContext, ToolResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const schemaTypes = new Set(["object", "string", "number", "boolean"]);

function validateSchemaDefinition(schema: unknown, path: string): asserts schema is Record<string, unknown> {
  if (!isRecord(schema)) {
    throw new ValidationError(`${path} must be a schema object`);
  }
  if (typeof schema.type !== "string" || !schemaTypes.has(schema.type)) {
    throw new ValidationError(`${path}.type is unsupported`);
  }
  if (schema.type !== "object") return;

  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    throw new ValidationError(`${path}.properties must be an object`);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    validateSchemaDefinition(propertySchema, `${path}.properties.${key}`);
  }
    if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((field) => typeof field !== "string")) {
      throw new ValidationError(`${path}.required must contain only strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new ValidationError(`${path}.required contains duplicate fields`);
    }
    for (const field of schema.required) {
      if (!Object.hasOwn(properties, field)) {
        throw new ValidationError(`${path}.required references an unknown field ${field}`);
      }
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw new ValidationError(`${path}.additionalProperties must be a boolean`);
  }
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
        if (!Object.hasOwn(properties, key)) {
          throw new ValidationError(`${path}.${key} is not allowed`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && isRecord(propertySchema)) {
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
    if (typeof tool.definition.description !== "string" || tool.definition.description.length === 0) {
      throw new ValidationError(`tool definition description must be non-empty: ${name}`);
    }
    if (typeof tool.definition.capability !== "string" || tool.definition.capability.length === 0) {
      throw new ValidationError(`tool definition capability must be non-empty: ${name}`);
    }
    if (!isRecord(tool.definition.inputSchema) || tool.definition.inputSchema.type !== "object") {
      throw new ValidationError(`tool ${name} inputSchema must be an object schema`);
    }
    validateSchemaDefinition(tool.definition.inputSchema, `tool ${name} inputSchema`);
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
