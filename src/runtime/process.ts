import { ToolExecutionError } from "../errors";

export const PROCESS_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
export const MAX_PROCESS_TIMEOUT_MS = 120_000;

export type ProcessRequest = {
  argv: readonly string[];
  cwd: string;
  cwdGuard?: ProcessCwdGuard;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type ProcessCwdGuard = {
  revalidate(): void;
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

const TERMINATION_GRACE_MS = 100;
const TERMINATION_KILL_WAIT_MS = 500;
const CAPTURE_DRAIN_WAIT_MS = 250;

type Capture = {
  promise: Promise<string>;
  cancel(): void;
  text(): string;
};

function capture(stream: ReadableStream<Uint8Array>, maxBytes: number): Capture {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cancelled = false;
  const promise = (async (): Promise<string> => {
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
    } catch (error) {
      if (!cancelled) throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  })();
  return {
    promise,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    },
    text(): string {
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeProcessGroupPid(processHandle: Bun.Subprocess): number | null {
  const pid = processHandle.pid;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    pid === process.ppid
  ) return null;
  return pid;
}

function signalProcessTree(processHandle: Bun.Subprocess, signal: NodeJS.Signals): void {
  const groupPid = safeProcessGroupPid(processHandle);
  if (process.platform !== "win32" && groupPid !== null) {
    try {
      process.kill(-groupPid, signal);
      return;
    } catch {
      // Fall back to the direct child when group signaling is unavailable.
    }
  }
  processHandle.kill(signal);
}

async function waitForExit(processHandle: Bun.Subprocess, waitMs: number): Promise<number | null> {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  return Promise.race([
    processHandle.exited,
    delay(waitMs).then(() => null),
  ]);
}

async function terminate(processHandle: Bun.Subprocess): Promise<number | null> {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  signalProcessTree(processHandle, "SIGTERM");
  let exited = await waitForExit(processHandle, TERMINATION_GRACE_MS);
  if (exited !== null) return exited;
  signalProcessTree(processHandle, "SIGKILL");
  exited = await waitForExit(processHandle, TERMINATION_KILL_WAIT_MS);
  return exited ?? processHandle.exitCode;
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
  if (typeof request.cwd !== "string" || request.cwd.length === 0 || request.cwd.includes("\0")) {
    throw new ToolExecutionError("process cwd must be a non-empty path");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new ToolExecutionError(`process timeout must be an integer between 1 and ${MAX_PROCESS_TIMEOUT_MS}`);
  }

  const startedAt = Date.now();
  let processHandle: Bun.Subprocess;
  try {
    request.cwdGuard?.revalidate();
    processHandle = Bun.spawn([...request.argv], {
      cwd: request.cwd,
      env: request.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    throw new ToolExecutionError(`could not start process: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const stdoutCapture = capture(processHandle.stdout as ReadableStream<Uint8Array>, PROCESS_OUTPUT_LIMIT_BYTES);
  const stderrCapture = capture(processHandle.stderr as ReadableStream<Uint8Array>, PROCESS_OUTPUT_LIMIT_BYTES);
  const outcome = await outcomeWithTimeout(processHandle, request.timeoutMs, request.signal);
  let exitCode: number | null;
  if (outcome.kind === "exit") {
    exitCode = outcome.exitCode;
  } else {
    stdoutCapture.cancel();
    stderrCapture.cancel();
    exitCode = await terminate(processHandle);
  }

  let stdout: string;
  let stderr: string;
  if (outcome.kind === "exit") {
    [stdout, stderr] = await Promise.all([stdoutCapture.promise, stderrCapture.promise]);
  } else {
    await Promise.all([
      Promise.race([stdoutCapture.promise, delay(CAPTURE_DRAIN_WAIT_MS)]),
      Promise.race([stderrCapture.promise, delay(CAPTURE_DRAIN_WAIT_MS)]),
    ]);
    stdout = stdoutCapture.text();
    stderr = stderrCapture.text();
  }
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    ...(outcome.kind === "timeout" ? { timedOut: true } : {}),
    ...(outcome.kind === "abort" ? { aborted: true } : {}),
  };
}
