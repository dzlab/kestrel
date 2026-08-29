import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalManager } from "../src/policy/approvals";
import { createShellTools } from "../src/tools/shell";
import { createToolRegistry } from "../src/tools/registry";
import type { Tool, ToolContext, ToolResult } from "../src/tools/types";

function workspaceContext(workspace: string, signal?: AbortSignal): ToolContext {
  return { workspace, runId: "run-shell-test", repository: {}, signal } as ToolContext;
}

function approvedRegistry(workspace: string): { registry: ReturnType<typeof createToolRegistry>; approvals: ApprovalManager } {
  const approvals = new ApprovalManager({ now: () => 1_000 });
  return {
    approvals,
    registry: createToolRegistry({
      approvals,
      policyContext: { workspace, runId: "run-shell-test", now: 1_000 },
    }),
  };
}

function approve(
  approvals: ApprovalManager,
  call: { id: string; name: string; arguments: Record<string, unknown> },
): void {
  approvals.request({
    callId: call.id,
    runId: "run-shell-test",
    tool: call.name,
    capability: call.name === "bun.run" ? "process" : "shell",
    risk: "high",
    summary: `Run ${call.name}`,
    arguments: call.arguments,
    createdAt: 1_000,
    expiresAt: 2_000,
  });
  approvals.approve(call.id, 1_000);
}

function tool(name: string): Tool {
  const found = createShellTools().find((candidate) => candidate.definition.name === name);
  if (found === undefined) throw new Error(`missing shell tool: ${name}`);
  return found;
}

function resultData(result: ToolResult): Record<string, unknown> {
  expect(result.data).toBeDefined();
  return result.data as Record<string, unknown>;
}

test("exposes exactly shell.exec and bun.run and gates both through approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const { registry, approvals } = approvedRegistry(workspace);
    const definitions = registry.definitions().filter(({ name }) => name === "shell.exec" || name === "bun.run");
    expect(definitions.map(({ name }) => name).sort()).toEqual(["bun.run", "shell.exec"]);

    const script = join(workspace, "args.ts");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))\n");
    const call = {
      id: "bun-approval",
      name: "bun.run",
      arguments: { script: "args.ts", args: ["safe value", "$(touch escaped)"] },
    } as const;
    await expect(registry.execute(call, workspaceContext(workspace))).resolves.toMatchObject({
      ok: false,
      content: expect.stringMatching(/approval/i),
    });
    approve(approvals, call);
    const result = await registry.execute(call, workspaceContext(workspace));
    expect(result.ok).toBe(true);
    expect(resultData(result).stdout).toContain("safe value");
    expect(resultData(result).stdout).toContain("$(touch escaped)");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("executes shell input as one approved command with a scrubbed allowlist environment", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  const inheritedSecret = "KESTREL_TEST_SECRET_SHOULD_NOT_LEAK";
  const previousSecret = process.env[inheritedSecret];
  process.env[inheritedSecret] = "not-for-the-child";
  try {
    const { registry, approvals } = approvedRegistry(workspace);
    const call = {
      id: "shell-env",
      name: "shell.exec",
      arguments: {
        command: "env",
        env: { HOME: "/safe/home" },
      },
    };
    approve(approvals, call);
    const result = await registry.execute(call, workspaceContext(workspace));
    expect(result.ok).toBe(true);
    const stdout = String(resultData(result).stdout);
    expect(stdout).toContain("PATH=");
    expect(stdout).toContain("HOME=/safe/home");
    expect(stdout).toContain("PWD=");
    expect(stdout).toContain("KESTREL_RUN_ID=run-shell-test");
    expect(stdout).not.toContain(inheritedSecret);
    expect(stdout).not.toContain("KESTREL_MODEL_API_KEY");
  } finally {
    if (previousSecret === undefined) delete process.env[inheritedSecret];
    else process.env[inheritedSecret] = previousSecret;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reports nonzero exits with bounded stderr and exit metadata", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const { registry, approvals } = approvedRegistry(workspace);
    const call = {
      id: "shell-failure",
      name: "shell.exec",
      arguments: { command: "printf failure >&2; exit 7" },
    };
    approve(approvals, call);
    const result = await registry.execute(call, workspaceContext(workspace));
    expect(result.ok).toBe(false);
    expect(resultData(result)).toMatchObject({ exitCode: 7, stderr: "failure" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("terminates a process when the timeout expires", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const result = await tool("shell.exec").execute(
      { command: "sleep 10", timeoutMs: 30 },
      workspaceContext(workspace),
    );
    const data = resultData(result);
    expect(result.ok).toBe(false);
    expect(data.timedOut).toBe(true);
    expect(Number(data.durationMs)).toBeLessThan(2_000);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("terminates a process when its abort signal fires", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  const controller = new AbortController();
  try {
    const running = tool("shell.exec").execute(
      { command: "sleep 10", timeoutMs: 5_000 },
      workspaceContext(workspace, controller.signal),
    );
    setTimeout(() => controller.abort(), 30);
    const result = await running;
    const data = resultData(result);
    expect(result.ok).toBe(false);
    expect(data.aborted).toBe(true);
    expect(Number(data.durationMs)).toBeLessThan(2_000);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("caps stdout and stderr independently", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    writeFileSync(
      join(workspace, "emit.ts"),
      "process.stdout.write('o'.repeat(100000)); process.stderr.write('e'.repeat(100000))\n",
    );
    const result = await tool("bun.run").execute(
      {
        script: "emit.ts",
        args: [],
      },
      workspaceContext(workspace),
    );
    const data = resultData(result);
    expect(result.ok).toBe(true);
    expect(String(data.stdout).length).toBeLessThanOrEqual(64 * 1024);
    expect(String(data.stderr).length).toBeLessThanOrEqual(64 * 1024);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects cwd traversal and symlink escape", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  const outside = mkdtempSync(join(tmpdir(), "kestrel-outside-"));
  try {
    symlinkSync(outside, join(workspace, "escape"));
    const shell = tool("shell.exec");
    const traversal = await shell.execute({ command: "pwd", cwd: "../" }, workspaceContext(workspace));
    expect(traversal.ok).toBe(false);
    expect(traversal.content).toMatch(/traversal|outside|workspace/i);
    const symlink = await shell.execute({ command: "pwd", cwd: "escape" }, workspaceContext(workspace));
    expect(symlink.ok).toBe(false);
    expect(symlink.content).toMatch(/symlink|outside|workspace/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects background process requests", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const result = await tool("shell.exec").execute({ command: "sleep 1 &" }, workspaceContext(workspace));
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/background|detached/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects environment overrides outside the safe allowlist", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const result = await tool("shell.exec").execute(
      { command: "true", env: { API_TOKEN: "secret" } },
      workspaceContext(workspace),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/environment|credential|allowlist/i);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("redacts configured secret patterns from process output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-shell-"));
  try {
    const script = join(workspace, "secret.ts");
    writeFileSync(script, "console.log('visible secret-value')\n");
    chmodSync(script, 0o644);
    const result = await tool("bun.run").execute(
      { script: "secret.ts", args: [] },
      {
        ...workspaceContext(workspace),
        secretPatterns: ["secret-value"],
      } as ToolContext,
    );
    expect(result.ok).toBe(true);
    expect(String(resultData(result).stdout)).toContain("[REDACTED]");
    expect(String(resultData(result).stdout)).not.toContain("secret-value");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
