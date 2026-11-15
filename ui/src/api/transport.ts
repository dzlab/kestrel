import {
  KestrelApi,
  type ApprovalResult,
  type CancellationResult,
  type Conversation,
  type ConversationDetail,
  type PendingApproval,
  type RunEventHistory,
  type StartedTurn,
} from "./client";
import {
  RunEventStream,
  type RunEventStreamHandlers,
} from "./events";

export type RunEventSubscription = {
  readonly lastEventId: number;
  connect(): void;
  close(): void;
};

export interface KestrelTransport {
  bootstrapSession(): Promise<void>;
  rebootstrapSession(): Promise<void>;
  listConversations(limit?: number): Promise<Conversation[]>;
  createConversation(title?: string): Promise<Conversation>;
  getConversation(conversationId: string, cursor?: number): Promise<ConversationDetail>;
  submitTurn(conversationId: string, text: string): Promise<StartedTurn>;
  resolveApproval(
    conversationId: string,
    runId: string,
    pending: Pick<PendingApproval, "approvalHandle" | "argumentsHash">,
    decision: "approve" | "deny",
  ): Promise<ApprovalResult>;
  cancelRun(conversationId: string, runId: string): Promise<CancellationResult>;
  getApprovalArguments(
    conversationId: string,
    pending: PendingApproval,
  ): Promise<Record<string, unknown>>;
  getRunEventHistory(runId: string, limit?: number): Promise<RunEventHistory>;
  workspaceImageUrl(conversationId: string, path: string): string;
  createRunEventStream(runId: string, handlers: RunEventStreamHandlers): RunEventSubscription;
}

export class LocalKestrelTransport extends KestrelApi implements KestrelTransport {
  createRunEventStream(runId: string, handlers: RunEventStreamHandlers): RunEventSubscription {
    return new RunEventStream(runId, handlers);
  }
}
