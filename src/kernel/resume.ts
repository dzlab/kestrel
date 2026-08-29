import type { RunOptions, RunSummary, RunKernel } from "./loop";

export function resumeRun(kernel: RunKernel, runId: string, options: RunOptions = {}): Promise<RunSummary> {
  return kernel.resume(runId, options);
}
