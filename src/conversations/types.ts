import type { RunOptions, RunSummary } from "../kernel/loop";
import type { ApprovalStatus, Risk } from "../policy/types";
import type { RunRecord, TaskRecord } from "../store/repository";

export type ConversationMessageRole = "user" | "assistant";
export type ConversationRole = ConversationMessageRole;

export type ConversationRecord = {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
};

export type ConversationMessageRecord = {
  conversationId: string;
  sequenceNumber: number;
  role: ConversationRole;
  content: string;
  runId: string | null;
  createdAt: number;
};

export type ConversationRunOptions = Pick<
  RunOptions,
  | "modelName"
  | "maxTurns"
  | "maxToolCalls"
  | "maxTokens"
  | "timeoutMs"
  | "toolTimeoutMs"
  | "contextBytes"
  | "userId"
>;

export type ConversationTurnInput = {
  content: string;
  title?: string;
  maxSteps?: number;
  runOptions?: ConversationRunOptions;
};

export type ConversationApprovalDecision = "approved" | "denied";

export type ConversationApprovalDetails = {
  callId: string;
  runId: string;
  taskId: string;
  tool: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  capability: string;
  risk: Risk;
  status: ApprovalStatus;
  reason: string;
  createdAt: number;
  expiresAt: number;
};

export type ConversationTurnResult = RunSummary & {
  conversationId: string;
  approval?: ConversationApprovalDetails;
};

export type SubmitTurnInput = ConversationTurnInput;
export type SubmitTurnResult = ConversationTurnResult;
export type ResolveApprovalDecision = ConversationApprovalDecision;

export type ConversationState = {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tasks: TaskRecord[];
  activeRun?: RunRecord;
  pendingApproval?: ConversationApprovalDetails;
};
