import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcess } from "../src/runtime/process";
import {
  closeSecureParent,
  openSecureParent,
  revalidateSecureParent,
} from "../src/tools/secure-fs";
import type { ProcessCwdGuard, ProcessRequest } from "../src/runtime/process";

function descendantArgv(): string[] {
  return [
    process.execPath,
    "-e",
    "Bun.spawn(['/bin/sleep', '1'], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }); await Bun.sleep(1000)",
  ];
}

function request(argv: string[], cwd: string, extra: Partial<ProcessRequest> = {}): ProcessRequest {
  return {
    argv,
    cwd,
    env: { PATH: "/usr/bin:/bin" },
    timeoutMs: 20,
    ...extra,
  } as ProcessRequest;
}

test("timeout kills descendants that inherit the managed process pipes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-process-"));
  try {
    const startedAt = Date.now();
    const result = await runProcess(request(descendantArgv(), workspace));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("abort kills descendants that inherit the managed process pipes", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-process-"));
  const controller = new AbortController();
  try {
    const startedAt = Date.now();
    const running = runProcess(request(descendantArgv(), workspace, { timeoutMs: 5_000, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cwd replacement between validation and spawn fails closed", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-process-"));
  const cwd = join(workspace, "cwd");
  const replacement = join(workspace, "cwd-original");
  mkdirSync(cwd);
  const parent = openSecureParent(workspace, join(realpathSync(workspace), "cwd", "marker"), false);
  let closed = false;
  const cwdGuard: ProcessCwdGuard & { close(): void } = {
    revalidate: () => revalidateSecureParent(workspace, parent),
    close: () => {
      if (closed) return;
      closed = true;
      closeSecureParent(parent);
    },
  };
  try {
    renameSync(cwd, replacement);
    mkdirSync(cwd);
    await expect(runProcess(request(["/bin/pwd"], cwd, { cwdGuard }))).rejects.toThrow(/cwd|directory|changed|start/i);
  } finally {
    cwdGuard.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
