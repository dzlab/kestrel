import { useMemo } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, CircleDashed, Terminal, XCircle } from "lucide-react";
import type { RunEvent } from "../api/client";

const MAX_RENDERED_OUTPUT = 12_000;
const STACK_KEY = /^(?:stack|stacktrace|errorstack)$/iu;
const STACK_LINE = /^(?:\s*at\s+(?:async\s+)?[^\s].*(?::\d+:\d+|\([^)]*:\d+:\d+\))\s*|\s*File "[^"]+", line \d+(?:, in .+)?\s*|\s*Traceback \(most recent call last\):\s*)$/u;

type ToolStatus = "running" | "completed" | "failed" | "cancelled";

export type ToolActivity = {
  key: string;
  firstEventId: number;
  name: string;
  status: ToolStatus;
  startedAt: number;
  finishedAt: number | null;
  result: unknown;
};

type TimelineEntry =
  | { kind: "tool"; id: number; activity: ToolActivity }
  | { kind: "run"; id: number; event: RunEvent };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventKey(event: RunEvent): string | null {
  const payload = asRecord(event.payload);
  return typeof payload?.callIdHash === "string" ? payload.callIdHash : null;
}

function withoutStackTrace(value: string): string {
  return value.split("\n").filter((line) => !STACK_LINE.test(line)).join("\n");
}

function safeStructuredValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return withoutStackTrace(value);
  if (Array.isArray(value)) return value.map((item) => safeStructuredValue(item, seen));
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular value hidden]";
  seen.add(value);
  const safe: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (STACK_KEY.test(key)) continue;
    safe[key] = safeStructuredValue(entry, seen);
  }
  seen.delete(value);
  return safe;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const safe = withoutStackTrace(value);
  if (safe.length <= MAX_RENDERED_OUTPUT) {
    return { text: safe, truncated: value.length >= 60_000 };
  }
  return { text: `${safe.slice(0, MAX_RENDERED_OUTPUT)}\n…`, truncated: true };
}

function jsonOutput(value: unknown): { text: string; truncated: boolean } | null {
  if (value === undefined) return null;
  try {
    return boundedText(JSON.stringify(safeStructuredValue(value), null, 2));
  } catch {
    return { text: "Structured result could not be displayed safely.", truncated: false };
  }
}

function resultParts(result: unknown) {
  const record = asRecord(result);
  const data = asRecord(record?.data);
  const stdout = typeof data?.stdout === "string" ? boundedText(data.stdout) : null;
  const stderr = typeof data?.stderr === "string" ? boundedText(data.stderr) : null;
  const remainingData = data === null
    ? record?.data
    : Object.fromEntries(Object.entries(data).filter(([key]) => key !== "stdout" && key !== "stderr"));
  return {
    content: typeof record?.content === "string" ? boundedText(record.content) : null,
    stdout,
    stderr,
    data: remainingData === undefined || (asRecord(remainingData) !== null && Object.keys(remainingData as Record<string, unknown>).length === 0)
      ? null
      : jsonOutput(remainingData),
    redactions: record?.redactions === undefined ? null : jsonOutput(record.redactions),
  };
}

export function collectToolActivities(events: readonly RunEvent[]): ToolActivity[] {
  const activities = new Map<string, ToolActivity>();
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    if (!event.type.startsWith("tool.")) continue;
    const key = eventKey(event) ?? `event:${event.id}`;
    const payload = asRecord(event.payload);
    const existing = activities.get(key);
    const activity = existing ?? {
      key,
      firstEventId: event.id,
      name: typeof payload?.name === "string" ? payload.name : "Tool call",
      status: "running" as ToolStatus,
      startedAt: event.createdAt,
      finishedAt: null,
      result: null,
    };
    if (typeof payload?.name === "string") activity.name = payload.name;
    if (event.type === "tool.completed") {
      activity.status = payload?.ok === false ? "failed" : "completed";
      activity.finishedAt = event.createdAt;
      activity.result = payload?.result;
    } else if (event.type === "tool.cancelled") {
      activity.status = "cancelled";
      activity.finishedAt = event.createdAt;
    }
    activities.set(key, activity);
  }
  return [...activities.values()].sort((left, right) => left.firstEventId - right.firstEventId);
}

