import { ApiError, KestrelApi, type RunEvent } from "./client";

const RUN_EVENT_TYPES = [
  "run.started",
  "model.requested",
  "model.responded",
  "tool.started",
  "tool.completed",
  "tool.cancelled",
  "run.blocked_on_approval",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.budget_exhausted",
] as const;

const TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.budget_exhausted",
]);

export type RunEventStreamHandlers = {
  onEvent(event: RunEvent): void;
  onConnectionChange(state: "connected" | "disconnected"): void;
  onReconnect(): void | Promise<void>;
  onError(error: ApiError): void;
};

export class RunEventStream {
  private source?: EventSource;
  private opened = false;
  private closed = false;
  private lastId = 0;

  constructor(
    private readonly runId: string,
    private readonly handlers: RunEventStreamHandlers,
  ) {}

  get lastEventId(): number {
    return this.lastId;
  }

  connect(): void {
    if (this.closed || this.source !== undefined) return;
    const source = new EventSource(`/api/runs/${encodeURIComponent(this.runId)}/events`, {
      withCredentials: true,
    });
    this.source = source;

    source.onopen = () => {
      const reconnected = this.opened;
      this.opened = true;
      this.handlers.onConnectionChange("connected");
      if (reconnected) void this.handlers.onReconnect();
    };
    source.onerror = () => {
      if (this.closed) return;
      this.handlers.onConnectionChange("disconnected");
      // Keep this EventSource alive: the browser's native retry retains and sends
      // Last-Event-ID, which cannot be set on a newly constructed EventSource.
    };
    const receive = (browserEvent: Event): void => {
      if (!(browserEvent instanceof MessageEvent) || this.closed) return;
      try {
        const parsed = KestrelApi.parseEvent(JSON.parse(browserEvent.data) as unknown);
        if (parsed.runId !== this.runId) {
          throw new ApiError(502, "INVALID_EVENT", "event belonged to a different run");
        }
        if (parsed.id <= this.lastId) return;
        this.lastId = parsed.id;
        this.handlers.onEvent(parsed);
        if (TERMINAL_EVENT_TYPES.has(parsed.type)) this.close();
      } catch (error) {
        this.handlers.onError(
          error instanceof ApiError
            ? error
            : new ApiError(502, "INVALID_EVENT", "run event contained invalid JSON"),
        );
      }
    };
    for (const eventType of RUN_EVENT_TYPES) source.addEventListener(eventType, receive);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source?.close();
    this.source = undefined;
  }
}
