import type { Tool } from "../tools/types";
import type { ToolDefinition } from "../protocol/types";

export type Risk = "low" | "standard" | "high";
export type RiskLevel = Risk;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export type PolicyContext = {
  workspace?: string;
  runId?: string;
  taskId?: string | null;
  now?: number;
  selfPaths?: readonly string[];
};

export type PolicyTool = ToolDefinition | Pick<Tool, "definition">;

export type Decision = {
  allowed: boolean;
  requiresApproval: boolean;
  capability: string;
  risk: Risk;
  reason: string;
  argumentsHash?: string;
};

export type ApprovalRequest = {
  id: string;
  runId: string;
  taskId?: string | null;
  tool: string;
  capability: string;
  risk: Risk;
  summary: string;
  argumentsHash: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  version: number;
  consumedAt?: number | null;
  expiredAt?: number | null;
};

export type ApprovalRequestInput = {
  id?: string;
  callId?: string;
  runId: string;
  taskId?: string | null;
  tool: string;
  capability?: string;
  risk: Risk;
  summary: string;
  arguments: Record<string, unknown>;
  createdAt?: number;
  expiresAt?: number;
};

export type ApprovalLookup = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  runId?: string;
};

export type ApprovalStoreRecord = {
  callId: string;
  argumentsHash: string;
  tool?: string;
  capability: string;
  riskLevel: string;
  taskId?: string | null;
  runId?: string | null;
  decision: "pending" | "approved" | "denied";
  requestedAt: number;
  expiresAt?: number;
  resolvedAt?: number | null;
  consumedAt?: number | null;
  expiredAt?: number | null;
  version?: number;
};

export type ApprovalStore = {
  saveApproval(record: ApprovalStoreRecord): ApprovalStoreRecord;
  getApproval(callId: string, argumentsHash: string): ApprovalStoreRecord | null;
  getApprovalByCallId(callId: string): ApprovalStoreRecord | null;
  updateApprovalDecision(
    callId: string,
    argumentsHash: string,
    expectedVersion: number,
    expectedDecision: "pending",
    decision: "approved" | "denied",
    now: number,
  ): ApprovalStoreRecord | null;
  consumeApproval(callId: string, argumentsHash: string, now: number, expectedVersion: number): ApprovalStoreRecord | null;
  expireApproval(callId: string, argumentsHash: string, now: number, expectedVersion: number): ApprovalStoreRecord | null;
};

export type ApprovalManagerOptions = {
  defaultExpiryMs?: number;
  now?: () => number;
};
