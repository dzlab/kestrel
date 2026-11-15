#!/usr/bin/env bun

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ConversationService,
  createKestrel,
  loadConfig,
  openConfiguredDatabase,
  startKestrelHttpServer,
} from "../index";
import { SchedulerDaemon } from "../scheduler/daemon";
import { StoreRepository } from "../store/repository";
import { MemoryStore } from "../memory/store";
import { SelfUpgrade } from "../upgrade/workflow";
import type { ApprovalManager } from "../policy/approvals";
import type { RunKernel, RunOptions } from "../kernel";

const usage = `Kestrel local agent

Usage:
  kestrel run <prompt>             Run a task in the configured workspace
  kestrel ui                       Serve the local browser UI and API
  kestrel approve <call-id>        Approve the exact pending tool call and resume
  kestrel deny <call-id>           Deny the exact pending tool call
  kestrel history                  Show recent durable tasks
  kestrel status [task-or-run-id]  Show durable task or run status
  kestrel memory list [limit]      Inspect recent durable memory
  kestrel memory search <query>    Search durable memory for the local user
  kestrel self inspect <run-id> [proposal-id]  Inspect an upgrade proposal
  kestrel schedule list             List schedules
  kestrel schedule cancel <id>     Cancel a schedule without deleting history
  kestrel tick                     Claim and run one due schedule
  kestrel daemon start|status|stop Run the durable scheduler daemon
  kestrel --help                   Show this help

Config:
  KESTREL_MODEL_BASE_URL           OpenAI-compatible API base URL, for example http://127.0.0.1:8000/v1
  KESTREL_MODEL_API_KEY            Optional bearer token (never sent to tool output)
  KESTREL_MODEL_NAME               Provider model name (default: kestrel)
  KESTREL_WORKSPACE                Workspace root (default: current directory)
  KESTREL_DATA_DIR                 Private state directory (default: ~/.kestrel)
  KESTREL_DB                       SQLite file, relative paths stay under KESTREL_DATA_DIR

Use mise install or Bun 1.4+ before running the CLI.`;

export type CliRuntime = {
  kernel?: RunKernel;
  repository: StoreRepository;
  approvals: ApprovalManager;
  config?: { workspace: string };
  defaults?: RunOptions;
  close?: () => void;
};

function runtimeFromEnvironment(): CliRuntime {
  return createKestrel();
}

function dataDirectory(): string {
  return loadConfig().dataDir;
}

function pidPath(): string {
  return join(dataDirectory(), "scheduler.pid");
}

function getRuntime(runtime?: CliRuntime): { runtime: CliRuntime; owned: boolean } {
  return runtime === undefined ? { runtime: runtimeFromEnvironment(), owned: true } : { runtime, owned: false };
}

function requireKernel(runtime: CliRuntime): RunKernel {
  if (runtime.kernel === undefined) throw new Error("this command requires a model runtime");
  return runtime.kernel;
}

async function runCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const prompt = args.slice(1).join(" ").trim();
  if (prompt.length === 0) {
    write("run requires a prompt");
    return 1;
  }
  const selected = getRuntime(runtime);
  try {
    const result = await requireKernel(selected.runtime).run(
      {
        title: prompt.slice(0, 120),
        prompt,
        workspace: selected.runtime.config?.workspace ?? process.env.KESTREL_WORKSPACE ?? process.cwd(),
      },
      selected.runtime.defaults,
    );
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
    const result = await requireKernel(selected.runtime).resume(resolved.runId, selected.runtime.defaults);
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
        const database = openConfiguredDatabase(loadConfig());
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

async function historyCommand(args: readonly string[], write: (message: string) => void): Promise<number> {
  const config = loadConfig();
  const database = openConfiguredDatabase(config);
  try {
    const limit = args[1] === undefined ? 50 : Number(args[1]);
    write(JSON.stringify(new StoreRepository(database).listTasks(limit)));
    return 0;
  } finally {
    database.close();
  }
}

async function statusCommand(args: readonly string[], write: (message: string) => void): Promise<number> {
  const config = loadConfig();
  const database = openConfiguredDatabase(config);
  try {
    const repository = new StoreRepository(database);
    const id = args[1];
    const record = id === undefined ? repository.listTasks(1)[0] ?? null : repository.getTask(id) ?? repository.getRun(id);
    if (record === null) {
      write(JSON.stringify({ found: false }));
      return 1;
    }
    write(JSON.stringify(record));
    return 0;
  } finally {
    database.close();
  }
}

async function memoryCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const action = args[1];
  if (action !== "list" && action !== "search") {
    write("memory requires list or search");
    return 1;
  }
  const selected = runtime === undefined
    ? (() => {
        const config = loadConfig();
        const database = openConfiguredDatabase(config);
        return { runtime: { repository: new StoreRepository(database) } as CliRuntime, owned: true, close: () => database.close() };
      })()
    : { runtime, owned: false, close: () => undefined };
  try {
    if (action === "list") {
      const limit = args[2] === undefined ? 50 : Number(args[2]);
      write(JSON.stringify(selected.runtime.repository.listMemories(limit)));
      return 0;
    }
    const query = args.slice(2).join(" ").trim();
    if (query.length === 0) {
      write("memory search requires a query");
      return 1;
    }
    write(JSON.stringify(new MemoryStore(selected.runtime.repository).search({ query, userId: "local", taskId: null })));
    return 0;
  } finally {
    if (selected.owned) selected.close();
  }
}

