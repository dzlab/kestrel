import { OpenAICompatibleClient } from "../model/openai-compatible";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApprovalManager } from "../policy/approvals";
import { openDatabase } from "../store/database";
import { StoreRepository } from "../store/repository";
import { createToolRegistry } from "../tools/registry";
import { RunKernel } from "../kernel";
import { SchedulerDaemon } from "../scheduler/daemon";

const usage = "Usage: bun run src/cli/main.ts [--help]";

export type CliRuntime = {
  kernel: RunKernel;
  repository: StoreRepository;
  approvals: ApprovalManager;
  close?: () => void;
};

function runtimeFromEnvironment(): CliRuntime {
  const database = openDatabase(databasePath());
  const repository = new StoreRepository(database);
  const approvals = new ApprovalManager(repository);
  const registry = createToolRegistry({ approvals });
  const baseUrl = process.env.KESTREL_MODEL_BASE_URL;
  if (baseUrl === undefined || baseUrl.length === 0) {
    database.close();
    throw new Error("KESTREL_MODEL_BASE_URL is required for run/resume");
  }
  const modelName = process.env.KESTREL_MODEL_NAME ?? "kestrel";
  const model = new OpenAICompatibleClient({
    baseUrl,
    apiKey: process.env.KESTREL_MODEL_API_KEY,
    model: modelName,
    timeoutMs: Number(process.env.KESTREL_MODEL_TIMEOUT_MS ?? 30_000),
  });
  return {
    kernel: new RunKernel({ model, repository, registry, approvals, modelName }),
    repository,
    approvals,
    close: () => database.close(),
  };
}

function databasePath(): string {
  return process.env.KESTREL_DB ?? join(dataDirectory(), "kestrel.sqlite");
}

function dataDirectory(): string {
  const directory = process.env.KESTREL_DATA_DIR ?? join(homedir(), ".kestrel");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function pidPath(): string {
  return join(dataDirectory(), "scheduler.pid");
}

function getRuntime(runtime?: CliRuntime): { runtime: CliRuntime; owned: boolean } {
  return runtime === undefined ? { runtime: runtimeFromEnvironment(), owned: true } : { runtime, owned: false };
}

async function runCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const prompt = args.slice(1).join(" ").trim();
  if (prompt.length === 0) {
    write("run requires a prompt");
    return 1;
  }
  const selected = getRuntime(runtime);
  try {
    const workspace = process.env.KESTREL_WORKSPACE ?? process.cwd();
    const result = await selected.runtime.kernel.run({ title: prompt.slice(0, 120), prompt, workspace });
    write(JSON.stringify(result));
    return result.status === "completed" ? 0 : 1;
  } finally {
    if (selected.owned) selected.runtime.close?.();
  }
}

async function approvalCommand(
  action: "approve" | "deny",
  args: readonly string[],
  write: (message: string) => void,
  runtime?: CliRuntime,
): Promise<number> {
  const callId = args[1];
  if (callId === undefined || callId.length === 0) {
    write(`${action} requires a call id`);
    return 1;
  }
  const selected = getRuntime(runtime);
  try {
    const approval = selected.runtime.approvals.get(callId);
    const toolCall = selected.runtime.repository.getToolCall(callId);
    if (approval === null || toolCall === null) {
      write(`approval or tool call not found: ${callId}`);
      return 1;
    }
    write(JSON.stringify({ callId, tool: toolCall.name, arguments: toolCall.arguments }));
    const resolved = action === "approve"
      ? selected.runtime.approvals.approve(callId)
      : selected.runtime.approvals.deny(callId);
    const result = await selected.runtime.kernel.resume(resolved.runId);
    write(JSON.stringify(result));
    return result.status === "completed" ? 0 : 1;
  } finally {
    if (selected.owned) selected.runtime.close?.();
  }
}

async function scheduleCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const action = args[1];
  if (action !== "list" && action !== "cancel") {
    write("schedule requires list or cancel");
    return 1;
  }
  const selected = runtime === undefined
    ? (() => {
        const database = openDatabase(databasePath());
        return { runtime: { repository: new StoreRepository(database) } as CliRuntime, owned: true, close: () => database.close() };
      })()
    : { runtime, owned: false, close: () => undefined };
  try {
    if (action === "list") {
      write(JSON.stringify(selected.runtime.repository.listSchedules()));
      return 0;
    }
    const id = args[2];
    if (id === undefined || id.length === 0) {
      write("schedule cancel requires an id");
      return 1;
    }
    if (!selected.runtime.repository.cancelSchedule(id)) {
      write(`schedule not found: ${id}`);
      return 1;
    }
    write(JSON.stringify({ cancelled: true, id }));
    return 0;
  } finally {
    if (selected.owned) selected.close();
  }
}

async function daemonCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const action = args[1];
  const path = pidPath();
  if (action === "status") {
    if (!existsSync(path)) {
      write(JSON.stringify({ running: false }));
      return 0;
    }
    const pid = Number(readFileSync(path, "utf8").trim());
    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      unlinkSync(path);
    }
    write(JSON.stringify({ running, ...(running ? { pid } : {}) }));
    return 0;
  }
  if (action === "stop") {
    if (!existsSync(path)) {
      write(JSON.stringify({ stopped: false, running: false }));
      return 0;
    }
    const pid = Number(readFileSync(path, "utf8").trim());
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // A stale PID file is safe to remove after the process is gone.
    }
    unlinkSync(path);
    write(JSON.stringify({ stopped: true, pid }));
    return 0;
  }
  if (action !== "start") {
    write("daemon requires start, status, or stop");
    return 1;
  }
  if (existsSync(path)) {
    write("daemon already has a PID file");
    return 1;
  }
  const selected = getRuntime(runtime);
  if (!selected.runtime.kernel) return 1;
  const daemon = new SchedulerDaemon({ repository: selected.runtime.repository, kernel: selected.runtime.kernel });
  daemon.start(1_000, true);
  writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
  write(JSON.stringify({ running: true, pid: process.pid }));
  return 0;
}

export function runCli(
  args: readonly string[],
  write: (message: string) => void = (message) => console.log(message),
  runtime?: CliRuntime,
): number | Promise<number> {
  if (args.includes("--help")) {
    write(usage);
    return 0;
  }
  const command = args[0];
  if (command === "run") return runCommand(args, write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "approve" || command === "deny") {
    return approvalCommand(command, args, write, runtime).catch((error) => {
      write(error instanceof Error ? error.message : String(error));
      return 1;
    });
  }
  if (command === "schedule") return scheduleCommand(args, write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "daemon") return daemonCommand(args, write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  write(usage);
  return 1;
}

if (import.meta.main) {
  const result = runCli(process.argv.slice(2));
  process.exitCode = result instanceof Promise ? await result : result;
}
