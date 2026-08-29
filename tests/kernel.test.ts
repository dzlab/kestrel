import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModel } from "../src/model/fake";
import { ApprovalManager } from "../src/policy/approvals";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import { createToolRegistry } from "../src/tools/registry";
import type { ModelResponse } from "../src/protocol/types";
import { RunKernel } from "../src/kernel";

function assistant(content: string): ModelResponse {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name, arguments: args }],
    },
    finishReason: "tool_calls",
  };
}

function setup(model: FakeModel = new FakeModel([assistant("default")])) {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-kernel-"));
  writeFileSync(join(workspace, "note.txt"), "bounded tool context\n");
  const database = openDatabase();
  const repository = new StoreRepository(database);
  const approvals = new ApprovalManager(repository);
  const registry = createToolRegistry({ approvals });
  const cleanup = () => {
    database.close();
    rmSync(workspace, { recursive: true, force: true });
  };
  return { workspace, database, repository, approvals, registry, model, cleanup };
}

test("runs multiple tool turns, persists messages/events, and returns the final answer", async () => {
  const state = setup();
  try {
    const model = new FakeModel([
      toolCall("list-1", "fs.list", { path: "." }),
      toolCall("read-1", "fs.read", { path: "note.txt" }),
      assistant("The note is available."),
    ]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry, modelName: "test" });

    const result = await kernel.run({ title: "Inspect note", prompt: "Read note.txt", workspace: state.workspace });

    expect(result.status).toBe("completed");
    expect(result.answer).toBe("The note is available.");
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "list-1" });
    expect(model.requests[2]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "read-1" });
    const runId = result.runId;
    expect(state.database.query("SELECT COUNT(*) AS count FROM messages WHERE run_id = ?").get(runId)).toEqual({ count: 7 });
    expect(state.database.query("SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?").get(runId)).toEqual({ count: 2 });
    expect(state.database.query("SELECT COUNT(*) AS count FROM events WHERE run_id = ?").get(runId)).toEqual({ count: 10 });
  } finally {
    state.cleanup();
  }
});

test("stops with budget_exhausted when the turn budget is reached", async () => {
  const state = setup();
  try {
    const model = new FakeModel([toolCall("list-1", "fs.list", { path: "." }), assistant("should not be called")]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry });

    const result = await kernel.run(
      { title: "Budget", prompt: "Inspect the workspace", workspace: state.workspace },
      { maxTurns: 1 },
    );

    expect(result.status).toBe("budget_exhausted");
    expect(model.requests).toHaveLength(1);
  } finally {
    state.cleanup();
  }
});

test("pauses before an approval-gated tool and resumes it exactly once", async () => {
  const state = setup();
  try {
    const model = new FakeModel([
      toolCall("shell-1", "shell.exec", { argv: ["echo", "approved"] }),
      assistant("Command approved and completed."),
    ]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry, modelName: "test" });

    const paused = await kernel.run({ title: "Run command", prompt: "Run the command", workspace: state.workspace });

    expect(paused.status).toBe("blocked_on_approval");
    expect(paused.approvalId).toBe("shell-1");
    expect(state.database.query("SELECT state, finished_at FROM tool_calls WHERE call_id = ?").get("shell-1"))
      .toMatchObject({ state: "awaiting_approval", finished_at: null });
    expect(state.approvals.get("shell-1")?.status).toBe("pending");

    state.approvals.approve("shell-1");
    const resumed = await kernel.resume(paused.runId);

    expect(resumed.status).toBe("completed");
    expect(resumed.answer).toBe("Command approved and completed.");
    expect(model.requests).toHaveLength(2);
    expect(state.database.query("SELECT state, COUNT(*) AS count FROM tool_calls WHERE call_id = ? GROUP BY state").get("shell-1"))
      .toEqual({ state: "completed", count: 1 });
  } finally {
    state.cleanup();
  }
});

test("terminates a repeated identical tool call safely", async () => {
  const state = setup();
  try {
    const model = new FakeModel([
      toolCall("list-1", "fs.list", { path: "." }),
      toolCall("list-2", "fs.list", { path: "." }),
      assistant("unreachable"),
    ]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry });

    const result = await kernel.run(
      { title: "Loop", prompt: "List repeatedly", workspace: state.workspace },
      { maxTurns: 5 },
    );

    expect(result.status).toBe("budget_exhausted");
    expect(result.error).toMatch(/repeated|duplicate/i);
    expect(model.requests).toHaveLength(2);
  } finally {
    state.cleanup();
  }
});