function collectTimeline(events: readonly RunEvent[]): TimelineEntry[] {
  const tools = collectToolActivities(events);
  const entries: TimelineEntry[] = tools.map((activity) => ({ kind: "tool", id: activity.firstEventId, activity }));
  for (const event of events) {
    if (event.type.startsWith("run.")) entries.push({ kind: "run", id: event.id, event });
  }
  return entries.sort((left, right) => left.id - right.id);
}

export function collectObservedChangedFiles(events: readonly RunEvent[]): string[] {
  const files = new Set<string>();
  for (const activity of collectToolActivities(events)) {
    if (activity.status !== "completed" || (activity.name !== "fs.write" && activity.name !== "fs.patch")) continue;
    const result = asRecord(activity.result);
    if (result?.ok !== true) continue;
    const data = result.data;
    if (activity.name === "fs.write") {
      const path = asRecord(data)?.path;
      if (typeof path === "string" && path.length > 0) files.add(path);
    } else if (Array.isArray(data)) {
      for (const path of data) if (typeof path === "string" && path.length > 0) files.add(path);
    }
  }
  return [...files].slice(0, 50);
}

function statusIcon(status: ToolStatus) {
  if (status === "running") return <CircleDashed className="spin" size={16} aria-hidden="true" />;
  if (status === "completed") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (status === "failed") return <AlertCircle size={16} aria-hidden="true" />;
  return <XCircle size={16} aria-hidden="true" />;
}

function Output({ label, output }: Readonly<{ label: string; output: { text: string; truncated: boolean } | null }>) {
  if (output === null || output.text.length === 0) return null;
  return (
    <section className="tool-output">
      <div><span>{label}</span>{output.truncated && <strong>Truncated</strong>}</div>
      <pre>{output.text}</pre>
    </section>
  );
}

export function ToolActivityCard({ activity }: Readonly<{ activity: ToolActivity }>) {
  const output = useMemo(() => resultParts(activity.result), [activity.result]);
  return (
    <details className={`activity-card tool-activity ${activity.status}`} open={activity.status === "running" || activity.status === "failed"}>
      <summary>
        <span className="activity-icon">{statusIcon(activity.status)}</span>
        <span><strong>{activity.name}</strong><small>{activity.status}</small></span>
        <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(activity.startedAt)}</time>
        <ChevronRight className="activity-chevron" size={15} aria-hidden="true" />
      </summary>
      <div className="activity-body">
        <Output label="Result" output={output.content} />
        <Output label="stdout" output={output.stdout} />
        <Output label="stderr" output={output.stderr} />
        <Output label="Data" output={output.data} />
        <Output label="Redactions" output={output.redactions} />
        {output.content === null && output.stdout === null && output.stderr === null && output.data === null && (
          <p className="activity-empty">No bounded output was recorded.</p>
        )}
      </div>
    </details>
  );
}

function runEventLabel(type: string): string {
  switch (type) {
    case "run.started": return "Run started";
    case "run.blocked_on_approval": return "Waiting for approval";
    case "run.completed": return "Run completed";
    case "run.failed": return "Run failed";
    case "run.cancelled": return "Run cancelled";
    case "run.budget_exhausted": return "Run budget exhausted";
    default: return type.replaceAll(".", " ");
  }
}

function RunActivityCard({ event }: Readonly<{ event: RunEvent }>) {
  const payload = asRecord(event.payload);
  const detail = typeof payload?.reason === "string"
    ? boundedText(payload.reason)
    : typeof payload?.error === "string"
      ? boundedText(payload.error)
      : null;
  return (
    <div className={`activity-card run-activity ${event.type.replaceAll(".", "-")}`}>
      <span className="activity-icon"><Terminal size={15} aria-hidden="true" /></span>
      <span><strong>{runEventLabel(event.type)}</strong>{detail !== null && <small>{detail.text}</small>}</span>
      <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(event.createdAt)}</time>
    </div>
  );
}

export function RunActivityFeed({ events }: Readonly<{ events: readonly RunEvent[] }>) {
  const timeline = useMemo(() => collectTimeline(events), [events]);
  if (timeline.length === 0) return null;
  return (
    <section className="activity-feed" aria-label="Run activity">
      <div className="activity-feed-heading"><span>Run activity</span><small>{timeline.length} item{timeline.length === 1 ? "" : "s"}</small></div>
      {timeline.map((entry) => entry.kind === "tool"
        ? <ToolActivityCard key={`tool:${entry.activity.key}`} activity={entry.activity} />
        : <RunActivityCard key={`run:${entry.event.id}`} event={entry.event} />)}
    </section>
  );
}
