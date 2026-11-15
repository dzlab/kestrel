import { ValidationError } from "../errors";
import { buildSystemMessage } from "../kernel/context";
import type { RunKernel, RunOptions } from "../kernel/loop";
import type { ApprovalManager } from "../policy/approvals";
import type { ApprovalRequest } from "../policy/types";
import type { Message } from "../protocol/types";
import type {
  RunOptionsSnapshot,
  RunRecord,
  StoreRepository,
  TaskRecord,
} from "../store/repository";
import type {
  ConversationApprovalDecision,
  ConversationRunOptions,
  ConversationState,
  ConversationTurnInput,
  ConversationTurnResult,
} from "./types";

const DEFAULT_MAX_STEPS = 12;
const MAX_CONVERSATION_RECORDS = 1_000;

export type ConversationServiceDependencies = {
  repository: StoreRepository;
  kernel: RunKernel;
  approvals: ApprovalManager;
  defaults?: ConversationRunOptions;
};

type ActiveExecution = {
  conversationId: string;
  controller: AbortController;
  promise: Promise<ConversationTurnResult>;
};

function isRunActive(run: RunRecord): boolean {
  return run.status === "running" || run.status === "blocked_on_approval";
}

function finalAnswer(messages: readonly Message[]): string | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.toolCalls === undefined)
    ?.content;
}

export class ConversationService {
  private readonly repository: StoreRepository;
  private readonly kernel: RunKernel;
  private readonly approvals: ApprovalManager;
  private readonly defaults: ConversationRunOptions;
  private readonly activeRuns = new Map<string, ActiveExecution>();
  private readonly activeConversations = new Map<string, string>();

  constructor(dependencies: ConversationServiceDependencies) {
    this.repository = dependencies.repository;
    this.kernel = dependencies.kernel;
    this.approvals = dependencies.approvals;
    this.defaults = dependencies.defaults ?? {};
  }

  getConversationState(conversationId: string): ConversationState {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new ValidationError(`conversation was not found: ${conversationId}`);
    const messages = this.repository.listConversationMessages(conversationId, MAX_CONVERSATION_RECORDS);
    const tasks = this.repository.listConversationTasks(conversationId, MAX_CONVERSATION_RECORDS);
    const active = this.findActiveTask(tasks);
    const activeRun = active?.run;
    const pendingApproval = activeRun === null || activeRun === undefined
      ? undefined
      : this.findApproval(activeRun);
    return {
      conversation,
      messages,
      tasks,
      ...(activeRun === null || activeRun === undefined ? {} : { activeRun }),
      ...(pendingApproval === undefined ? {} : { pendingApproval }),
    };
  }

  async submitTurn(
    conversationId: string,
    input: ConversationTurnInput | string,
  ): Promise<ConversationTurnResult> {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new ValidationError(`conversation was not found: ${conversationId}`);
    this.assertConversationAvailable(conversationId);

    const turn = typeof input === "string" ? { content: input } : input;
    const runOptions = { ...this.defaults, ...(turn.runOptions ?? {}) };
    const maxSteps = turn.maxSteps ?? runOptions.maxTurns ?? DEFAULT_MAX_STEPS;
    const { task } = this.repository.createConversationTurn(conversationId, {
      title: turn.title ?? conversation.title,
      content: turn.content,
      maxSteps,
    });
    const initialMessages = this.buildInitialContext(conversationId);
    const run = this.repository.startRun(task.id, task.id, this.snapshotOptions(task, runOptions));
    return this.execute(conversationId, task, run, runOptions, initialMessages);
  }