test("fails closed on malformed model output", async () => {
  const state = setup();
  try {
    const malformed = { message: { role: "assistant", content: "" }, finishReason: "stop" } as unknown as ModelResponse;
    const model = new FakeModel([malformed]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry });

    const result = await kernel.run({ title: "Malformed", prompt: "Answer", workspace: state.workspace });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/assistant|malformed|validation/i);
    expect(state.database.query("SELECT status FROM runs WHERE id = ?").get(result.runId)).toEqual({ status: "failed" });
  } finally {
    state.cleanup();
  }
});

test("bounds the system context and prior messages sent to the model", async () => {
  const state = setup();
  try {
    const model = new FakeModel([assistant("ok")]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry });

    const result = await kernel.run(
      { title: "Context", prompt: "x".repeat(10_000), workspace: state.workspace },
      { contextBytes: 1_200 },
    );

    expect(result.status).toBe("completed");
    const requestBytes = Buffer.byteLength(JSON.stringify(model.requests[0]), "utf8");
    expect(requestBytes).toBeLessThanOrEqual(1_200 + 4_500);
    expect(model.requests[0]?.messages).toHaveLength(2);
  } finally {
    state.cleanup();
  }
});

test("enforces maxTokens when the provider omits usage", async () => {
  const state = setup();
  try {
    const model = new FakeModel([assistant("x".repeat(10_000))]);
    const kernel = new RunKernel({ model, repository: state.repository, registry: state.registry });

    const result = await kernel.run(
      { title: "Token bound", prompt: "Answer", workspace: state.workspace },
      { maxTokens: 1 },
    );

    expect(result.status).toBe("budget_exhausted");
    expect(result.error).toMatch(/token/i);
  } finally {
    state.cleanup();
  }
});

test("cancels a pending model request and persists a distinct terminal status", async () => {
  const state = setup();
  try {
    const model = {
      async complete(request: { signal?: AbortSignal }): Promise<ModelResponse> {
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    const result = await new RunKernel({ model, repository: state.repository, registry: state.registry }).run(
      { title: "Cancel", prompt: "wait", workspace: state.workspace },
      { signal: controller.signal, timeoutMs: 5_000 },
    );

    expect(result.status).toBe("cancelled");
    expect(state.repository.getRun(result.runId)?.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    state.cleanup();
  }
});

test("derives self-targeting policy from configured source roots", async () => {
  const state = setup();
  try {
    const model = new FakeModel([{
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "self-patch",
          name: "fs.patch",
          arguments: { patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-bounded tool context\n+self change\n" },
        }],
      },
      finishReason: "tool_calls",
    }]);
    const result = await new RunKernel({
      model,
      repository: state.repository,
      registry: state.registry,
      selfPaths: [state.workspace],
    }).run({ title: "Self patch", prompt: "patch the source", workspace: state.workspace });

    expect(result.status).toBe("blocked_on_approval");
    expect(state.approvals.get("self-patch")?.status).toBe("pending");
    expect(state.repository.getEvents(result.runId).some((event) => event.type === "run.blocked_on_approval")).toBe(true);
  } finally {
    state.cleanup();
  }
});

test("cancellation aborts an active approved subprocess", async () => {
  const state = setup(new FakeModel([
    toolCall("sleep-call", "shell.exec", { argv: ["/bin/sleep", "1"], timeoutMs: 5_000 }),
    assistant("unreachable"),
  ]));
  try {
    const kernel = new RunKernel({ model: state.model, repository: state.repository, registry: state.registry });
    const paused = await kernel.run({ title: "Cancel process", prompt: "run", workspace: state.workspace });
    expect(paused).toMatchObject({ status: "blocked_on_approval" });
    state.approvals.approve("sleep-call");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    const result = await kernel.resume(paused.runId, { signal: controller.signal, timeoutMs: 5_000 });
    expect(result.status).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    state.cleanup();
  }
});
