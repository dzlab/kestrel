import { randomUUID } from "node:crypto";
import { ValidationError } from "../errors";
import { ApprovalManager } from "../policy/approvals";
import { canonicalJson, PolicyEngine } from "../policy/rules";
import type { PolicyContext } from "../policy/types";
import type { ModelClient } from "../model/client";
import { parseModelResponse } from "../protocol/validation";
import type { Message, ModelResponse, RunStatus, ToolCall } from "../protocol/types";
import type {
  RunRecord,
  StoreRepository,
  TaskRecord,
  ToolCallRecord,
} from "../store/repository";
import { buildInitialMessages, buildToolMessage, boundMessages } from "./context";
import { ToolRegistry } from "../tools/registry";
import type { ToolContext, ToolResult } from "../tools/types";
import { MemoryStore } from "../memory/store";
import type { MemoryScope } from "../memory/types";

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_TOOL_CALLS = 24;
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export type RunTask = {
  id?: string;
  title: string;
  prompt: string;
  workspace: string;
  maxSteps?: number;
};

export type RunOptions = {
  runId?: string;
  idempotencyKey?: string;
  modelName?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  timeoutMs?: number;
  toolTimeoutMs?: number;
  contextBytes?: number;
  signal?: AbortSignal;
  secretPatterns?: readonly (string | RegExp)[];
  userId?: string;
  memoryContext?: {
    query: string;
    scope?: MemoryScope;
    maxResults?: number;
    maxBytes?: number;
  };
};

export type RunSummary = {
  taskId: string;
  runId: string;
  status: RunStatus;
  answer?: string;
  error?: string;
  approvalId?: string;
};

export type RunKernelDependencies = {
  model: ModelClient;
  repository: StoreRepository;
  registry?: ToolRegistry;
  approvals?: ApprovalManager;
  policyEngine?: PolicyEngine;
  modelName?: string;
  now?: () => number;
};

type Limits = Required<Pick<RunOptions, "maxTurns" | "maxToolCalls" | "maxTokens" | "timeoutMs" | "toolTimeoutMs" | "contextBytes">>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return value;
}

function canonicalCallKey(call: ToolCall): string {
  return `${call.name}:${canonicalJson(call.arguments)}`;
}

