export type Role = "system" | "user" | "assistant" | "tool";

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked_on_approval"
  | "budget_exhausted";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message = {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: string;
};

export type ModelRequest = {
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  temperature?: number;
};

export type ModelResponse = {
  message: Message;
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};
