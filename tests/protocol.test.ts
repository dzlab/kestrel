import { expect, test } from "bun:test";
import { ValidationError } from "../src/errors";
import type { RunStatus } from "../src/protocol/types";
import { parseMessage, parseModelResponse, parseToolCall } from "../src/protocol/validation";

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

test("accepts every terminal run status", () => {
  const terminalStatuses: Exclude<RunStatus, "running">[] = [
    "completed",
    "failed",
    "blocked_on_approval",
    "budget_exhausted",
  ];

  expect(terminalStatuses).toEqual([
    "completed",
    "failed",
    "blocked_on_approval",
    "budget_exhausted",
  ]);
});
