import { ValidationError } from "../errors";
import { parseModelResponse } from "../protocol/validation";
import type { Message, ModelRequest, ModelResponse } from "../protocol/types";
import type { ModelClient } from "./client";

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 50;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 200;
const RESPONSE_BODY_TOO_LARGE_ERROR = `model response body exceeds the maximum size of ${MAX_RESPONSE_BODY_BYTES} bytes`;

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

function delayWithSignal(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      reject(signal?.reason ?? new Error("model request cancelled"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function discardResponseBody(response: Response): Promise<void> {
  const body = response.body;
  if (body !== null && body !== undefined) {
    await body.cancel();
    return;
  }

  await response.text();
}

async function readResponseBody(response: Response): Promise<string> {
  const body = response.body;
  if (body === null || body === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(RESPONSE_BODY_TOO_LARGE_ERROR);
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = value ?? new Uint8Array();
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the useful size-limit error if cancellation also fails.
        }
        throw new Error(RESPONSE_BODY_TOO_LARGE_ERROR);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function capErrorText(text: string): string {
  return text.length > MAX_ERROR_DETAIL_LENGTH ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}…` : text;
}

function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return capErrorText(parsed.error.message);
    }
  } catch {
    // The status is the useful diagnostic when the error body is not JSON.
  }

  return capErrorText(body);
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
      const onAbort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) onAbort();
      else request.signal?.addEventListener("abort", onAbort, { once: true });
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
            await discardResponseBody(response);
            await delayWithSignal(Math.min(RETRY_DELAY_MS, Math.max(0, this.timeoutMs)), request.signal);
            continue;
          }

          const responseBody = await readResponseBody(response);
          throw new Error(
            `model request failed with status ${response.status}: ${errorDetail(responseBody)}`,
          );
        }

        const responseBody = await readResponseBody(response);
        let providerResponse: unknown;
        try {
          providerResponse = JSON.parse(responseBody) as unknown;
        } catch (error) {
          throw new ValidationError("model response body must be valid JSON", { cause: error });
        }

        return parseModelResponse(normalizeResponse(providerResponse));
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      }
    }

    throw new Error("model request retry limit exceeded");
  }
}
