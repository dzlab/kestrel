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
  expect(secondManager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(true);
  now = 10_101;
  expect(secondManager.isApproved({ id: request.id, tool: request.tool, arguments: { command: "printf safe" } })).toBe(false);
  expect(secondManager.get(request.id)?.status).toBe("expired");

  secondDatabase.close();
  rmSync(directory, { recursive: true, force: true });
});

test("approval hashes include the complete tool name and canonical argument order", () => {
  expect(hashToolCall("fs.read", { b: 2, a: 1 })).toBe(hashToolCall("fs.read", { a: 1, b: 2 }));
  expect(hashToolCall("fs.read", { path: "notes.txt" })).not.toBe(hashToolCall("search.text", { path: "notes.txt" }));
});
