import { randomUUID } from "node:crypto";
import { ValidationError } from "../errors";
import { markTrustedBuiltIn } from "./trust";
import type { Tool, ToolContext, ToolResult } from "./types";
import { validateScheduleInput, validateScheduleWorkspace } from "../scheduler/expressions";

function idArgument(args: Record<string, unknown>): string {
  if (typeof args.id !== "string" || args.id.trim().length === 0) throw new ValidationError("id must be non-empty");
  return args.id.trim();
}

export const scheduleListTool: Tool = markTrustedBuiltIn({
  definition: {
    name: "schedule.list",
    description: "List durable scheduled tasks and their current lease/status metadata.",
    capability: "scheduler",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async execute(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const schedules = context.repository.listSchedules();
    return { ok: true, content: JSON.stringify(schedules), data: schedules };
  },
});

export const scheduleCreateTool: Tool = markTrustedBuiltIn({
  definition: {
    name: "schedule.create",
    description: "Create a bounded, timezone-explicit one-shot or recurring scheduled task.",
    capability: "scheduler",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        prompt: { type: "string" },
        at: { type: "string" },
        intervalMs: { type: "number" },
        rrule: { type: "string" },
        timeZone: { type: "string" },
      },
      required: ["name", "prompt", "timeZone"],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const input = validateScheduleInput(args);
    const workspace = validateScheduleWorkspace(context.workspace);
    const id = randomUUID();
    const now = Date.now();
    const schedule = {
      id,
      name: input.name,
      workspace,
      prompt: input.prompt,
      nextRunAt: input.at === undefined ? now + (input.intervalMs ?? 0) : Date.parse(input.at),
      enabled: true,
      intervalMs: input.intervalMs ?? null,
      rrule: input.rrule ?? null,
      timeZone: input.timeZone,
      attempts: 0,
      lastError: null,
      pendingRunId: null,
      pendingApprovalId: null,
    };
    context.repository.createSchedule(schedule);
    return { ok: true, content: JSON.stringify(schedule), data: schedule };
  },
});

export const scheduleCancelTool: Tool = markTrustedBuiltIn({
  definition: {
    name: "schedule.cancel",
    description: "Disable a durable scheduled task while retaining its history.",
    capability: "scheduler",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const id = idArgument(args);
    if (!context.repository.cancelSchedule(id)) return { ok: false, content: `schedule not found: ${id}` };
    return { ok: true, content: JSON.stringify({ cancelled: true, id }), data: { cancelled: true, id } };
  },
});

export function createScheduleTools(): Tool[] {
  return [scheduleListTool, scheduleCreateTool, scheduleCancelTool];
}

export { validateScheduleInput };
