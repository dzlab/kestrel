import { OpenAICompatibleClient } from "../model/openai-compatible";
import { ApprovalManager } from "../policy/approvals";
import { openDatabase } from "../store/database";
import { StoreRepository } from "../store/repository";
import { createToolRegistry } from "../tools/registry";
import { RunKernel } from "../kernel";

const usage = "Usage: bun run src/cli/main.ts [--help]";

export type CliRuntime = {
  kernel: RunKernel;
  repository: StoreRepository;
  approvals: ApprovalManager;
  close?: () => void;
};

function runtimeFromEnvironment(): CliRuntime {
  const database = openDatabase(process.env.KESTREL_DB ?? ":memory:");
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
  write(usage);
  return 1;
}

if (import.meta.main) {
  const result = runCli(process.argv.slice(2));
  process.exitCode = result instanceof Promise ? await result : result;
}
