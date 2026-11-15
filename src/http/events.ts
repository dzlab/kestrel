import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { ValidationError } from "../errors";
import type { EventRecord, StoreRepository } from "../store/repository";
import { redactUnknown } from "../tools/redaction";

const EVENT_PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_TERMINAL_EVENT_POLLS = 10;

function eventCursor(request: IncomingMessage): number {
  const value = request.headers["last-event-id"];
  if (value === undefined || value === "") return 0;
  if (Array.isArray(value) || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ValidationError("Last-Event-ID must be a non-negative integer");
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new ValidationError("Last-Event-ID is too large");
  return cursor;
}

function isTrueTerminal(status: string): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "budget_exhausted";
}

function hasTerminalEvent(repository: StoreRepository, runId: string, status: string): boolean {
  return repository.hasRunEvent(runId, `run.${status}`);
}

async function writeEventChunk(response: ServerResponse, chunk: string): Promise<void> {
  if (response.write(chunk)) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      response.removeListener("drain", finish);
      response.removeListener("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
}

function browserEvent(event: EventRecord, storedCallIds: ReadonlyMap<string, string>): EventRecord {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) return event;
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.callId !== "string") return event;
  const { callId, ...rest } = payload;
  const storedCallId = storedCallIds.get(callId);
  return {
    ...event,
    payload: {
      ...rest,
      callIdHash: createHash("sha256").update(storedCallId ?? callId).digest("hex"),
    },
  };
}

export async function streamRunEvents(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoreRepository,
  runId: string,
): Promise<void> {
  let cursor = eventCursor(request);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.flushHeaders();
  response.write(": connected\n\n");

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wakeTimer: (() => void) | undefined;
  let lastHeartbeat = Date.now();
  let terminalEventPolls = 0;
  const close = (): void => {
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      wakeTimer?.();
      wakeTimer = undefined;
    }
  };
  request.once("aborted", close);
  request.once("close", close);
  response.once("close", close);

  try {
    while (!closed) {
      let pageLength = 0;
      do {
        const events = repository.getEventsAfter(runId, cursor, EVENT_PAGE_SIZE);
        const storedCallIds = new Map<string, string>();
        for (const call of repository.getToolCalls(runId)) {
          storedCallIds.set(call.callId, call.callId);
          const redacted = redactUnknown(call.callId);
          if (typeof redacted === "string") storedCallIds.set(redacted, call.callId);
        }
        pageLength = events.length;
        for (const storedEvent of events) {
          const event = browserEvent(storedEvent, storedCallIds);
          cursor = event.id;
          const eventName = event.type.replace(/[^A-Za-z0-9_.-]/gu, "_");
          await writeEventChunk(
            response,
            `id: ${event.id}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`,
          );
          if (closed) break;
        }
      } while (!closed && pageLength === EVENT_PAGE_SIZE);

      const run = repository.getRun(runId);
      if (run === null) break;
      if (isTrueTerminal(run.status)) {
        if (hasTerminalEvent(repository, runId, run.status) || terminalEventPolls >= MAX_TERMINAL_EVENT_POLLS) break;
        terminalEventPolls += 1;
      } else {
        terminalEventPolls = 0;
      }
      if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        await writeEventChunk(response, ": heartbeat\n\n");
        lastHeartbeat = Date.now();
      }
      await new Promise<void>((resolve) => {
        wakeTimer = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          wakeTimer = undefined;
          resolve();
        }, POLL_INTERVAL_MS);
      });
    }
  } finally {
    close();
    request.removeListener("aborted", close);
    request.removeListener("close", close);
    response.removeListener("close", close);
    if (!response.writableEnded) response.end();
  }
}
