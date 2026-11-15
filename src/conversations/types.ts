import type { RunOptions, RunSummary } from "../kernel/loop";
import type { ApprovalRequest } from "../policy/types";
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

export type ConversationRunOptions = Omit<
  RunOptions,
  "runId" | "idempotencyKey" | "initialMessages" | "signal"
>;

export type ConversationTurnInput = {
  content: string;
  title?: string;
  maxSteps?: number;
  runOptions?: ConversationRunOptions;
};

export type ConversationApprovalDecision = "approved" | "denied";

export type ConversationTurnResult = RunSummary & {
  conversationId: string;
  approval?: ApprovalRequest;
};

export type SubmitTurnInput = ConversationTurnInput;
export type SubmitTurnResult = ConversationTurnResult;
export type ResolveApprovalDecision = ConversationApprovalDecision;

export type ConversationState = {
  conversation: ConversationRecord;
  messages: ConversationMessageRecord[];
  tasks: TaskRecord[];
  activeRun?: RunRecord;
  pendingApproval?: ApprovalRequest;
};
