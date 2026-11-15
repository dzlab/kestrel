export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "blocked_on_approval"
  | "budget_exhausted"
  | "cancelled";

export type Conversation = {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
};

export type ConversationMessage = {
  conversationId: string;
  sequenceNumber: number;
  role: "user" | "assistant";
  content: string;
  contentTruncated: boolean;
  runId: string | null;
  createdAt: number;
};

export type RunSummary = {
  id: string;
  taskId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
};

export type PendingApproval = {
  approvalHandle: string;
  runId: string;
  taskId: string;
  tool: string;
  arguments?: Record<string, unknown>;
  argumentsBytes: number;
  argumentsTruncated: boolean;
  argumentsHash: string;
  capability: string;
  risk: "low" | "standard" | "high";
  status: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
};

export type ConversationDetail = {
  conversation: Conversation;
  messages: ConversationMessage[];
  runs: RunSummary[];
  activeRun?: RunSummary;
  pendingApproval?: PendingApproval;
  messagePage: {
    hasMore: boolean;
    nextCursor: number | null;
  };
};

export type RunEvent = {
  id: number;
  runId: string | null;
  taskId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
};

export type RunEventHistory = {
  events: RunEvent[];
  truncated: boolean;
};

export type StartedTurn = {
  conversationId: string;
  runId: string;
  status: RunStatus;
};

export type ApprovalResult = {
  conversationId: string;
  runId: string;
  approvalHandle: string;
  decision: "approve" | "deny";
  status: "running";
};

