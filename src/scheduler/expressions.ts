import { ValidationError } from "../errors";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { ScheduleRecord } from "../store/repository";

export const MIN_SCHEDULE_INTERVAL_MS = 60_000;
export const MAX_SCHEDULE_PROMPT_BYTES = 4_096;
export const MAX_SCHEDULE_NAME_LENGTH = 120;
export const MAX_SCHEDULE_ATTEMPTS = 3;

export function validateScheduleWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || workspace.trim().length === 0 || workspace.includes("\0")) {
    throw new ValidationError("schedule workspace must be a non-empty path");
  }
  const requested = workspace.trim();
  if (!existsSync(requested) || !lstatSync(requested).isDirectory()) {
    throw new ValidationError("schedule workspace must be an existing directory");
  }
  return realpathSync(requested);
}

type ScheduleExpression = {
  intervalMs?: number;
  rrule?: string;
  at?: string;
  timeZone: string;
};

const frequencyMs: Record<string, number> = {
  MINUTELY: 60_000,
  HOURLY: 60 * 60_000,
  DAILY: 24 * 60 * 60_000,
  WEEKLY: 7 * 24 * 60 * 60_000,
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("schedule input must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string, maxLength?: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ValidationError(`${name} must be non-empty`);
  const normalized = value.trim();
  if (maxLength !== undefined && normalized.length > maxLength) throw new ValidationError(`${name} is too long`);
  return normalized;
}

function timezone(value: unknown): string {
  const result = stringValue(value, "timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result }).format();
  } catch (error) {
    throw new ValidationError(`invalid timezone: ${result}`, { cause: error });
  }
  return result;
}

function parseRrule(value: unknown): { rrule: string; intervalMs: number } {
  const source = stringValue(value, "rrule", 256).toUpperCase();
  const fields = new Map<string, string>();
  for (const field of source.split(";")) {
    const [key, fieldValue, ...extra] = field.split("=");
    if (extra.length !== 0 || key === undefined || fieldValue === undefined || fields.has(key)) {
      throw new ValidationError("rrule contains an unsafe expression");
    }
    fields.set(key, fieldValue);
  }
  if ([...fields.keys()].some((key) => key !== "FREQ" && key !== "INTERVAL")) {
    throw new ValidationError("rrule contains an unsupported expression");
  }
  const frequency = fields.get("FREQ");
  const unit = frequency === undefined ? undefined : frequencyMs[frequency];
  if (unit === undefined) throw new ValidationError("rrule frequency is unsupported");
  const intervalText = fields.get("INTERVAL") ?? "1";
  if (!/^\d+$/u.test(intervalText)) throw new ValidationError("rrule interval is invalid");
  const interval = Number(intervalText);
  if (!Number.isSafeInteger(interval) || interval <= 0 || unit * interval < MIN_SCHEDULE_INTERVAL_MS) {
    throw new ValidationError(`rrule interval must be at least ${MIN_SCHEDULE_INTERVAL_MS}ms`);
  }
  return { rrule: `FREQ=${frequency};INTERVAL=${interval}`, intervalMs: unit * interval };
}

export function validateScheduleInput(input: unknown): ScheduleExpression & { name: string; prompt: string } {
  const args = record(input);
  const name = stringValue(args.name, "name", MAX_SCHEDULE_NAME_LENGTH);
  const prompt = stringValue(args.prompt, "prompt");
  if (Buffer.byteLength(prompt, "utf8") > MAX_SCHEDULE_PROMPT_BYTES) throw new ValidationError("prompt is too long");
  const timeZone = timezone(args.timeZone);
  const expressions = [args.at !== undefined, args.intervalMs !== undefined, args.rrule !== undefined].filter(Boolean).length;
  if (expressions !== 1) throw new ValidationError("exactly one of at, intervalMs, or rrule is required");
  if (args.at !== undefined) {
    const at = stringValue(args.at, "at");
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(at)) throw new ValidationError("at must include an explicit timezone offset");
    const parsed = Date.parse(at);
    if (!Number.isFinite(parsed)) throw new ValidationError("at must be a valid ISO timestamp");
    return { name, prompt, at, timeZone };
  }
  if (args.intervalMs !== undefined) {
    if (typeof args.intervalMs !== "number" || !Number.isSafeInteger(args.intervalMs) || args.intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
      throw new ValidationError(`intervalMs must be an integer of at least ${MIN_SCHEDULE_INTERVAL_MS}`);
    }
    return { name, prompt, intervalMs: args.intervalMs, timeZone };
  }
  const parsed = parseRrule(args.rrule);
  return { name, prompt, ...parsed, timeZone };
}

export function nextOccurrence(schedule: Pick<ScheduleRecord, "nextRunAt" | "intervalMs" | "rrule">, from: number): number | null {
  if (schedule.intervalMs !== null && schedule.intervalMs !== undefined) return from + schedule.intervalMs;
  if (schedule.rrule !== null && schedule.rrule !== undefined) return from + parseRrule(schedule.rrule).intervalMs;
  return null;
}