function responseTokens(response: ModelResponse): number {
  const usage = response.usage;
  if (usage === undefined) return 0;
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

function safeToolFailure(error: unknown): ToolResult {
  return { ok: false, content: errorMessage(error).slice(0, 4_096) };
}

function isTerminal(status: RunStatus): boolean {
  return status !== "running";
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class RunKernel {
  private readonly model: ModelClient;
  private readonly repository: StoreRepository;
  private readonly registry: ToolRegistry;
  private readonly approvals: ApprovalManager;
  private readonly policyEngine: PolicyEngine;
  private readonly defaultModelName: string;
  private readonly now: () => number;

  constructor(dependencies: RunKernelDependencies) {
    this.model = dependencies.model;
    this.repository = dependencies.repository;
    this.approvals = dependencies.approvals ?? new ApprovalManager(this.repository);
    this.registry = dependencies.registry ?? new ToolRegistry(undefined, { approvals: this.approvals });
    this.policyEngine = dependencies.policyEngine ?? new PolicyEngine();
    this.defaultModelName = dependencies.modelName ?? "kestrel";
    this.now = dependencies.now ?? (() => Date.now());
  }

  async run(taskInput: RunTask | TaskRecord, options: RunOptions = {}): Promise<RunSummary> {
    const task = this.loadOrCreateTask(taskInput, options);
    const run = options.runId === undefined
      ? this.repository.startRun(task.id, options.idempotencyKey ?? `run-${randomUUID()}`)
      : this.repository.getRun(options.runId);
    if (run === null || run === undefined) {
      return { taskId: task.id, runId: options.runId ?? "unknown", status: "failed", error: "run was not found" };
    }
    if (run.taskId !== task.id) return this.fail(run, "run does not belong to task");
    if (isTerminal(run.status) && run.status !== "blocked_on_approval") return this.summary(run);
    return this.execute(task, run, options);
  }

  async resume(runId: string, options: RunOptions = {}): Promise<RunSummary> {
    const run = this.repository.getRun(runId);
    if (run === null) return { taskId: "unknown", runId, status: "failed", error: "run was not found" };
    const task = this.repository.getTask(run.taskId);
    if (task === null) return this.fail(run, "task was not found for run");
    if (isTerminal(run.status) && run.status !== "blocked_on_approval") return this.summary(run);
    return this.execute(task, run, options);
  }

  private loadOrCreateTask(input: RunTask | TaskRecord, options: RunOptions): TaskRecord {
    if (input.id !== undefined) {
      const existing = this.repository.getTask(input.id);
      if (existing === null) throw new ValidationError(`task was not found: ${input.id}`);
      return existing;
    }
    const maxSteps = input.maxSteps ?? options.maxTurns ?? DEFAULT_MAX_TURNS;
    return this.repository.createTask({
      title: input.title,
      prompt: input.prompt,
      workspace: input.workspace,
      maxSteps: validatePositiveInteger(maxSteps, "maxSteps"),
    });
  }

  private limits(task: TaskRecord, options: RunOptions): Limits {
    return {
      maxTurns: validatePositiveInteger(options.maxTurns ?? task.maxSteps ?? DEFAULT_MAX_TURNS, "maxTurns"),
      maxToolCalls: validatePositiveInteger(options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, "maxToolCalls"),
      maxTokens: validatePositiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens"),
      timeoutMs: validatePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
      toolTimeoutMs: validatePositiveInteger(options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, "toolTimeoutMs"),
      contextBytes: validatePositiveInteger(options.contextBytes ?? 32 * 1024, "contextBytes"),
    };
  }

  private async execute(task: TaskRecord, run: RunRecord, options: RunOptions): Promise<RunSummary> {
    const limits = this.limits(task, options);
    const deadline = Math.min(this.now() + limits.timeoutMs, run.startedAt + limits.timeoutMs);
    let messages = this.repository.getMessages(run.id);
    if (messages.length === 0) {
      const memories = options.memoryContext === undefined
        ? []
        : new MemoryStore(this.repository).search({
            query: options.memoryContext.query,
            scope: options.memoryContext.scope,
            userId: options.userId ?? "local",
            taskId: task.id,
            maxResults: options.memoryContext.maxResults,
            maxBytes: options.memoryContext.maxBytes,
          });
      for (const message of buildInitialMessages(task, limits.contextBytes, memories)) this.repository.appendMessage(run.id, message);
      this.repository.appendEvent(run.id, "run.started", { taskId: task.id });
      messages = this.repository.getMessages(run.id);
      this.repository.updateRunStatus(run.id, "running");
    }

    const pending = this.repository.getToolCalls(run.id).filter((call) => call.finishedAt === null);
    if (pending.some((call) => call.state === "executing" || call.state === "pending")) {
      return this.fail(run, "an unfinished tool call cannot be replayed safely");
    }
    const resumed = await this.resumeApproval(task, run, pending, options, deadline, messages);
    if (resumed !== null) return resumed;
    messages = this.repository.getMessages(run.id);

    const seenCalls = new Set(this.repository.getToolCalls(run.id).map((call) => canonicalCallKey({
      id: call.callId,
      name: call.name,
      arguments: call.arguments,
    })));
    const priorEvents = this.repository.getEvents(run.id);
    let turns = priorEvents.filter((event) => event.type === "model.requested").length;
    let toolCallCount = this.repository.getToolCalls(run.id).length;
    let tokens = priorEvents
      .filter((event) => event.type === "model.responded")
      .reduce((total, event) => {
        const payload = event.payload;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return total;
        const usage = (payload as Record<string, unknown>).usage;
        if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return total;
        const usageRecord = usage as Record<string, unknown>;
        const totalTokens = usageRecord.totalTokens;
        if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) return total + totalTokens;
        const input = usageRecord.inputTokens;
        const output = usageRecord.outputTokens;
        return typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output)
          ? total + input + output
          : total;
      }, 0);

    while (true) {
      if (options.signal?.aborted) return this.budget(run, "run was cancelled");
      if (this.now() >= deadline) return this.budget(run, "run time limit exceeded");
      if (turns >= limits.maxTurns) return this.budget(run, "maximum model turns exceeded");
      if (tokens >= limits.maxTokens) return this.budget(run, "maximum token budget exceeded");
      turns += 1;
      this.repository.appendEvent(run.id, "model.requested", { turn: turns, messageCount: messages.length });

      let parsed: ModelResponse;
      try {
        const remainingMs = Math.max(1, Math.min(limits.timeoutMs, deadline - this.now()));
        const raw = await withTimeout(this.model.complete({
          model: options.modelName ?? this.defaultModelName,
          messages: boundMessages(messages, limits.contextBytes),
          tools: this.registry.definitions(),
        }), remainingMs, "model request");
        parsed = parseModelResponse(raw as unknown);
      } catch (error) {
        return this.fail(run, `model failure: ${errorMessage(error)}`);
      }

      tokens += responseTokens(parsed);
      this.repository.appendMessage(run.id, parsed.message);
      this.repository.appendEvent(run.id, "model.responded", {
        turn: turns,
        finishReason: parsed.finishReason,
        usage: parsed.usage ?? null,
      });
      messages = [...messages, parsed.message];
      if (tokens > limits.maxTokens) return this.budget(run, "maximum token budget exceeded");
      if (parsed.finishReason === "error") return this.fail(run, "model returned an error response");

      const calls = parsed.message.toolCalls ?? [];
      if (calls.length === 0) {
        if (parsed.finishReason !== "stop" || parsed.message.content.trim().length === 0) {
          return this.fail(run, "model response did not contain a final assistant answer");
        }
        return this.complete(run, parsed.message.content);
      }
      if (parsed.finishReason !== "tool_calls") return this.fail(run, "model returned tool calls with an invalid finish reason");
      if (toolCallCount + calls.length > limits.maxToolCalls) return this.budget(run, "maximum tool-call budget exceeded");

      for (const call of calls) {
        toolCallCount += 1;
        const key = canonicalCallKey(call);
        if (seenCalls.has(key)) return this.budget(run, `repeated identical tool call: ${call.name}`);
        seenCalls.add(key);
        const inserted = this.repository.recordToolCall(run.id, call, "pending");
        if (!inserted) return this.budget(run, `duplicate persisted tool call: ${call.id}`);

        let approval: { capability: string; risk: "low" | "standard" | "high"; reason: string } | null;
        try {
          approval = this.approvalFor(task, run, call);
        } catch (error) {
          return this.fail(run, `policy evaluation failed closed: ${errorMessage(error)}`);
        }
        if (approval !== null) {
          const request = this.approvals.request({
            id: call.id,
            runId: run.id,
            taskId: task.id,
            tool: call.name,
            capability: approval.capability,
            risk: approval.risk,
            summary: `${call.name} ${JSON.stringify(call.arguments)}`,
            arguments: call.arguments,
          });
          this.repository.updateToolCallState(run.id, call.id, "awaiting_approval");
          this.repository.appendEvent(run.id, "run.blocked_on_approval", {
            callId: call.id,
            argumentsHash: request.argumentsHash,
            reason: approval.reason,
          });
          this.repository.updateRunStatus(run.id, "blocked_on_approval");
          return { taskId: task.id, runId: run.id, status: "blocked_on_approval", approvalId: request.id, error: approval.reason };
        }

        const result = await this.dispatch(task, run, call, options, deadline, limits.toolTimeoutMs);
        this.repository.finishToolCall(run.id, call.id, result, result.ok ? "completed" : "failed");
        this.repository.appendEvent(run.id, "tool.completed", { callId: call.id, ok: result.ok, result });
        const toolMessage = buildToolMessage(call.id, result);
        this.repository.appendMessage(run.id, toolMessage);
        messages = [...messages, toolMessage];
      }
    }
  }

  private approvalFor(task: TaskRecord, run: RunRecord, call: ToolCall): { capability: string; risk: "low" | "standard" | "high"; reason: string } | null {
    const tool = this.registry.get(call.name);
    if (tool === undefined) return null;
    const context: PolicyContext = { workspace: task.workspace, taskId: task.id, runId: run.id, now: this.now() };
    const decision = this.policyEngine.evaluate(tool, call.arguments, context);
    return decision.requiresApproval
      ? { capability: decision.capability, risk: decision.risk, reason: decision.reason }
      : null;
  }

  private async dispatch(
    task: TaskRecord,
    run: RunRecord,
    call: ToolCall,
    options: RunOptions,
    deadline: number,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const remainingMs = Math.max(1, Math.min(timeoutMs, deadline - this.now()));
    const context: ToolContext = {
      workspace: task.workspace,
      runId: run.id,
      taskId: task.id,
      userId: options.userId,
      repository: this.repository,
      signal: controller.signal,
      secretPatterns: options.secretPatterns,
    };
    try {
      return await withTimeout(this.registry.dispatch(call, context), remainingMs, "tool execution");
    } catch (error) {
      controller.abort();
      return safeToolFailure(error);
    }
  }

  private async resumeApproval(
    task: TaskRecord,
    run: RunRecord,
    pending: ToolCallRecord[],
    options: RunOptions,
    deadline: number,
    messages: Message[],
  ): Promise<RunSummary | null> {
    const call = pending.find((candidate) => candidate.state === "awaiting_approval");
    if (call === undefined) return null;
    const approval = this.approvals.get(call.callId);
    if (approval === null || approval.status === "pending") {
      this.repository.updateRunStatus(run.id, "blocked_on_approval");
      return { taskId: task.id, runId: run.id, status: "blocked_on_approval", approvalId: call.callId, error: "approval is still pending" };
    }
    if (approval.status !== "approved") {
      const result = { ok: false, content: `approval ${approval.status}` } satisfies ToolResult;
      this.repository.finishToolCall(run.id, call.callId, result, "denied");
      this.repository.appendMessage(run.id, buildToolMessage(call.callId, result));
      return this.fail(run, `approval ${approval.status} for ${call.name}`);
    }

    this.repository.updateToolCallState(run.id, call.callId, "executing");
    const toolCall: ToolCall = { id: call.callId, name: call.name, arguments: call.arguments };
    const result = await this.dispatch(task, run, toolCall, options, deadline, options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
    if (!result.ok && /approval required/iu.test(result.content)) {
      return this.fail(run, "approved tool could not be dispatched safely");
    }
    this.repository.finishToolCall(run.id, call.callId, result, result.ok ? "completed" : "failed");
    this.repository.appendEvent(run.id, "tool.completed", { callId: call.callId, ok: result.ok, result });
    this.repository.appendMessage(run.id, buildToolMessage(call.callId, result));
    if (this.now() >= deadline) return this.budget(run, "run time limit exceeded");
    if (messages.length === 0) return this.fail(run, "run context was lost");
    this.repository.updateRunStatus(run.id, "running");
    return null;
  }

  private complete(run: RunRecord, answer: string): RunSummary {
    const updated = this.repository.updateRunStatus(run.id, "completed");
    this.repository.appendEvent(run.id, "run.completed", { answer });
    return { taskId: updated.taskId, runId: updated.id, status: updated.status, answer };
  }

  private budget(run: RunRecord, error: string): RunSummary {
    const updated = this.repository.updateRunStatus(run.id, "budget_exhausted");
    this.repository.appendEvent(run.id, "run.budget_exhausted", { error });
    return { taskId: updated.taskId, runId: updated.id, status: updated.status, error };
  }

  private fail(run: RunRecord, error: string): RunSummary {
    const updated = this.repository.updateRunStatus(run.id, "failed");
    this.repository.appendEvent(run.id, "run.failed", { error: error.slice(0, 4_096) });
    return { taskId: updated.taskId, runId: updated.id, status: updated.status, error: error.slice(0, 4_096) };
  }

  private summary(run: RunRecord): RunSummary {
    const messages = this.repository.getMessages(run.id);
    const answer = [...messages].reverse().find((message) => message.role === "assistant" && message.toolCalls === undefined)?.content;
    const approval = this.repository.getToolCalls(run.id).find((call) => call.state === "awaiting_approval");
    return {
      taskId: run.taskId,
      runId: run.id,
      status: run.status,
      ...(answer === undefined ? {} : { answer }),
      ...(approval === undefined ? {} : { approvalId: approval.callId }),
    };
  }
}

export { RunKernel as Kernel };
