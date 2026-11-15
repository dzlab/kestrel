import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationService } from "../conversations/service";
import { KestrelError, ValidationError } from "../errors";
import type { StoreRepository } from "../store/repository";
import type { HttpAuth } from "./auth";
import { streamRunEvents } from "./events";
import { serveWorkspaceImage } from "./workspace-preview";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_CONVERSATION_RUNS = 50;

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

function requireConversation(repository: StoreRepository, conversationId: string) {
  const conversation = repository.getConversation(conversationId);
  if (conversation === null) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "conversation was not found");
  return conversation;
}

function requireOwnedRun(repository: StoreRepository, conversationId: string, runId: string) {
  requireConversation(repository, conversationId);
  const run = repository.getRun(runId);
  if (
    run === null ||
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
) {
  const state = conversations.getConversationState(conversationId);
  const runs = state.tasks.slice(-MAX_CONVERSATION_RUNS).flatMap((task) => {
    const run = repository.getLatestRunForTask(task.id);
    return run === null ? [] : [{
      id: run.id,
      taskId: run.taskId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    }];
  });
  return {
    conversation: state.conversation,
    messages: state.messages,
    runs,
    ...(state.activeRun === undefined ? {} : { activeRun: state.activeRun }),
    ...(state.pendingApproval === undefined ? {} : { pendingApproval: state.pendingApproval }),
  };
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

    const detailMatch = /^\/api\/conversations\/([^/]+)$/u.exec(url.pathname);
    if (detailMatch !== null && request.method === "GET") {
      if (url.search.length > 0) throw new ApiError(400, "INVALID_REQUEST", "conversation detail does not accept query parameters");
      const conversationId = pathSegment(detailMatch[1]!);
      requireConversation(repository, conversationId);
      sendJson(response, 200, conversationResponse(repository, conversations, conversationId));
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
      const callId = pathSegment(approvalMatch[3]!);
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

    const eventsMatch = /^\/api\/conversations\/([^/]+)\/runs\/([^/]+)\/events$/u.exec(url.pathname);
    if (eventsMatch !== null && request.method === "GET") {
      if (url.search.length > 0) throw new ApiError(400, "INVALID_REQUEST", "event stream does not accept query parameters");
      const conversationId = pathSegment(eventsMatch[1]!);
      const runId = pathSegment(eventsMatch[2]!);
      requireOwnedRun(repository, conversationId, runId);
      await streamRunEvents(request, response, repository, runId);
      return;
    }

    const imageMatch = /^\/api\/conversations\/([^/]+)\/workspace\/image$/u.exec(url.pathname);
    if (imageMatch !== null && request.method === "GET") {
      const conversationId = pathSegment(imageMatch[1]!);
      const conversation = requireConversation(repository, conversationId);
      const paths = url.searchParams.getAll("path");
      if (paths.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "path") || paths[0]!.length === 0) {
        throw new ApiError(400, "INVALID_REQUEST", "one workspace-relative image path is required");
      }
      serveWorkspaceImage(response, conversation.workspace, paths[0]!);
      return;
    }

    throw new ApiError(404, "NOT_FOUND", "API route was not found");
  };
}
