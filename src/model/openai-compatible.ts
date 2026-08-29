import { ValidationError } from "../errors";
import { parseModelResponse } from "../protocol/validation";
import type { Message, ModelRequest, ModelResponse } from "../protocol/types";
import type { ModelClient } from "./client";

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 50;

export type OpenAICompatibleClientOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: FetchImplementation;
};

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMessage(message: Message): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };

  if (message.toolCalls !== undefined) {
    normalized.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    }));
  }

  if (message.toolCallId !== undefined) {
    normalized.tool_call_id = message.toolCallId;
  }

  return normalized;
}

function normalizeToolDefinition(tool: ModelRequest["tools"][number]): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function normalizedToolCall(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const functionCall = isRecord(input.function) ? input.function : undefined;
  return {
    id: input.id,
    name: functionCall?.name,
    arguments: functionCall?.arguments,
  };
}

function normalizeUsage(input: unknown): unknown {
  if (input === undefined || !isRecord(input)) {
    return input;
  }

  return {
    inputTokens: input.prompt_tokens,
    outputTokens: input.completion_tokens,
    totalTokens: input.total_tokens,
  };
}

function normalizeResponse(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const choices = Array.isArray(input.choices) ? input.choices : undefined;
  const choice = choices?.[0];
  const choiceRecord = isRecord(choice) ? choice : undefined;
  const providerMessage = isRecord(choiceRecord?.message) ? choiceRecord.message : undefined;
  const normalizedMessage = providerMessage
    ? {
        role: providerMessage.role,
        content: providerMessage.content === null ? "" : providerMessage.content,
        ...(providerMessage.tool_calls === undefined
          ? {}
          : {
              toolCalls: Array.isArray(providerMessage.tool_calls)
                ? providerMessage.tool_calls.map(normalizedToolCall)
                : providerMessage.tool_calls,
            }),
      }
    : undefined;

  return {
    message: normalizedMessage,
    finishReason: choiceRecord?.finish_reason,
    ...(input.usage === undefined ? {} : { usage: normalizeUsage(input.usage) }),
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // The status is the useful diagnostic when the error body is not JSON.
  }

  return body.slice(0, 200);
}

export class OpenAICompatibleClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: OpenAICompatibleClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== undefined && this.apiKey.length > 0) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(normalizeMessage),
      tools: request.tools.map(normalizeToolDefinition),
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, Math.min(RETRY_DELAY_MS, Math.max(0, this.timeoutMs))),
            );
            continue;
          }

          const responseBody = await response.text();
          throw new Error(
            `model request failed with status ${response.status}: ${errorDetail(responseBody)}`,
          );
        }

        let providerResponse: unknown;
        try {
          providerResponse = (await response.json()) as unknown;
        } catch (error) {
          throw new ValidationError("model response body must be valid JSON", { cause: error });
        }

        return parseModelResponse(normalizeResponse(providerResponse));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("model request retry limit exceeded");
  }
}
