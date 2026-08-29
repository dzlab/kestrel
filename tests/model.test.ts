import { expect, test } from "bun:test";
import { ValidationError } from "../src/errors";
import { FakeModel } from "../src/model/fake";
import { FetchImplementation, OpenAICompatibleClient } from "../src/model/openai-compatible";
import type { ModelRequest, ModelResponse } from "../src/protocol/types";

const request: ModelRequest = {
  model: "internal-model",
  messages: [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Read the file." },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_previous", name: "fs.read", arguments: { path: "README.md" } }],
    },
    { role: "tool", toolCallId: "call_previous", content: "file contents" },
  ],
  tools: [
    {
      name: "fs.read",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      capability: "filesystem.read",
    },
  ],
  temperature: 0.2,
};

const textResponse: ModelResponse = {
  message: { role: "assistant", content: "Done" },
  finishReason: "stop",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("sends normalized messages, tools, model, and conditional authorization", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchImplementation = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  };

  await new OpenAICompatibleClient({
    baseUrl: "https://example.test///",
    model: "configured-model",
    timeoutMs: 100,
    fetchImpl,
  }).complete(request);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://example.test/chat/completions");
  expect(calls[0]?.init.method).toBe("POST");
  expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
  expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
    model: "configured-model",
    temperature: 0.2,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_previous",
            type: "function",
            function: { name: "fs.read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_previous", content: "file contents" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "fs.read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  });

  const authorizedCalls: Array<{ init: RequestInit }> = [];
  const authorizedFetch: FetchImplementation = async (_input, init) => {
    authorizedCalls.push({ init: init ?? {} });
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  };

  await new OpenAICompatibleClient({
    baseUrl: "https://example.test",
    apiKey: "secret",
    model: "configured-model",
    timeoutMs: 100,
    fetchImpl: authorizedFetch,
  }).complete(request);

  expect(authorizedCalls[0]?.init.headers).toEqual({
    "content-type": "application/json",
    authorization: "Bearer secret",
  });
});

test("maps OpenAI tool calls and usage into the internal response", async () => {
  const fetchImpl: FetchImplementation = async () =>
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: { name: "fs.read", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });

  await expect(
    new OpenAICompatibleClient({
      baseUrl: "https://example.test",
      model: "configured-model",
      timeoutMs: 100,
      fetchImpl,
    }).complete(request),
  ).resolves.toEqual({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_123", name: "fs.read", arguments: { path: "README.md" } }],
    },
    finishReason: "tool_calls",
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  });
});

test("rejects malformed normalized model responses", async () => {
  const fetchImpl: FetchImplementation = async () =>
    jsonResponse({ choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] });

  await expect(
    new OpenAICompatibleClient({
      baseUrl: "https://example.test",
      model: "configured-model",
      timeoutMs: 100,
      fetchImpl,
    }).complete(request),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("rejects non-2xx responses without retrying permanent failures", async () => {
  let attempts = 0;
  const fetchImpl: FetchImplementation = async () => {
    attempts += 1;
    return jsonResponse({ error: { message: "bad request" } }, 400);
  };

  await expect(
    new OpenAICompatibleClient({
      baseUrl: "https://example.test",
      model: "configured-model",
      timeoutMs: 100,
      fetchImpl,
    }).complete(request),
  ).rejects.toThrow(/400/);
  expect(attempts).toBe(1);
});

test("does not retry an HTTP 600 response", async () => {
  let attempts = 0;
  const fetchImpl: FetchImplementation = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 600,
      text: async () => JSON.stringify({ error: { message: "unknown failure" } }),
    } as Response;
  };

  await expect(
    new OpenAICompatibleClient({
      baseUrl: "https://example.test",
      model: "configured-model",
      timeoutMs: 100,
      fetchImpl,
    }).complete(request),
  ).rejects.toThrow(/600/);
  expect(attempts).toBe(1);
});

test("retries one 429 or 5xx response before succeeding", async () => {
  for (const transientStatus of [429, 503]) {
    let attempts = 0;
    const fetchImpl: FetchImplementation = async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ error: "try again" }, transientStatus) : jsonResponse({
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
      });
    };

    await expect(
      new OpenAICompatibleClient({
        baseUrl: "https://example.test",
        model: "configured-model",
        timeoutMs: 100,
        fetchImpl,
      }).complete(request),
    ).resolves.toEqual(textResponse);
    expect(attempts).toBe(2);
  }
});

test("aborts a request that exceeds its timeout", async () => {
  let aborted = false;
  const fetchImpl: FetchImplementation = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });

  await expect(
    new OpenAICompatibleClient({
      baseUrl: "https://example.test",
      model: "configured-model",
      timeoutMs: 5,
      fetchImpl,
    }).complete(request),
  ).rejects.toBeDefined();
  expect(aborted).toBe(true);
});

test("FakeModel returns scripted responses in order and records requests", async () => {
  const secondResponse: ModelResponse = {
    message: { role: "assistant", content: "Second" },
    finishReason: "stop",
  };
  const fake = new FakeModel([textResponse, secondResponse]);

  expect(fake.remaining()).toBe(2);
  await expect(fake.complete(request)).resolves.toEqual(textResponse);
  await expect(fake.complete({ ...request, messages: [{ role: "user", content: "Next" }] })).resolves.toEqual(
    secondResponse,
  );
  expect(fake.remaining()).toBe(0);
  expect(fake.requests).toEqual([request, { ...request, messages: [{ role: "user", content: "Next" }] }]);
  await expect(fake.complete(request)).rejects.toThrow(/exhausted/);
});
