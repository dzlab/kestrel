import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModel } from "../src/model/fake";
import { ApprovalManager } from "../src/policy/approvals";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import { ToolRegistry, createToolRegistry } from "../src/tools/registry";
import { createUpgradeTools } from "../src/upgrade/tools";
import type { ModelRequest, ModelResponse } from "../src/protocol/types";
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

class IntegratedUpgradeModel {
  readonly requests: ModelRequest[] = [];
  private proposalId: string | undefined;

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return toolCall("upgrade-call", "self.upgrade", {
        patch: "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n",
        verification: ["git", "status"],
      });
    }
    if (this.requests.length === 2) {
      const last = request.messages.at(-1);
      if (last === undefined) throw new Error("upgrade proposal result is missing");
      const parsed = JSON.parse(last.content) as { data?: { id?: string } };
      this.proposalId = parsed.data?.id;
      if (this.proposalId === undefined) throw new Error(`upgrade proposal ID is missing: ${last.content}`);
      return toolCall("apply-call", "self.apply", { proposalId: this.proposalId });
    }
    return assistant("upgrade applied");
  }
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

test("integrated self-upgrade resumes self.apply once without synthetic-call duplicate detection", async () => {
  const state = setup();
  const model = new IntegratedUpgradeModel();
  writeFileSync(join(state.workspace, "target.txt"), "old\n");
  for (const command of [
    ["git", "init"],
    ["git", "config", "user.email", "kestrel-test@example.invalid"],
    ["git", "config", "user.name", "Kestrel Test"],
    ["git", "add", "target.txt"],
    ["git", "commit", "-m", "initial"],
  ]) Bun.spawnSync(command, { cwd: state.workspace });
  const registry = new ToolRegistry(createUpgradeTools(state.approvals), { approvals: state.approvals });
  try {
    const kernel = new RunKernel({ model, repository: state.repository, registry, approvals: state.approvals });
    const paused = await kernel.run({ title: "Upgrade", prompt: "upgrade", workspace: state.workspace });
    expect(paused).toMatchObject({ status: "blocked_on_approval", approvalId: "upgrade-call" });

    state.approvals.approve("upgrade-call");
    const applyPaused = await kernel.resume(paused.runId);
    expect(applyPaused).toMatchObject({ status: "blocked_on_approval", approvalId: "apply-call" });

    state.approvals.approve("apply-call");
    const completed = await kernel.resume(paused.runId);
    expect(completed).toMatchObject({ status: "completed", answer: "upgrade applied" });
    expect(readFileSync(join(state.workspace, "target.txt"), "utf8")).toBe("new\n");
    expect(state.repository.getToolCall("apply-call")).toMatchObject({ state: "completed" });
    expect(state.repository.getEvents(paused.runId).some((event) => event.type === "run.budget_exhausted")).toBe(false);
    expect(state.repository.getToolCalls(paused.runId).filter((call) => call.name === "self.apply" && call.state === "completed")).toHaveLength(1);
  } finally {
    state.cleanup();
  }
});

test("reconciles an approval persisted before the pause state after restart", async () => {
  const state = setup(new FakeModel([assistant("reconciled")]))
  try {
    const task = state.repository.createTask({ title: "Crash", prompt: "run", workspace: state.workspace, maxSteps: 2 });
    const run = state.repository.startRun(task.id, "crash-run");
    const call = { id: "crash-shell", name: "shell.exec", arguments: { argv: ["printf", "reconciled"] } };
    state.repository.recordToolCall(run.id, call, "pending");
    state.approvals.request({ callId: call.id, runId: run.id, taskId: task.id, tool: call.name, capability: "shell", risk: "high", summary: "crash", arguments: call.arguments });

    const restarted = new RunKernel({ model: state.model, repository: state.repository, registry: state.registry, approvals: state.approvals });
    const paused = await restarted.resume(run.id);
    expect(paused.status).toBe("blocked_on_approval");
    expect(state.repository.getToolCall(call.id)).toMatchObject({ state: "awaiting_approval", finishedAt: null });
    state.approvals.approve(call.id);
    expect(await restarted.resume(run.id)).toMatchObject({ status: "completed", answer: "reconciled" });
  } finally {
    state.cleanup();
  }
});

test("persists effective run budgets and reuses them on approval restart", async () => {
  const state = setup(new FakeModel([
    toolCall("persisted-options", "shell.exec", { argv: ["printf", "ok"] }),
    assistant("done"),
  ]));
  try {
    const kernel = new RunKernel({ model: state.model, repository: state.repository, registry: state.registry, approvals: state.approvals });
    const paused = await kernel.run({ title: "Options", prompt: "run", workspace: state.workspace }, { maxTurns: 3, maxToolCalls: 4, maxTokens: 100, timeoutMs: 7_000, toolTimeoutMs: 2_000, contextBytes: 4_000, modelName: "persisted-model" });
    const row = state.database.query("SELECT options FROM runs WHERE id = ?").get(paused.runId) as { options: string };
    expect(JSON.parse(row.options)).toMatchObject({ maxTurns: 3, maxToolCalls: 4, maxTokens: 100, timeoutMs: 7_000, toolTimeoutMs: 2_000, contextBytes: 4_000, modelName: "persisted-model" });
    state.approvals.approve("persisted-options");
    expect(await kernel.resume(paused.runId, { maxTokens: 1, maxTurns: 1 })).toMatchObject({ status: "completed", answer: "done" });
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