async function selfCommand(args: readonly string[], write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  if (args[1] !== "inspect" || args[2] === undefined || args[2].length === 0) {
    write("self inspect requires a run id");
    return 1;
  }
  const selected = getRuntime(runtime);
  try {
    const proposal = new SelfUpgrade({ repository: selected.runtime.repository, approvals: selected.runtime.approvals })
      .status(args[2], args[3]);
    write(JSON.stringify(proposal));
    return proposal === null ? 1 : 0;
  } finally {
    if (selected.owned) selected.runtime.close?.();
  }
}

async function tickCommand(write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const selected = getRuntime(runtime);
  try {
    const result = await new SchedulerDaemon({
      repository: selected.runtime.repository,
      kernel: requireKernel(selected.runtime),
    }).tick();
    write(JSON.stringify(result));
    return result === null || result.status === "completed" ? 0 : 1;
  } finally {
    if (selected.owned) selected.runtime.close?.();
  }
}

async function uiCommand(write: (message: string) => void, runtime?: CliRuntime): Promise<number> {
  const selected = getRuntime(runtime);
  let serverPromise: ReturnType<typeof startKestrelHttpServer> | undefined;
  let server: Awaited<ReturnType<typeof startKestrelHttpServer>> | undefined;
  let conversations: ConversationService | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let shutdownRequested = false;
  let resolveSignal: () => void = () => undefined;
  const signalReceived = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const shutdown = (): Promise<void> => {
    shutdownRequested = true;
    shutdownPromise ??= (async () => {
      try {
        const serverClose = server !== undefined
          ? server.close()
          : serverPromise === undefined
            ? Promise.resolve()
            : serverPromise.then((started) => started.close());
        const serviceClose = conversations?.shutdown() ?? Promise.resolve();
        const [serverResult, serviceResult] = await Promise.allSettled([serverClose, serviceClose]);
        if (serverResult.status === "rejected") throw serverResult.reason;
        if (serviceResult.status === "rejected") throw serviceResult.reason;
      } finally {
        if (selected.owned) {
          selected.runtime.close?.();
        }
      }
    })();
    return shutdownPromise;
  };
  const onSignal = (): void => {
    resolveSignal();
    void shutdown().catch(() => undefined);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const workspace = selected.runtime.config?.workspace ?? process.env.KESTREL_WORKSPACE ?? process.cwd();
    conversations = new ConversationService({
      repository: selected.runtime.repository,
      kernel: requireKernel(selected.runtime),
      approvals: selected.runtime.approvals,
      defaults: selected.runtime.defaults,
    });
    serverPromise = startKestrelHttpServer({
      repository: selected.runtime.repository,
      conversations,
      workspace,
    });
    server = await serverPromise;
    if (!shutdownRequested) {
      write(`Kestrel UI listening at ${server.url}`);
      void conversations.recoverAll().catch((error: unknown) => {
        write(`Kestrel conversation recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await signalReceived;
    await shutdown();
    return 0;
  } finally {
    try {
      await shutdown();
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
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
  const daemon = new SchedulerDaemon({ repository: selected.runtime.repository, kernel: requireKernel(selected.runtime) });
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
  if (command === "ui") return uiCommand(write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
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
  if (command === "history") return historyCommand(args, write).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "status") return statusCommand(args, write).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "memory") return memoryCommand(args, write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "self") return selfCommand(args, write, runtime).catch((error) => {
    write(error instanceof Error ? error.message : String(error));
    return 1;
  });
  if (command === "tick") return tickCommand(write, runtime).catch((error) => {
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
