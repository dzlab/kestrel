export const version = "0.1.0";

export { SchedulerDaemon, retryDelayMs } from "./scheduler/daemon";
export { nextOccurrence, validateScheduleInput } from "./scheduler/expressions";

export { SelfUpgrade, createUpgradeTools } from "./upgrade";
export type {
  SelfUpgradeOptions,
  UpgradeApplyInput,
  UpgradeApplyResult,
  UpgradeProposal,
  UpgradeProposalStatus,
  UpgradeProposeInput,
  UpgradeRunner,
  UpgradeRunnerResult,
} from "./upgrade";

export { RunKernel, Kernel } from "./kernel";
export type {
  RunKernelDependencies,
  RunOptions,
  RunSummary,
  RunTask,
} from "./kernel";
export {
  MemoryStore,
  assertSafeMemory,
  createMemoryTools,
} from "./memory";
export type {
  MemoryRecord,
  MemorySaveInput,
  MemorySearchInput,
  MemoryScope,
} from "./memory";
