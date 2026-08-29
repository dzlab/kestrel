import { expect, test } from "bun:test";
import { ValidationError } from "../src/errors";
import type { RunStatus } from "../src/protocol/types";
import { parseMessage, parseModelResponse, parseToolCall } from "../src/protocol/validation";

const terminalStatuses = [
  "completed",
  "failed",
  "blocked_on_approval",
  "budget_exhausted",
] as const satisfies readonly Exclude<RunStatus, "running">[];

test("parses a valid assistant tool call and JSON arguments", () => {
  const response = parseModelResponse({
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_123",
          name: "fs.read",
          arguments: '{"path":"README.md"}',
        },
      ],
    },
    finishReason: "tool_calls",
  });

  expect(response.message.toolCalls).toEqual([
    {
      id: "call_123",
      name: "fs.read",
      arguments: { path: "README.md" },
    },
  ]);
});

test("rejects malformed JSON tool call arguments with ValidationError", () => {
  expect(() =>
    parseToolCall({
      id: "call_123",
      name: "fs.read",
      arguments: '{"path":',
    }),
  ).toThrow(ValidationError);
});

test("rejects unknown message roles", () => {
  expect(() =>
    parseMessage({
      role: "developer",
      content: "Hello",
    }),
  ).toThrow(ValidationError);
});

test("rejects missing tool call IDs, empty names, and non-object arguments", () => {
  expect(() => parseToolCall({ name: "fs.read", arguments: {} })).toThrow(ValidationError);
  expect(() => parseToolCall({ id: "call_123", name: "", arguments: {} })).toThrow(ValidationError);
  expect(() => parseToolCall({ id: "call_123", name: "fs.read", arguments: [] })).toThrow(
    ValidationError,
  );
});

test("rejects an assistant message without content or tool calls", () => {
  expect(() => parseMessage({ role: "assistant", content: "" })).toThrow(ValidationError);
  expect(() => parseMessage({ role: "assistant", content: "   ", toolCalls: [] })).toThrow(
    ValidationError,
  );
});

test("rejects invalid model response finish reasons", () => {
  for (const finishReason of ["unknown", "", null]) {
    expect(() =>
      parseModelResponse({
        message: { role: "assistant", content: "Done" },
        finishReason,
      }),
    ).toThrow(ValidationError);
  }
});

test("rejects missing model response messages", () => {
  expect(() => parseModelResponse({ finishReason: "stop" })).toThrow(ValidationError);
});

test("rejects malformed model response messages", () => {
  expect(() =>
    parseModelResponse({
      message: { role: "assistant", content: 42 },
      finishReason: "stop",
    }),
  ).toThrow(ValidationError);
});

test("rejects malformed model response usage", () => {
  for (const usage of [null, [], "not an object"]) {
    expect(() =>
      parseModelResponse({
        message: { role: "assistant", content: "Done" },
        finishReason: "stop",
        usage,
      }),
    ).toThrow(ValidationError);
  }
});

test("rejects negative and non-finite usage token counts", () => {
  const tokenFields = ["inputTokens", "outputTokens", "totalTokens"] as const;
  const invalidTokenCounts = [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  for (const field of tokenFields) {
    for (const tokenCount of invalidTokenCounts) {
      expect(() =>
        parseModelResponse({
          message: { role: "assistant", content: "Done" },
          finishReason: "stop",
          usage: { [field]: tokenCount },
        }),
      ).toThrow(ValidationError);
    }
  }
});

test("lists every terminal run status at runtime", () => {
  expect(terminalStatuses).toHaveLength(4);
  expect(new Set(terminalStatuses)).toEqual(
    new Set(["completed", "failed", "blocked_on_approval", "budget_exhausted"]),
  );
});
