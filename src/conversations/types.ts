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
