import { ToolExecutionError } from "../errors";

export const PROCESS_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
export const MAX_PROCESS_TIMEOUT_MS = 120_000;

export type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
};

type ProcessOutcome =
  | { kind: "exit"; exitCode: number }
  | { kind: "timeout" }
  | { kind: "abort" };

async function capture(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size >= maxBytes) continue;
      const remaining = maxBytes - size;
      const chunk = next.value.byteLength <= remaining ? next.value : next.value.subarray(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminate(processHandle: Bun.Subprocess): Promise<number> {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  processHandle.kill("SIGTERM");
  const exited = await Promise.race([
    processHandle.exited,
    delay(100).then(() => null),
  ]);
  if (exited !== null) return exited;
  processHandle.kill("SIGKILL");
  return processHandle.exited;
}

function outcomeWithTimeout(
  processHandle: Bun.Subprocess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: ProcessOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: "abort" });

    processHandle.exited.then((exitCode) => finish({ kind: "exit", exitCode }));
    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (
    request.argv.length === 0 ||
    typeof request.argv[0] !== "string" ||
    request.argv[0].length === 0 ||
    request.argv.slice(1).some((argument) => typeof argument !== "string")
  ) {
    throw new ToolExecutionError("process argv must contain a non-empty executable and string arguments");
  }

  const startedAt = Date.now();
  let processHandle: Bun.Subprocess;
  try {
    processHandle = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
    });
  } catch (error) {
    throw new ToolExecutionError(`could not start process: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const stdoutPromise = capture(processHandle.stdout as ReadableStream<Uint8Array>, PROCESS_OUTPUT_LIMIT_BYTES);
  const stderrPromise = capture(processHandle.stderr as ReadableStream<Uint8Array>, PROCESS_OUTPUT_LIMIT_BYTES);
  const outcome = await outcomeWithTimeout(processHandle, request.timeoutMs, request.signal);
  let exitCode: number | null;
  if (outcome.kind === "exit") {
    exitCode = outcome.exitCode;
  } else {
    exitCode = await terminate(processHandle);
  }

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    ...(outcome.kind === "timeout" ? { timedOut: true } : {}),
    ...(outcome.kind === "abort" ? { aborted: true } : {}),
  };
}
