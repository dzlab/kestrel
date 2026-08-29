import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import { PolicyEngine, hashToolCall } from "../src/policy/rules";
import { ApprovalManager } from "../src/policy/approvals";
import type { PolicyContext } from "../src/policy/types";
import type { ToolDefinition } from "../src/protocol/types";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function definition(name: string, capability: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    capability,
    inputSchema: objectSchema(properties, required),
  };
}

function context(workspace: string, now = Date.now()): PolicyContext {
  return { workspace, runId: "run-policy", taskId: "task-policy", now };
}

test("classifies reads as automatic and workspace writes as logged automatic", () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-"));
  try {
    const engine = new PolicyEngine();
    const read = engine.evaluate(
      definition("fs.read", "filesystem", { path: { type: "string" } }, ["path"]),
      { path: "notes.txt" },
      context(workspace),
    );
    const list = engine.evaluate(
      definition("fs.list", "filesystem", { path: { type: "string" } }, ["path"]),
      { path: "." },
      context(workspace),
    );
    const search = engine.evaluate(
      definition("search.text", "filesystem", { query: { type: "string" } }, ["query"]),
      { query: "needle" },
      context(workspace),
    );
    const write = engine.evaluate(
      definition("fs.write", "filesystem", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      { path: "notes.txt", content: "updated" },
      context(workspace),
    );

    expect(read).toMatchObject({ allowed: true, requiresApproval: false, risk: "low", capability: "filesystem" });
    expect(list).toMatchObject({ allowed: true, requiresApproval: false, risk: "low" });
    expect(search).toMatchObject({ allowed: true, requiresApproval: false, risk: "low" });
    expect(write).toMatchObject({ allowed: true, requiresApproval: false, risk: "standard" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires approval for shell, network, credentials, destructive, external, and self-modifying operations", () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-"));
  try {
    const engine = new PolicyEngine();
    const cases = [
      [definition("shell.exec", "shell", { command: { type: "string" } }, ["command"]), { command: "printf safe" }],
      [definition("shell.exec", "shell", { command: { type: "string" } }, ["command"]), { command: "curl https://example.com" }],
      [definition("credentials.read", "credentials", { name: { type: "string" } }, ["name"]), { name: "API_KEY" }],
      [definition("package.install", "package-management", { package: { type: "string" } }, ["package"]), { package: "example" }],
      [definition("fs.delete", "destructive", { path: { type: "string" }, recursive: { type: "boolean" } }, ["path", "recursive"]), { path: "tmp", recursive: true }],
      [definition("self.modify", "self-modification", { path: { type: "string" } }, ["path"]), { path: "src/index.ts" }],
      [definition("fs.read", "filesystem", { path: { type: "string" } }, ["path"]), { path: "/tmp/outside.txt" }],
    ] as const;

    for (const [tool, args] of cases) {
      expect(engine.evaluate(tool, args, context(workspace))).toMatchObject({
        allowed: false,
        requiresApproval: true,
        risk: "high",
      });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validates arguments and capability metadata before classification", () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-"));
  try {
    const engine = new PolicyEngine();
    expect(engine.evaluate(
      definition("fs.read", "filesystem", { path: { type: "string" } }, ["path"]),
      { path: 42 },
      context(workspace),
    )).toMatchObject({ allowed: false, requiresApproval: false });
    expect(engine.evaluate(
      definition("fs.read", "not-filesystem", { path: { type: "string" } }, ["path"]),
      { path: "notes.txt" },
      context(workspace),
    )).toMatchObject({ allowed: false, requiresApproval: false });
    expect(engine.evaluate(
      definition("fs.read", "filesystem", { path: { type: "string" } }, ["path"]),
      { path: "../outside.txt" },
      context(workspace),
    )).toMatchObject({ allowed: false, requiresApproval: true, risk: "high" });
    expect(engine.evaluate(
      definition("fs.read", "filesystem", { path: { type: "string" } }, ["path"]),
      { path: "notes.txt" },
      { runId: "run-policy", now: Date.now() },
    )).toMatchObject({ allowed: false, requiresApproval: false });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("unknown tools fail closed and self-modification cannot be disguised by its description", () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-"));
  try {
    const engine = new PolicyEngine();
    const unknown = definition("new.tool", "filesystem", { path: { type: "string" } }, ["path"]);
    const disguised = {
      ...definition("self.modify", "self-modification", { path: { type: "string" } }, ["path"]),
      description: "Read a harmless file",
    };

    expect(engine.evaluate(unknown, { path: "notes.txt" }, context(workspace))).toMatchObject({
      allowed: false,
      requiresApproval: false,
    });
    expect(engine.evaluate(disguised, { path: "src/index.ts" }, context(workspace))).toMatchObject({
      allowed: false,
      requiresApproval: true,
      risk: "high",
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("classifies parsed patch deletion as destructive and configured self targets as self-modifying", () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-patch-"));
  try {
    const engine = new PolicyEngine();
    const patch = definition("fs.patch", "filesystem", { patch: { type: "string" } }, ["patch"]);
    const deletion = engine.evaluate(
      patch,
      { patch: "--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove\n" },
      context(workspace),
    );
    expect(deletion).toMatchObject({ allowed: false, requiresApproval: true, risk: "high", capability: "destructive" });

    const selfTarget = engine.evaluate(
      patch,
      { patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      { ...context(workspace), selfPaths: ["src/index.ts"] },
    );
    expect(selfTarget).toMatchObject({ allowed: false, requiresApproval: true, risk: "high", capability: "self-modification" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("approval lifecycle is durable, exact, expiring, and one-shot", () => {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-approval-"));
  const path = join(directory, "approvals.sqlite");
  const firstDatabase = openDatabase(path);
  const firstRepository = new StoreRepository(firstDatabase);
  const task = firstRepository.createTask({
    title: "Policy approval",
    prompt: "Test approval persistence",
    workspace: directory,
    maxSteps: 3,
  });
  const run = firstRepository.startRun(task.id, "policy-run");
  let now = 10_000;
  const manager = new ApprovalManager(firstRepository, { now: () => now, defaultExpiryMs: 100 });
  const request = manager.request({
    id: "call-approval",
    runId: run.id,
    taskId: task.id,
    tool: "shell.exec",
    capability: "shell",
    risk: "high",
    summary: "Run a shell command",
    arguments: { command: "printf safe" },
  });

  expect(request).toMatchObject({
    id: "call-approval",
    runId: run.id,
    tool: "shell.exec",
    risk: "high",
    summary: "Run a shell command",
    createdAt: 10_000,
    expiresAt: 10_100,
    status: "pending",
  });
  expect(manager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(false);
  expect(manager.approve(request.id).status).toBe("approved");
  expect(manager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(true);
  expect(manager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf changed" } })).toBe(false);
  expect(manager.consume(request.id, { command: "printf safe" })).toBe(true);
  expect(manager.consume(request.id, { command: "printf safe" })).toBe(false);

  const denied = manager.request({
    id: "call-denied",
    runId: run.id,
    taskId: task.id,
    tool: "shell.exec",
    capability: "shell",
    risk: "high",
    summary: "Run a denied shell command",
    arguments: { command: "printf denied" },
  });
  expect(manager.deny(denied.id).status).toBe("denied");
  expect(manager.isApproved({ id: denied.id, tool: denied.tool, arguments: { command: "printf denied" } })).toBe(false);

  firstDatabase.close();
  const secondDatabase = openDatabase(path);
  const secondManager = new ApprovalManager(new StoreRepository(secondDatabase), { now: () => now, defaultExpiryMs: 100 });
  expect(secondManager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(false);
  now = 10_101;
  expect(secondManager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(false);
  expect(secondManager.get(request.id)?.status).toBe("consumed");

  secondDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});

test("approval hashes include the complete tool name and canonical argument order", () => {
  expect(hashToolCall("fs.read", { b: 2, a: 1 })).toBe(hashToolCall("fs.read", { a: 1, b: 2 }));
  expect(hashToolCall("fs.read", { path: "notes.txt" })).not.toBe(hashToolCall("search.text", { path: "notes.txt" }));
});

test("approval state, exact expiry, id-only decisions, one-shot consume, and audit events survive restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-approval-restart-"));
  const path = join(directory, "approvals.sqlite");
  let firstDatabase = openDatabase(path);
  let firstRepository = new StoreRepository(firstDatabase);
  const task = firstRepository.createTask({ title: "approval", prompt: "approval", workspace: directory, maxSteps: 1 });
  const run = firstRepository.startRun(task.id, "approval-run");
  let now = 1_000;
  const input = {
    callId: "restart-call",
    runId: run.id,
    taskId: task.id,
    tool: "shell.exec",
    capability: "shell",
    risk: "high" as const,
    summary: "restart shell",
    arguments: { command: "printf restart" },
    createdAt: now,
    expiresAt: 1_234,
  };
  const first = new ApprovalManager(firstRepository, { now: () => now });
  first.request(input);
  firstDatabase.close();

  firstDatabase = openDatabase(path);
  firstRepository = new StoreRepository(firstDatabase);
  const restarted = new ApprovalManager(firstRepository, { now: () => now });
  expect(restarted.get(input.callId)).toMatchObject({ expiresAt: 1_234, status: "pending", tool: "shell.exec" });
  expect(restarted.approve(input.callId, 1_001).status).toBe("approved");

  const secondDatabase = openDatabase(path);
  const second = new ApprovalManager(new StoreRepository(secondDatabase), { now: () => now });
  const lookup = { id: input.callId, tool: input.tool, arguments: input.arguments };
  expect(second.consume(lookup)).toBe(true);
  expect(restarted.consume(lookup)).toBe(false);

  const expiredInput = { ...input, callId: "expired-call", expiresAt: 2_000, arguments: { command: "printf expired" } };
  restarted.request(expiredInput);
  now = 2_001;
  expect(second.get(expiredInput.callId)?.status).toBe("expired");

  const deniedInput = { ...input, callId: "denied-call", expiresAt: 3_000, arguments: { command: "printf denied" } };
  restarted.request(deniedInput);
  expect(second.deny(deniedInput.callId, 2_002).status).toBe("denied");

  const events = secondDatabase.query(
    "SELECT type FROM events WHERE run_id = ? ORDER BY id",
  ).all(run.id) as Array<{ type: string }>;
  expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
    "approval.requested",
    "approval.approved",
    "approval.consumed",
    "approval.expired",
    "approval.denied",
  ]));

  secondDatabase.close();
  firstDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});

test("two managers cannot consume the same durable approval", () => {
  const directory = mkdtempSync(join(tmpdir(), "kestrel-approval-race-"));
  const path = join(directory, "approvals.sqlite");
  const firstDatabase = openDatabase(path);
  const secondDatabase = openDatabase(path);
  const firstRepository = new StoreRepository(firstDatabase);
  const secondRepository = new StoreRepository(secondDatabase);
  const task = firstRepository.createTask({ title: "race", prompt: "race", workspace: directory, maxSteps: 1 });
  const run = firstRepository.startRun(task.id, "race-run");
  const input = {
    callId: "race-call",
    runId: run.id,
    tool: "shell.exec",
    capability: "shell",
    risk: "high" as const,
    summary: "race shell",
    arguments: { command: "printf race" },
    createdAt: 3_000,
    expiresAt: 4_000,
  };
  const first = new ApprovalManager(firstRepository, { now: () => 3_000 });
  const second = new ApprovalManager(secondRepository, { now: () => 3_000 });
  first.request(input);
  first.approve(input.callId, 3_001);
  const lookup = { id: input.callId, tool: input.tool, arguments: input.arguments };
  expect([first.consume(lookup), second.consume(lookup)].filter(Boolean)).toHaveLength(1);

  firstDatabase.close();
  secondDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});
