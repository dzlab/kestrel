import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationService } from "../conversations/service";
import type {
  ConversationApprovalDetails,
  ConversationMessageRecord,
  ConversationRecord,
} from "../conversations/types";
import { KestrelError, ValidationError } from "../errors";
import type { RunRecord, StoreRepository } from "../store/repository";
import { truncateUtf8 } from "../tools/types";
import type { HttpAuth } from "./auth";
import { streamRunEvents } from "./events";
import { serveWorkspaceImage } from "./workspace-preview";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_CONVERSATION_RUNS = 50;
const MAX_APPROVAL_CALL_ID_BYTES = 256;
const MAX_CONVERSATION_DETAIL_BYTES = 256 * 1024;
const MAX_CONVERSATION_MESSAGE_PAGE = 100;
const MAX_MESSAGE_CONTENT_JSON_BYTES = 32 * 1024;
const MAX_APPROVAL_ARGUMENTS_JSON_BYTES = 64 * 1024;

type ApiErrorBody = { error: { code: string; message: string } };

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ApiRouterDependencies = {
  repository: StoreRepository;
  conversations: ConversationService;
  workspace: string;
  auth: HttpAuth;
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "request failed";
  return message.replace(/[\r\n]+/gu, " ").slice(0, 1_024) || "request failed";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

function boundedJsonString(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  if (jsonBytes(value) <= maximumBytes) return { value, truncated: false };
  let low = 0;
  let high = Buffer.byteLength(value, "utf8");
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf8(value, middle);
    if (jsonBytes(candidate) <= maximumBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { value: best, truncated: true };
}

function boundedConversation(conversation: ConversationRecord) {
  return {
    ...conversation,
    id: boundedJsonString(conversation.id, 512).value,
    title: boundedJsonString(conversation.title, 4_096).value,
    workspace: boundedJsonString(conversation.workspace, 8_192).value,
  };
}

function boundedRun(run: RunRecord) {
  return {
    id: boundedJsonString(run.id, 512).value,
    taskId: boundedJsonString(run.taskId, 512).value,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

function boundedApproval(approval: ConversationApprovalDetails) {
  const argumentsTruncated = jsonBytes(approval.arguments) > MAX_APPROVAL_ARGUMENTS_JSON_BYTES;
  return {
    ...approval,
    callId: boundedJsonString(approval.callId, 1_024).value,
    runId: boundedJsonString(approval.runId, 512).value,
    taskId: boundedJsonString(approval.taskId, 512).value,
    tool: boundedJsonString(approval.tool, 1_024).value,
    arguments: argumentsTruncated ? {} : approval.arguments,
    ...(argumentsTruncated ? { argumentsTruncated: true } : {}),
    argumentsHash: boundedJsonString(approval.argumentsHash, 1_024).value,
    capability: boundedJsonString(approval.capability, 1_024).value,
    reason: boundedJsonString(approval.reason, 8_192).value,
  };
}

function boundedConversationMessage(message: ConversationMessageRecord) {
  const content = boundedJsonString(message.content, MAX_MESSAGE_CONTENT_JSON_BYTES);
  return {
    ...message,
    conversationId: boundedJsonString(message.conversationId, 512).value,
    content: content.value,
    runId: message.runId === null ? null : boundedJsonString(message.runId, 512).value,
    ...(content.truncated ? { contentTruncated: true } : {}),
  };
}

export function sendApiError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  let status = 500;
  let code = "INTERNAL_ERROR";
  let message = "request failed";
  if (error instanceof ApiError) {
    ({ status, code } = error);
    message = safeMessage(error);
  } else if (error instanceof ValidationError) {
    status = 400;
    code = error.code;
    message = safeMessage(error);
  } else if (error instanceof KestrelError) {
    code = error.code;
    message = safeMessage(error);
  }
  sendJson(response, status, { error: { code, message } } satisfies ApiErrorBody);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "INVALID_REQUEST", "request body contains unknown fields");
  }
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ApiError(400, "INVALID_REQUEST", "Content-Length is invalid");
    }
    if (bytes > MAX_JSON_BODY_BYTES) throw new ApiError(413, "BODY_TOO_LARGE", "request body is too large");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_JSON_BODY_BYTES) throw new ApiError(413, "BODY_TOO_LARGE", "request body is too large");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_REQUEST", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readOptionalJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"];
  const contentLength = request.headers["content-length"];
  if (
    contentType === undefined &&
    (contentLength === undefined || contentLength === "0") &&
    request.headers["transfer-encoding"] === undefined
  ) {
    return {};
  }
  return readJsonObject(request);
}

function pathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.length === 0 || decoded.includes("/") || decoded.includes("\0")) throw new Error("invalid");
    return decoded;
  } catch {
    throw new ApiError(404, "NOT_FOUND", "API route was not found");
  }
}

function approvalCallIdSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (
      decoded.length === 0 ||
      decoded.includes("\0") ||
      Buffer.byteLength(decoded, "utf8") > MAX_APPROVAL_CALL_ID_BYTES
    ) {
      throw new Error("invalid");
    }
    return decoded;
  } catch {
    throw new ApiError(404, "NOT_FOUND", "API route was not found");
  }
}

function requireConversation(repository: StoreRepository, conversationId: string) {
  const conversation = repository.getConversation(conversationId);
  if (conversation === null) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "conversation was not found");
  return conversation;
}

function requireRun(repository: StoreRepository, runId: string) {
  const run = repository.getRun(runId);
  if (run === null) throw new ApiError(404, "RUN_NOT_FOUND", "run was not found");
  return run;
}

function requireOwnedRun(repository: StoreRepository, conversationId: string, runId: string) {
  requireConversation(repository, conversationId);
  const run = requireRun(repository, runId);
  if (
    !repository.listConversationTasks(conversationId, 1_000).some((task) => task.id === run.taskId)
  ) {
    throw new ApiError(404, "RUN_NOT_FOUND", "run was not found for this conversation");
  }
  return run;
}

async function detachAfterStart(operation: Promise<unknown>): Promise<void> {
  let rejected = false;
  let rejection: unknown;
  void operation.catch((error: unknown) => {
    rejected = true;
    rejection = error;
  });
  await Promise.resolve();
  if (rejected) throw rejection;
}

function requireSameOrigin(auth: HttpAuth, request: IncomingMessage): void {
  if (!auth.validateStateChangingRequest(request.headers)) {
    throw new ApiError(403, "ORIGIN_REJECTED", "request origin was rejected");
  }
}

function conversationResponse(
  repository: StoreRepository,
  conversations: ConversationService,
  conversationId: string,
  beforeSequence: number | null,
) {
  const state = conversations.getConversationState(conversationId, 1);
  const runs = state.tasks.slice(-MAX_CONVERSATION_RUNS).flatMap((task) => {
    const run = repository.getLatestRunForTask(task.id);
    return run === null ? [] : [boundedRun(run)];
  });
  const page = repository.listConversationMessagesBefore(
    conversationId,
    beforeSequence,
    MAX_CONVERSATION_MESSAGE_PAGE,
  );
  const base = {
    conversation: boundedConversation(state.conversation),
    runs,
    ...(state.activeRun === undefined ? {} : { activeRun: boundedRun(state.activeRun) }),
    ...(state.pendingApproval === undefined ? {} : { pendingApproval: boundedApproval(state.pendingApproval) }),
  };
  let messages: ReturnType<typeof boundedConversationMessage>[] = [];
  for (let index = page.messages.length - 1; index >= 0; index -= 1) {
    const candidate = [boundedConversationMessage(page.messages[index]!), ...messages];
    const hasMore = page.hasMore || index > 0;
    const response = {
      ...base,
      messages: candidate,
      messagePage: {
        hasMore,
        nextCursor: hasMore ? candidate[0]!.sequenceNumber : null,
      },
    };
    if (jsonBytes(response) > MAX_CONVERSATION_DETAIL_BYTES) break;
    messages = candidate;
  }
  const hasMore = page.hasMore || messages.length < page.messages.length;
  const response = {
    ...base,
    messages,
    messagePage: {
      hasMore,
      nextCursor: hasMore && messages.length > 0 ? messages[0]!.sequenceNumber : null,
    },
  };
  if (jsonBytes(response) > MAX_CONVERSATION_DETAIL_BYTES) {
    throw new ApiError(500, "RESPONSE_TOO_LARGE", "conversation metadata exceeds the response size limit");
  }
  return response;
}

