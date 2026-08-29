import type { ApprovalManager } from "../policy/approvals";
import type { StoreRepository } from "../store/repository";

export const SYNTHETIC_UPGRADE_APPROVAL_PREFIX = "approval-upgrade-";
export const SYNTHETIC_UPGRADE_APPROVAL_STATE = "synthetic_approval";

export function syntheticUpgradeApprovalCallId(proposalId: string): string {
  return `${SYNTHETIC_UPGRADE_APPROVAL_PREFIX}${proposalId}`;
}

export function isSyntheticUpgradeApprovalCall(call: { callId: string; name: string; state: string }): boolean {
  return call.name === "self.apply" && call.state === SYNTHETIC_UPGRADE_APPROVAL_STATE && call.callId.startsWith(SYNTHETIC_UPGRADE_APPROVAL_PREFIX);
}

export const MAX_UPGRADE_PATCH_BYTES = 256 * 1024;
export const MAX_UPGRADE_TARGETS = 32;
export const MAX_UPGRADE_VERIFICATION_MS = 120_000;

export type UpgradeRunnerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

export type UpgradeRunner = {
  run(argv: readonly string[], cwd: string, timeoutMs?: number, signal?: AbortSignal): Promise<UpgradeRunnerResult>;
};

export type UpgradeProposalStatus = "proposed" | "applying" | "applied" | "failed" | "stale";

export type UpgradeApproval = {
  id: string;
  argumentsHash: string;
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
};

export type UpgradeProposal = {
  id: string;
  workspace: string;
  runId: string;
  baseRevision: string;
  baseHash: string;
  repoStateHash: string;
  targetFiles: string[];
  patch: string;
  patchHash: string;
  verification: string[];
  verificationTimeoutMs: number;
  selfTarget: boolean;
  status: UpgradeProposalStatus;
  createdAt: number;
  approval: UpgradeApproval;
  beforeHash?: string;
  afterHash?: string;
  verificationResult?: UpgradeRunnerResult;
  error?: string;
};

export type UpgradePersistence = Pick<StoreRepository, "appendEvent" | "getEvents" | "recordToolCall" | "getToolCall" | "updateToolCallState" | "finishToolCall">;

export type SelfUpgradeOptions = {
  repository: UpgradePersistence;
  approvals: ApprovalManager;
  runner?: UpgradeRunner;
  now?: () => number;
  selfPaths?: readonly string[];
};

export type UpgradeProposeInput = {
  workspace: string;
  runId: string;
  patch: string;
  verification: readonly string[];
  verificationTimeoutMs?: number;
};

export type UpgradeApplyInput = {
  workspace: string;
  runId: string;
  proposalId: string;
  signal?: AbortSignal;
  approvalId?: string;
  approvalConsumed?: boolean;
};

export type UpgradeApplyResult = UpgradeProposal & {
  status: "applied" | "failed";
  beforeHash: string;
  afterHash: string;
  verificationResult: UpgradeRunnerResult;
};
