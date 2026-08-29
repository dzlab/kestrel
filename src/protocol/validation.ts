import { ValidationError } from "../errors";
import type { Message, ModelResponse, Role, ToolCall } from "./types";

const roles: readonly Role[] = ["system", "user", "assistant", "tool"];
const finishReasons: readonly ModelResponse["finishReason"][] = [
  "stop",
  "tool_calls",
  "length",
  "error",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }

  return value;
}

function parseArguments(value: unknown): Record<string, unknown> {
  let parsed = value;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ValidationError("tool call arguments must be valid JSON", { cause: error });
    }
  }

  if (!isRecord(parsed)) {
    throw new ValidationError("tool call arguments must be a JSON object");
  }

  return parsed;
}

export function parseToolCall(input: unknown): ToolCall {
  if (!isRecord(input)) {
    throw new ValidationError("tool call must be an object");
  }

  return {
    id: requiredString(input.id, "tool call id"),
    name: requiredString(input.name, "tool call name"),
    arguments: parseArguments(input.arguments),
  };
}

export function parseMessage(input: unknown): Message {
  if (!isRecord(input)) {
    throw new ValidationError("message must be an object");
  }

  if (typeof input.role !== "string" || !roles.includes(input.role as Role)) {
    throw new ValidationError("message role is invalid");
  }
  const role = input.role as Role;

  if (typeof input.content !== "string") {
    throw new ValidationError("message content must be a string");
  }

  let toolCalls: ToolCall[] | undefined;
  if (input.toolCalls !== undefined) {
    if (!Array.isArray(input.toolCalls)) {
      throw new ValidationError("message toolCalls must be an array");
    }
    toolCalls = input.toolCalls.map(parseToolCall);
  }

  let toolCallId: string | undefined;
  if (input.toolCallId !== undefined) {
    toolCallId = requiredString(input.toolCallId, "message tool call id");
  }

  if (
    role === "assistant" &&
    input.content.trim().length === 0 &&
    (toolCalls === undefined || toolCalls.length === 0)
  ) {
    throw new ValidationError("assistant message must contain content or tool calls");
  }

  return {
    role,
    content: input.content,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function parseUsage(value: unknown): ModelResponse["usage"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ValidationError("response usage must be an object");
  }

  const usage: NonNullable<ModelResponse["usage"]> = {};
  for (const field of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const tokenCount = value[field];
    if (tokenCount !== undefined) {
      if (typeof tokenCount !== "number" || !Number.isFinite(tokenCount) || tokenCount < 0) {
        throw new ValidationError(`usage ${field} must be a non-negative number`);
      }
      usage[field] = tokenCount;
    }
  }

  return usage;
}

export function parseModelResponse(input: unknown): ModelResponse {
  if (!isRecord(input)) {
    throw new ValidationError("model response must be an object");
  }
  if (
    typeof input.finishReason !== "string" ||
    !finishReasons.includes(input.finishReason as ModelResponse["finishReason"])
  ) {
    throw new ValidationError("model response finish reason is invalid");
  }
  const finishReason = input.finishReason as ModelResponse["finishReason"];

  return {
    message: parseMessage(input.message),
    finishReason,
    ...(input.usage === undefined ? {} : { usage: parseUsage(input.usage) }),
  };
}