export function createApiRouter(dependencies: ApiRouterDependencies) {
  const { repository, conversations, workspace, auth } = dependencies;

  return async function routeApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!auth.validateHost(request.headers)) throw new ApiError(403, "HOST_REJECTED", "request host was rejected");

    if (url.pathname === "/api/session" && request.method === "GET") {
      if (url.search.length > 0) throw new ApiError(400, "INVALID_REQUEST", "session bootstrap does not accept query parameters");
      auth.setSessionCookie(response);
      sendJson(response, 200, { authenticated: true });
      return;
    }
    if (!auth.validateSession(request.headers)) {
      throw new ApiError(401, "UNAUTHORIZED", "a valid local session is required");
    }
    if (request.method === "POST" && url.search.length > 0) {
      throw new ApiError(400, "INVALID_REQUEST", "state-changing API routes do not accept query parameters");
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      const values = url.searchParams.getAll("limit");
      if ([...url.searchParams.keys()].some((key) => key !== "limit") || values.length > 1) {
        throw new ApiError(400, "INVALID_REQUEST", "invalid conversation list query");
      }
      const limitValue = values[0] ?? "50";
      if (!/^[1-9]\d*$/u.test(limitValue)) throw new ApiError(400, "INVALID_REQUEST", "limit must be a positive integer");
      const limit = Number(limitValue);
      sendJson(response, 200, { conversations: repository.listConversations(limit) });
      return;
    }

    if (url.pathname === "/api/conversations" && request.method === "POST") {
      requireSameOrigin(auth, request);
      const body = await readOptionalJsonObject(request);
      assertExactKeys(body, ["title"]);
      if (body.title !== undefined && (typeof body.title !== "string" || body.title.trim().length === 0)) {
        throw new ApiError(400, "INVALID_REQUEST", "title must be a non-empty string");
      }
      const conversation = repository.createConversation({
        title: typeof body.title === "string" ? body.title.trim().slice(0, 256) : "New conversation",
        workspace,
      });
      sendJson(response, 201, { conversation });
      return;
    }

    const directEventsMatch = /^\/api\/runs\/([^/]+)\/events$/u.exec(url.pathname);
    if (directEventsMatch !== null && request.method === "GET") {
      if (url.search.length > 0) throw new ApiError(400, "INVALID_REQUEST", "event stream does not accept query parameters");
      const runId = pathSegment(directEventsMatch[1]!);
      if (repository.getConversationForRun(runId) === null) {
        throw new ApiError(404, "RUN_NOT_FOUND", "conversation run was not found");
      }
      await streamRunEvents(request, response, repository, runId);
      return;
    }

    if (url.pathname === "/api/workspace/image" && request.method === "GET") {
      const conversationIds = url.searchParams.getAll("conversationId");
      const paths = url.searchParams.getAll("path");
      if (
        conversationIds.length !== 1 ||
        paths.length !== 1 ||
        [...url.searchParams.keys()].some((key) => key !== "conversationId" && key !== "path") ||
        conversationIds[0]!.length === 0 ||
        paths[0]!.length === 0
      ) {
        throw new ApiError(400, "INVALID_REQUEST", "one conversation ID and workspace-relative image path are required");
      }
      const conversation = requireConversation(repository, pathSegment(conversationIds[0]!));
      serveWorkspaceImage(response, conversation.workspace, paths[0]!);
      return;
    }

    const detailMatch = /^\/api\/conversations\/([^/]+)$/u.exec(url.pathname);
    if (detailMatch !== null && request.method === "GET") {
      const cursorValues = url.searchParams.getAll("cursor");
      if ([...url.searchParams.keys()].some((key) => key !== "cursor") || cursorValues.length > 1) {
        throw new ApiError(400, "INVALID_REQUEST", "invalid conversation detail query");
      }
      const cursorValue = cursorValues[0];
      if (cursorValue !== undefined && !/^(?:0|[1-9]\d*)$/u.test(cursorValue)) {
        throw new ApiError(400, "INVALID_REQUEST", "cursor must be a non-negative integer");
      }
      const cursor = cursorValue === undefined ? null : Number(cursorValue);
      if (cursor !== null && !Number.isSafeInteger(cursor)) {
        throw new ApiError(400, "INVALID_REQUEST", "cursor is too large");
      }
      const conversationId = pathSegment(detailMatch[1]!);
      requireConversation(repository, conversationId);
      sendJson(response, 200, conversationResponse(repository, conversations, conversationId, cursor));
      return;
    }

    const turnMatch = /^\/api\/conversations\/([^/]+)\/turns$/u.exec(url.pathname);
    if (turnMatch !== null && request.method === "POST") {
      requireSameOrigin(auth, request);
      const conversationId = pathSegment(turnMatch[1]!);
      requireConversation(repository, conversationId);
      const before = conversations.getConversationState(conversationId);
      if (before.activeRun !== undefined) throw new ApiError(409, "CONVERSATION_BUSY", "conversation already has an active turn");
      const priorTaskIds = new Set(before.tasks.map((task) => task.id));
      const body = await readJsonObject(request);
      assertExactKeys(body, ["text"]);
      if (typeof body.text !== "string" || body.text.trim().length === 0) {
        throw new ApiError(400, "INVALID_REQUEST", "text must be a non-empty string");
      }
      const operation = conversations.submitTurn(conversationId, { content: body.text });
      await detachAfterStart(operation);
      const startedState = conversations.getConversationState(conversationId);
      const startedTask = startedState.tasks.find((task) => !priorTaskIds.has(task.id));
      const startedRun = startedState.activeRun ?? (
        startedTask === undefined ? null : repository.getLatestRunForTask(startedTask.id)
      );
      if (startedRun === null || startedRun === undefined) {
        throw new ApiError(500, "TURN_START_FAILED", "conversation turn did not start");
      }
      sendJson(response, 202, { conversationId, runId: startedRun.id, status: startedRun.status });
      return;
    }

    const approvalMatch = /^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/approvals\/([^/]+)$/u.exec(url.pathname);
    if (approvalMatch !== null && request.method === "POST") {
      requireSameOrigin(auth, request);
      const conversationId = pathSegment(approvalMatch[1]!);
      const runId = pathSegment(approvalMatch[2]!);
      const callId = approvalCallIdSegment(approvalMatch[3]!);
      requireOwnedRun(repository, conversationId, runId);
      const state = conversations.getConversationState(conversationId);
      if (state.activeRun?.id !== runId || state.pendingApproval?.callId !== callId) {
        throw new ApiError(404, "APPROVAL_NOT_FOUND", "pending approval was not found for this run");
      }
      const body = await readJsonObject(request);
      assertExactKeys(body, ["decision"]);
      if (body.decision !== "approve" && body.decision !== "deny") {
        throw new ApiError(400, "INVALID_REQUEST", "decision must be approve or deny");
      }
      const operation = conversations.resolveApproval(
        conversationId,
        callId,
        body.decision === "approve" ? "approved" : "denied",
      );
      await detachAfterStart(operation);
      sendJson(response, 202, { conversationId, runId, callId, decision: body.decision, status: "running" });
      return;
    }

    const cancelMatch = /^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/cancel$/u.exec(url.pathname);
    if (cancelMatch !== null && request.method === "POST") {
      requireSameOrigin(auth, request);
      const conversationId = pathSegment(cancelMatch[1]!);
      const runId = pathSegment(cancelMatch[2]!);
      requireOwnedRun(repository, conversationId, runId);
      const body = await readOptionalJsonObject(request);
      assertExactKeys(body, []);
      const operation = conversations.cancelRun(conversationId, runId);
      await detachAfterStart(operation);
      sendJson(response, 202, { conversationId, runId, status: "cancelling" });
      return;
    }

    throw new ApiError(404, "NOT_FOUND", "API route was not found");
  };
}