export type CancellationResult = {
  conversationId: string;
  runId: string;
  status: "cancelling";
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "INVALID_RESPONSE", `${label} was not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ApiError(502, "INVALID_RESPONSE", `${label} was not an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new ApiError(502, "INVALID_RESPONSE", `${label} was not a string`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApiError(502, "INVALID_RESPONSE", `${label} was not an integer`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ApiError(502, "INVALID_RESPONSE", `${label} was not a boolean`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

function runStatus(value: unknown): RunStatus {
  if (
    value !== "running" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "blocked_on_approval" &&
    value !== "budget_exhausted" &&
    value !== "cancelled"
  ) {
    throw new ApiError(502, "INVALID_RESPONSE", "run status was not recognized");
  }
  return value;
}

function conversation(value: unknown): Conversation {
  const item = record(value, "conversation");
  return {
    id: string(item.id, "conversation.id"),
    title: string(item.title, "conversation.title"),
    workspace: string(item.workspace, "conversation.workspace"),
    createdAt: number(item.createdAt, "conversation.createdAt"),
    updatedAt: number(item.updatedAt, "conversation.updatedAt"),
  };
}

function message(value: unknown): ConversationMessage {
  const item = record(value, "message");
  const role = string(item.role, "message.role");
  if (role !== "user" && role !== "assistant") {
    throw new ApiError(502, "INVALID_RESPONSE", "message role was not recognized");
  }
  return {
    conversationId: string(item.conversationId, "message.conversationId"),
    sequenceNumber: number(item.sequenceNumber, "message.sequenceNumber"),
    role,
    content: string(item.content, "message.content"),
    contentTruncated: item.contentTruncated === undefined ? false : boolean(item.contentTruncated, "message.contentTruncated"),
    runId: item.runId === null ? null : string(item.runId, "message.runId"),
    createdAt: number(item.createdAt, "message.createdAt"),
  };
}

function run(value: unknown): RunSummary {
  const item = record(value, "run");
  return {
    id: string(item.id, "run.id"),
    taskId: string(item.taskId, "run.taskId"),
    status: runStatus(item.status),
    startedAt: number(item.startedAt, "run.startedAt"),
    finishedAt: nullableNumber(item.finishedAt, "run.finishedAt"),
  };
}

function approval(value: unknown): PendingApproval {
  const item = record(value, "pending approval");
  const risk = string(item.risk, "pendingApproval.risk");
  if (risk !== "low" && risk !== "standard" && risk !== "high") {
    throw new ApiError(502, "INVALID_RESPONSE", "approval risk was not recognized");
  }
  return {
    approvalHandle: string(item.approvalHandle, "pendingApproval.approvalHandle"),
    runId: string(item.runId, "pendingApproval.runId"),
    taskId: string(item.taskId, "pendingApproval.taskId"),
    tool: string(item.tool, "pendingApproval.tool"),
    ...(item.arguments === undefined ? {} : { arguments: record(item.arguments, "pendingApproval.arguments") }),
    argumentsBytes: number(item.argumentsBytes, "pendingApproval.argumentsBytes"),
    argumentsTruncated: boolean(item.argumentsTruncated, "pendingApproval.argumentsTruncated"),
    argumentsHash: string(item.argumentsHash, "pendingApproval.argumentsHash"),
    capability: string(item.capability, "pendingApproval.capability"),
    risk,
    status: string(item.status, "pendingApproval.status"),
    reason: string(item.reason, "pendingApproval.reason"),
    createdAt: number(item.createdAt, "pendingApproval.createdAt"),
    expiresAt: number(item.expiresAt, "pendingApproval.expiresAt"),
  };
}

function detail(value: unknown): ConversationDetail {
  const item = record(value, "conversation detail");
  const page = record(item.messagePage, "conversation message page");
  return {
    conversation: conversation(item.conversation),
    messages: array(item.messages, "conversation messages").map(message),
    runs: array(item.runs, "conversation runs").map(run),
    ...(item.activeRun === undefined ? {} : { activeRun: run(item.activeRun) }),
    ...(item.pendingApproval === undefined ? {} : { pendingApproval: approval(item.pendingApproval) }),
    messagePage: {
      hasMore: boolean(page.hasMore, "messagePage.hasMore"),
      nextCursor: nullableNumber(page.nextCursor, "messagePage.nextCursor"),
    },
  };
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiError(response.status || 502, "INVALID_RESPONSE", "server returned invalid JSON");
  }
}

function parseError(value: unknown, status: number): ApiError {
  try {
    const body = record(value, "error response");
    const error = record(body.error, "error response.error");
    return new ApiError(status, string(error.code, "error.code"), string(error.message, "error.message"));
  } catch (cause) {
    if (cause instanceof ApiError && cause.code !== "INVALID_RESPONSE") return cause;
    return new ApiError(status, "REQUEST_FAILED", `request failed with status ${status}`);
  }
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new ApiError(502, "INVALID_RESPONSE", "approval argument chunk was not valid base64");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export class KestrelApi {
  private sessionPromise?: Promise<void>;
  private sessionRefresh?: Promise<void>;

  constructor(private readonly fetcher: FetchLike = fetch) {}

  bootstrapSession(): Promise<void> {
    this.sessionPromise ??= this.request("/api/session", undefined, (value) => {
      const response = record(value, "session response");
      if (response.authenticated !== true) {
        throw new ApiError(502, "INVALID_RESPONSE", "local session was not authenticated");
      }
    }).catch((error: unknown) => {
      this.sessionPromise = undefined;
      throw error;
    });
    return this.sessionPromise;
  }

  async rebootstrapSession(): Promise<void> {
    if (this.sessionRefresh !== undefined) return this.sessionRefresh;
    this.sessionPromise = undefined;
    const refresh = this.bootstrapSession();
    this.sessionRefresh = refresh;
    try {
      await refresh;
    } finally {
      if (this.sessionRefresh === refresh) this.sessionRefresh = undefined;
    }
  }

  async listConversations(limit = 50): Promise<Conversation[]> {
    await this.bootstrapSession();
    return this.request(`/api/conversations?limit=${encodeURIComponent(String(limit))}`, undefined, (value) => {
      const response = record(value, "conversation list");
      return array(response.conversations, "conversations").map(conversation);
    });
  }

  async createConversation(title?: string): Promise<Conversation> {
    await this.bootstrapSession();
    return this.request(
      "/api/conversations",
      { method: "POST", body: JSON.stringify(title === undefined ? {} : { title }) },
      (value) => conversation(record(value, "create conversation response").conversation),
    );
  }

  async getConversation(conversationId: string, cursor?: number): Promise<ConversationDetail> {
    await this.bootstrapSession();
    const suffix = cursor === undefined ? "" : `?cursor=${encodeURIComponent(String(cursor))}`;
    return this.request(`/api/conversations/${encodeURIComponent(conversationId)}${suffix}`, undefined, detail);
  }

  async submitTurn(conversationId: string, text: string): Promise<StartedTurn> {
    await this.bootstrapSession();
    return this.request(
      `/api/conversations/${encodeURIComponent(conversationId)}/turns`,
      { method: "POST", body: JSON.stringify({ text }) },
      (value) => {
        const response = record(value, "turn response");
        return {
          conversationId: string(response.conversationId, "turn.conversationId"),
          runId: string(response.runId, "turn.runId"),
          status: runStatus(response.status),
        };
      },
    );
  }

  async resolveApproval(
    conversationId: string,
    runId: string,
    pending: Pick<PendingApproval, "approvalHandle" | "argumentsHash">,
    decision: "approve" | "deny",
  ): Promise<ApprovalResult> {
    await this.bootstrapSession();
    const body = decision === "approve"
      ? { decision, argumentsHash: pending.argumentsHash }
      : { decision };
    return this.request(
      `/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(pending.approvalHandle)}`,
      { method: "POST", body: JSON.stringify(body) },
      (value) => {
        const response = record(value, "approval response");
        const parsedDecision = string(response.decision, "approval.decision");
        if (parsedDecision !== "approve" && parsedDecision !== "deny") {
          throw new ApiError(502, "INVALID_RESPONSE", "approval decision was not recognized");
        }
        if (response.status !== "running") {
          throw new ApiError(502, "INVALID_RESPONSE", "approval did not resume the run");
        }
        return {
          conversationId: string(response.conversationId, "approval.conversationId"),
          runId: string(response.runId, "approval.runId"),
          approvalHandle: string(response.approvalHandle, "approval.approvalHandle"),
          decision: parsedDecision,
          status: "running",
        };
      },
    );
  }

  async cancelRun(conversationId: string, runId: string): Promise<CancellationResult> {
    await this.bootstrapSession();
    return this.request(
      `/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", body: JSON.stringify({}) },
      (value) => {
        const response = record(value, "cancellation response");
        if (response.status !== "cancelling") {
          throw new ApiError(502, "INVALID_RESPONSE", "run was not cancelling");
        }
        return {
          conversationId: string(response.conversationId, "cancellation.conversationId"),
          runId: string(response.runId, "cancellation.runId"),
          status: "cancelling",
        };
      },
    );
  }

  async getApprovalArguments(
    conversationId: string,
    pending: PendingApproval,
  ): Promise<Record<string, unknown>> {
    if (pending.arguments !== undefined && !pending.argumentsTruncated) return pending.arguments;
    await this.bootstrapSession();
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let total: number | undefined;
    do {
      const query = new URLSearchParams({ offset: String(offset), limit: String(32 * 1024) });
      const chunk = await this.request(
        `/api/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(pending.runId)}/approvals/${encodeURIComponent(pending.approvalHandle)}/arguments?${query}`,
        undefined,
        (value) => {
          const response = record(value, "approval arguments response");
          if (string(response.approvalHandle, "approvalArguments.approvalHandle") !== pending.approvalHandle) {
            throw new ApiError(409, "APPROVAL_CHANGED", "pending approval changed while loading arguments");
          }
          if (string(response.argumentsHash, "approvalArguments.argumentsHash") !== pending.argumentsHash) {
            throw new ApiError(409, "APPROVAL_CHANGED", "approval arguments changed while loading");
          }
          if (response.encoding !== "base64") {
            throw new ApiError(502, "INVALID_RESPONSE", "approval arguments encoding was not recognized");
          }
          return {
            offset: number(response.offset, "approvalArguments.offset"),
            total: number(response.total, "approvalArguments.total"),
            nextOffset: nullableNumber(response.nextOffset, "approvalArguments.nextOffset"),
            complete: boolean(response.complete, "approvalArguments.complete"),
            data: decodeBase64(string(response.data, "approvalArguments.data")),
          };
        },
      );
      if (chunk.offset !== offset || (total !== undefined && chunk.total !== total)) {
        throw new ApiError(502, "INVALID_RESPONSE", "approval argument chunks were not contiguous");
      }
      total = chunk.total;
      chunks.push(chunk.data);
      const next = chunk.nextOffset;
      if (chunk.complete) {
        if (next !== null) throw new ApiError(502, "INVALID_RESPONSE", "completed approval arguments had another chunk");
        offset = chunk.total;
        break;
      }
      if (next === null || next <= offset) {
        throw new ApiError(502, "INVALID_RESPONSE", "approval argument cursor did not advance");
      }
      offset = next;
    } while (total === undefined || offset < total);

    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    if (total === undefined || bytes.length !== total || total !== pending.argumentsBytes) {
      throw new ApiError(502, "INVALID_RESPONSE", "approval argument payload length did not match");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ApiError(502, "INVALID_RESPONSE", "approval arguments were not valid UTF-8 JSON");
    }
    return record(parsed, "approval arguments");
  }

  static parseEvent(value: unknown): RunEvent {
    const event = record(value, "run event");
    return {
      id: number(event.id, "event.id"),
      runId: event.runId === null ? null : string(event.runId, "event.runId"),
      taskId: event.taskId === null ? null : string(event.taskId, "event.taskId"),
      type: string(event.type, "event.type"),
      payload: event.payload,
      createdAt: number(event.createdAt, "event.createdAt"),
    };
  }

  workspaceImageUrl(conversationId: string, path: string): string {
    const query = new URLSearchParams({ conversationId, path });
    return `/api/workspace/image?${query}`;
  }

  async getRunEventHistory(runId: string, limit = 500): Promise<RunEventHistory> {
    await this.bootstrapSession();
    return this.fetchRunEventHistory(runId, limit, true);
  }

  private async fetchRunEventHistory(runId: string, limit: number, retrySession: boolean): Promise<RunEventHistory> {
    const maximumBytes = 512 * 1024;
    const response = await this.fetcher(`/api/runs/${encodeURIComponent(runId)}/events`, {
      credentials: "same-origin",
      headers: { Accept: "text/event-stream" },
    });
    if (response.status === 401 && retrySession) {
      await this.rebootstrapSession();
      return this.fetchRunEventHistory(runId, limit, false);
    }
    if (!response.ok) throw parseError(await json(response), response.status);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw new ApiError(502, "INVALID_RESPONSE", "run history was not an event stream");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw new ApiError(502, "INVALID_RESPONSE", "run history stream had no body");

    const decoder = new TextDecoder();
    const events: RunEvent[] = [];
    let buffer = "";
    let bytes = 0;
    let truncated = false;
    const consumeFrames = (): void => {
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(data);
          } catch {
            throw new ApiError(502, "INVALID_EVENT", "run history event contained invalid JSON");
          }
          const parsed = KestrelApi.parseEvent(parsedJson);
          if (parsed.runId !== runId) throw new ApiError(502, "INVALID_EVENT", "run history contained an event for another run");
          if (!events.some((event) => event.id === parsed.id)) events.push(parsed);
          if (events.length >= limit) truncated = true;
        }
        if (truncated) return;
        boundary = buffer.indexOf("\n\n");
      }
    };

    try {
      while (!truncated) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maximumBytes) {
          truncated = true;
          break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        consumeFrames();
      }
      if (!truncated) {
        buffer += decoder.decode();
        consumeFrames();
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => undefined);
      else reader.releaseLock();
    }
    return { events: events.sort((left, right) => left.id - right.id), truncated };
  }

  private async request<T>(
    path: string,
    init: RequestInit | undefined,
    parse: (value: unknown) => T,
    retrySession = true,
  ): Promise<T> {
    const response = await this.fetcher(path, {
      credentials: "same-origin",
      ...init,
      headers: init?.body === undefined
        ? init?.headers
        : { "Content-Type": "application/json", ...init.headers },
    });
    const body = await json(response);
    if (response.status === 401 && path !== "/api/session" && retrySession) {
      await this.rebootstrapSession();
      return this.request(path, init, parse, false);
    }
    if (!response.ok) throw parseError(body, response.status);
    return parse(body);
  }
}