  async resolveApproval(
    conversationId: string,
    approvalId: string,
    decision: ConversationApprovalDecision,
  ): Promise<ConversationTurnResult> {
    const state = this.getConversationState(conversationId);
    const run = state.activeRun;
    if (run === undefined || run.status !== "blocked_on_approval") {
      throw new ValidationError(`conversation ${conversationId} has no run awaiting approval`);
    }
    if (this.activeConversations.has(conversationId)) {
      throw new ValidationError(`conversation ${conversationId} already has a running turn`);
    }

    const call = this.repository.getToolCall(approvalId);
    if (
      call === null ||
      call.runId !== run.id ||
      call.finishedAt !== null ||
      call.state !== "awaiting_approval"
    ) {
      throw new ValidationError(`approval ${approvalId} does not belong to the active conversation run`);
    }
    const approval = this.approvals.get(approvalId);
    if (approval === null || approval.runId !== run.id || approval.taskId !== run.taskId) {
      throw new ValidationError(`approval ${approvalId} does not belong to the active conversation run`);
    }
    const task = state.tasks.find((candidate) => candidate.id === run.taskId);
    if (task === undefined) throw new ValidationError(`task was not found for active run: ${run.taskId}`);
    if (approval.status === "pending") {
      if (decision === "approved") this.approvals.approve(approval);
      else if (decision === "denied") this.approvals.deny(approval);
      else throw new ValidationError(`invalid approval decision: ${String(decision)}`);
    }
    return this.execute(conversationId, task, run, this.defaults);
  }

  async cancelRun(conversationId: string, runId: string): Promise<ConversationTurnResult> {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new ValidationError(`conversation was not found: ${conversationId}`);
    const run = this.repository.getRun(runId);
    const ownsRun = run !== null && this.repository
      .listConversationTasks(conversationId, MAX_CONVERSATION_RECORDS)
      .some((task) => task.id === run.taskId);
    if (!ownsRun) throw new ValidationError(`run ${runId} does not belong to conversation ${conversationId}`);

    const active = this.activeRuns.get(runId);
    if (active === undefined || active.conversationId !== conversationId) {
      throw new ValidationError(`run ${runId} is not actively executing in this service`);
    }
    active.controller.abort(new Error("run was cancelled"));
    return active.promise;
  }

  async recoverConversation(conversationId: string): Promise<ConversationTurnResult | null> {
    const activeRunId = this.activeConversations.get(conversationId);
    if (activeRunId !== undefined) return this.activeRuns.get(activeRunId)?.promise ?? null;

    const state = this.getConversationState(conversationId);
    const unfinished = [...state.tasks].reverse().find((task) => {
      const run = this.repository.getLatestRunForTask(task.id);
      return run === null ? task.status === "pending" : isRunActive(run);
    });
    if (unfinished !== undefined) {
      let run = this.repository.getLatestRunForTask(unfinished.id);
      if (run === null) {
        const initialMessages = this.buildInitialContext(conversationId);
        run = this.repository.startRun(
          unfinished.id,
          unfinished.id,
          this.snapshotOptions(unfinished, this.defaults),
        );
        return this.execute(conversationId, unfinished, run, this.defaults, initialMessages);
      }

      if (run.status === "blocked_on_approval") {
        const approval = this.findApproval(run);
        if (approval?.status === "pending") {
          return this.resultForRun(conversationId, run, approval);
        }
      }
      const initialMessages = this.repository.getMessages(run.id).length === 0
        ? this.buildInitialContext(conversationId)
        : undefined;
      return this.execute(conversationId, unfinished, run, this.defaults, initialMessages);
    }

    const latestTask = state.tasks[state.tasks.length - 1];
    if (latestTask === undefined) return null;
    const latestRun = this.repository.getLatestRunForTask(latestTask.id);
    if (latestRun === null) return null;
    const result = this.resultForRun(conversationId, latestRun, this.findApproval(latestRun));
    if (result.status === "completed") this.persistAssistantMessage(conversationId, result);
    return result;
  }

  async recoverAll(limit = 100): Promise<(ConversationTurnResult | null)[]> {
    return Promise.all(
      this.repository.listConversations(limit).map((conversation) => this.recoverConversation(conversation.id)),
    );
  }

  private assertConversationAvailable(conversationId: string): void {
    if (this.activeConversations.has(conversationId)) {
      throw new ValidationError(`conversation ${conversationId} already has a running turn`);
    }
    const tasks = this.repository.listConversationTasks(conversationId, MAX_CONVERSATION_RECORDS);
    const active = this.findActiveTask(tasks);
    if (active !== undefined) {
      const status = active.run?.status ?? active.task.status;
      throw new ValidationError(`conversation ${conversationId} already has an active turn (${status})`);
    }
  }

