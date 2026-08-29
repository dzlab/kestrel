import { resolveWorkspacePath } from "./filesystem";
import {
  closeSecureDirectory,
  openSecureDirectoryPath,
  revalidateSecureDirectory,
} from "./secure-fs";
import { registerTrustedBuiltInTool } from "./types";
import type { Tool, ToolContext, ToolResult } from "./types";
import { MAX_TOOL_OUTPUT_BYTES, truncateUtf8 } from "./types";
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  MAX_PROCESS_TIMEOUT_MS,
  PROCESS_OUTPUT_LIMIT_BYTES,
  runProcess,
} from "../runtime/process";
import { ValidationError } from "../errors";

const SAFE_ENV_KEYS = new Set(["HOME"]);
const CREDENTIAL_KEY = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH|AWS_|GITHUB_TOKEN)/iu;
const FALLBACK_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);
const BACKGROUND_LAUNCHERS = new Set(["nohup", "setsid", "daemonize", "disown", "start"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${name} must be a non-empty string`);
  return value;
}

function timeoutArgument(args: Record<string, unknown>): number {
  const value = args.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PROCESS_TIMEOUT_MS) {
    throw new ValidationError(`timeoutMs must be an integer between 1 and ${MAX_PROCESS_TIMEOUT_MS}`);
  }
  return value;
}

function executableName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
}

function shellArgument(argv: readonly string[]): string | null {
  for (const argument of argv) {
    if (SHELL_EXECUTABLES.has(executableName(argument))) return argument;
  }
  return null;
}

function validateShellArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((argument) => typeof argument !== "string")) {
    throw new ValidationError("argv must be a non-empty array of strings");
  }
  const argv = value as string[];
  if (argv[0]!.length === 0) throw new ValidationError("argv executable must be non-empty");
  const shell = shellArgument(argv);
  if (shell !== null) {
    throw new ValidationError(`nested shell launcher is not allowed: ${shell}`);
  }
  for (const argument of argv) {
    if (BACKGROUND_LAUNCHERS.has(executableName(argument))) {
      throw new ValidationError(`background or detached launcher is not allowed: ${argument}`);
    }
    if (["&", "&&", ";&", "&;"].includes(argument)) {
      throw new ValidationError("background shell operators are not allowed");
    }
  }
  return argv;
}

function scrubEnvironment(
  requested: unknown,
  cwd: string,
  context: ToolContext,
): Record<string, string> {
  const environment: Record<string, string> = { PATH: FALLBACK_PATH };
  if (requested !== undefined) {
    if (!isRecord(requested)) throw new ValidationError("env must be an object");
    for (const [key, value] of Object.entries(requested)) {
      if (CREDENTIAL_KEY.test(key) || (key !== "PATH" && !SAFE_ENV_KEYS.has(key))) {
        throw new ValidationError(`environment key ${key} is not allowed by the safe environment allowlist`);
      }
      if (typeof value !== "string") throw new ValidationError(`environment value ${key} must be a string`);
      if (key === "PATH" && value !== FALLBACK_PATH) {
        throw new ValidationError("environment PATH is not allowed by the safe environment allowlist");
      }
      environment[key] = value;
    }
  }
  environment.PWD = cwd;
  environment.KESTREL_RUN_ID = context.runId;
  if (context.taskId !== undefined && context.taskId !== null) environment.KESTREL_TASK_ID = context.taskId;
  return environment;
}

function redact(value: string, patterns: readonly (string | RegExp)[] | undefined): string {
  if (patterns === undefined || patterns.length === 0) return value;
  let redacted = value;
  for (const pattern of patterns) {
    if (pattern instanceof RegExp) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      redacted = redacted.replace(new RegExp(pattern.source, flags), "[REDACTED]");
      continue;
    }
    if (pattern.length > 0) redacted = redacted.split(pattern).join("[REDACTED]");
  }
  return redacted;
}

function processResult(result: Awaited<ReturnType<typeof runProcess>>, context: ToolContext): ToolResult {
  const streamLimit = Math.min(PROCESS_OUTPUT_LIMIT_BYTES, Math.floor((MAX_TOOL_OUTPUT_BYTES - 1_024) / 2));
  const stdout = truncateUtf8(redact(result.stdout, context.secretPatterns), streamLimit);
  const stderr = truncateUtf8(redact(result.stderr, context.secretPatterns), streamLimit);
  const ok = result.exitCode === 0 && result.timedOut !== true && result.aborted !== true;
  const status = result.timedOut === true
    ? "process timed out"
    : result.aborted === true
      ? "process aborted"
      : result.exitCode === 0
        ? "process completed"
        : `process exited with code ${String(result.exitCode)}`;
  return {
    ok,
    content: status,
    data: { ...result, stdout, stderr },
  };
}

async function executeShell(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const argv = validateShellArgv(args.argv);
  const cwd = resolveWorkspacePath(context.workspace, typeof args.cwd === "string" ? args.cwd : ".");
  const directory = openSecureDirectoryPath(context.workspace, cwd);
  try {
    const environment = scrubEnvironment(args.env, cwd, context);
    const result = await runProcess({
      argv,
      cwd,
      cwdGuard: { revalidate: () => revalidateSecureDirectory(context.workspace, directory) },
      env: environment,
      timeoutMs: timeoutArgument(args),
      signal: context.signal,
    });
    return processResult(result, context);
  } finally {
    closeSecureDirectory(directory);
  }
}

async function executeBun(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const requestedScript = stringArgument(args, "script");
  const script = resolveWorkspacePath(context.workspace, requestedScript);
  const requestedArgs = args.args ?? [];
  if (!Array.isArray(requestedArgs) || requestedArgs.some((value) => typeof value !== "string")) {
    throw new ValidationError("args must be an array of strings");
  }
  const cwd = resolveWorkspacePath(context.workspace, typeof args.cwd === "string" ? args.cwd : ".");
  const directory = openSecureDirectoryPath(context.workspace, cwd);
  try {
    const environment = scrubEnvironment(args.env, cwd, context);
    const result = await runProcess({
      argv: [process.execPath, "run", script, ...requestedArgs],
      cwd,
      cwdGuard: { revalidate: () => revalidateSecureDirectory(context.workspace, directory) },
      env: environment,
      timeoutMs: timeoutArgument(args),
      signal: context.signal,
    });
    return processResult(result, context);
  } finally {
    closeSecureDirectory(directory);
  }
}

const shellTool: Tool = registerTrustedBuiltInTool({
  definition: {
    name: "shell.exec",
    description: "Execute one approved process argv in the workspace.",
    capability: "shell",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        env: { type: "object", additionalProperties: true },
      },
      required: ["argv"],
      additionalProperties: false,
    },
  },
  async execute(args, context) {
    try {
      return await executeShell(args, context);
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  },
});

const bunTool: Tool = registerTrustedBuiltInTool({
  definition: {
    name: "bun.run",
    description: "Run a workspace Bun script with explicit argv arguments.",
    capability: "process",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        env: { type: "object", additionalProperties: true },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  async execute(args, context) {
    try {
      return await executeBun(args, context);
    } catch (error) {
      return { ok: false, content: error instanceof Error ? error.message : String(error) };
    }
  },
});

export function createShellTools(): Tool[] {
  return [shellTool, bunTool];
}

export { shellTool, bunTool };