  private findActiveTask(tasks: readonly TaskRecord[]): { task: TaskRecord; run: RunRecord | null } | undefined {
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const task = tasks[index]!;
      const run = this.repository.getLatestRunForTask(task.id);
      if (run === null ? task.status === "pending" : isRunActive(run)) return { task, run };
    }
    return undefined;
  }

  private buildInitialContext(conversationId: string): Message[] {
    const conversation = this.repository.getConversation(conversationId);
    if (conversation === null) throw new ValidationError(`conversation was not found: ${conversationId}`);
    const transcript = this.repository.listConversationMessages(conversationId, MAX_CONVERSATION_RECORDS);
    const messages: Message[] = [buildSystemMessage(conversation.workspace)];
    for (const message of transcript) {
      if (message.role === "assistant") {
        if (message.runId === null || this.repository.getRun(message.runId)?.status !== "completed") continue;
      }
      messages.push({ role: message.role, content: message.content });
    }
    return messages;
  }

  private snapshotOptions(task: TaskRecord, options: ConversationRunOptions): RunOptionsSnapshot {
    return {
      ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
      maxTurns: options.maxTurns ?? task.maxSteps,
      ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
      ...(options.contextBytes === undefined ? {} : { contextBytes: options.contextBytes }),
      ...(options.userId === undefined ? {} : { userId: options.userId }),
    };
  }

  private execute(
    conversationId: string,
    task: TaskRecord,
    run: RunRecord,
    options: ConversationRunOptions,
    initialMessages?: readonly Message[],
  ): Promise<ConversationTurnResult> {
    if (this.activeConversations.has(conversationId)) {
      throw new ValidationError(`conversation ${conversationId} already has a running turn`);
    }
    const controller = new AbortController();
    const runOptions: RunOptions = {
      ...options,
      runId: run.id,
      signal: controller.signal,
      ...(initialMessages === undefined ? {} : { initialMessages }),
    };
    const promise = this.finishExecution(conversationId, task, runOptions)
      .finally(() => {
        if (this.activeRuns.get(run.id)?.promise === promise) this.activeRuns.delete(run.id);
        if (this.activeConversations.get(conversationId) === run.id) this.activeConversations.delete(conversationId);
      });
    this.activeRuns.set(run.id, { conversationId, controller, promise });
    this.activeConversations.set(conversationId, run.id);
    return promise;
  }

  private async finishExecution(
    conversationId: string,
    task: TaskRecord,
    options: RunOptions,
  ): Promise<ConversationTurnResult> {
    const summary = await this.kernel.run(task, options);
    const approval = summary.status === "blocked_on_approval" && summary.approvalId !== undefined
      ? this.approvals.get(summary.approvalId) ?? undefined
      : undefined;
    const result: ConversationTurnResult = {
      ...summary,
      conversationId,
      ...(approval === undefined ? {} : { approval }),
    };
    if (result.status === "completed") this.persistAssistantMessage(conversationId, result);
    return result;
  }

  private persistAssistantMessage(conversationId: string, result: ConversationTurnResult): void {
    const existing = this.repository
      .listConversationMessages(conversationId, MAX_CONVERSATION_RECORDS)
      .some((message) => message.role === "assistant" && message.runId === result.runId);
    if (existing) return;
    const answer = result.answer ?? finalAnswer(this.repository.getMessages(result.runId));
    if (answer === undefined || answer.trim().length === 0) {
      throw new ValidationError(`completed run ${result.runId} has no final assistant answer`);
    }
    this.repository.appendConversationMessage(conversationId, {
      role: "assistant",
      content: answer,
      runId: result.runId,
    });
  }

  private findApproval(run: RunRecord): ApprovalRequest | undefined {
    const call = this.repository
      .getToolCalls(run.id)
      .find((candidate) => candidate.finishedAt === null && candidate.state === "awaiting_approval");
    return call === undefined ? undefined : this.approvals.get(call.callId) ?? undefined;
  }

  private resultForRun(
    conversationId: string,
    run: RunRecord,
    approval?: ApprovalRequest,
  ): ConversationTurnResult {
    const answer = finalAnswer(this.repository.getMessages(run.id));
    return {
      conversationId,
      taskId: run.taskId,
      runId: run.id,
      status: run.status,
      ...(answer === undefined ? {} : { answer }),
      ...(approval === undefined ? {} : { approvalId: approval.id, approval }),
    };
  }
}
