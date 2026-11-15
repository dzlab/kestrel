export const version = "0.1.0";

import { OpenAICompatibleClient } from "./model/openai-compatible";
import type { ModelClient } from "./model/client";
import { ApprovalManager } from "./policy/approvals";
import { loadConfig, openConfiguredDatabase } from "./config";
import type { KestrelConfig } from "./config";
import { StoreRepository } from "./store/repository";
import { createToolRegistry } from "./tools/registry";
import { RunKernel, type RunOptions } from "./kernel";

export type { KestrelConfig } from "./config";
export { DEFAULT_DATA_DIR, ensureDataDirectory, loadConfig, openConfiguredDatabase, resolveDatabasePath } from "./config";

export type CreateKestrelOptions = {
  model?: ModelClient;
  config?: KestrelConfig;
  dataDir?: string;
  databasePath?: string;
  workspace?: string;
  modelBaseUrl?: string;
  modelApiKey?: string;
  modelName?: string;
};

export type KestrelAgent = {
  config: KestrelConfig;
  database: ReturnType<typeof openConfiguredDatabase>;
  repository: StoreRepository;
  approvals: ApprovalManager;
  registry: ReturnType<typeof createToolRegistry>;
  kernel: RunKernel;
  defaults: RunOptions;
  close: () => void;
};

export function createKestrel(options: CreateKestrelOptions = {}): KestrelAgent {
  const env = { ...process.env };
  if (options.dataDir !== undefined) env.KESTREL_DATA_DIR = options.dataDir;
  if (options.databasePath !== undefined) env.KESTREL_DB = options.databasePath;
  if (options.workspace !== undefined) env.KESTREL_WORKSPACE = options.workspace;
  if (options.modelBaseUrl !== undefined) env.KESTREL_MODEL_BASE_URL = options.modelBaseUrl;
  if (options.modelApiKey !== undefined) env.KESTREL_MODEL_API_KEY = options.modelApiKey;
  if (options.modelName !== undefined) env.KESTREL_MODEL_NAME = options.modelName;
  const config = options.config ?? loadConfig(env);
  const database = openConfiguredDatabase(config);
  try {
    const repository = new StoreRepository(database);
    const approvals = new ApprovalManager(repository);
    const registry = createToolRegistry({ approvals });
    const model = options.model ?? (() => {
      if (config.modelBaseUrl === undefined) throw new Error("KESTREL_MODEL_BASE_URL is required when no model is injected");
      return new OpenAICompatibleClient({
        baseUrl: config.modelBaseUrl,
        apiKey: config.modelApiKey,
        model: config.modelName,
        timeoutMs: config.modelTimeoutMs,
      });
    })();
    const defaults: RunOptions = {
      modelName: config.modelName,
      maxTurns: config.maxTurns,
      maxToolCalls: config.maxToolCalls,
      maxTokens: config.maxTokens,
      timeoutMs: config.runTimeoutMs,
      toolTimeoutMs: config.toolTimeoutMs,
      contextBytes: config.contextBytes,
    };
    const kernel = new RunKernel({ model, repository, registry, approvals, modelName: config.modelName, selfPaths: config.selfPaths });
    let closed = false;
    return {
      config,
      database,
      repository,
      approvals,
      registry,
      kernel,
      defaults,
      close: () => {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export { SchedulerDaemon, retryDelayMs } from "./scheduler/daemon";
export { MAX_SCHEDULE_ATTEMPTS, nextOccurrence, validateScheduleInput, validateScheduleWorkspace } from "./scheduler/expressions";

export { SelfUpgrade, createUpgradeTools } from "./upgrade";
export type {
  SelfUpgradeOptions,
  UpgradeApplyInput,
  UpgradeApplyResult,
  UpgradeProposal,
  UpgradeProposalStatus,
  UpgradeProposeInput,
  UpgradeRunner,
  UpgradeRunnerResult,
} from "./upgrade";

export { RunKernel, Kernel } from "./kernel";
export type {
  RunKernelDependencies,
  RunOptions,
  RunSummary,
  RunTask,
} from "./kernel";
export { ConversationService } from "./conversations/service";
export type { ConversationServiceDependencies } from "./conversations/service";
export type {
  ConversationApprovalDetails,
  ConversationApprovalDecision,
  ConversationMessageRecord,
  ConversationMessageRole,
  ConversationRecord,
  ConversationRole,
  ConversationRunOptions,
  ConversationState,
  ConversationTurnInput,
  ConversationTurnResult,
  ResolveApprovalDecision,
  SubmitTurnInput,
  SubmitTurnResult,
} from "./conversations/types";
export {
  MemoryStore,
  assertSafeMemory,
  createMemoryTools,
} from "./memory";
export type {
  MemoryRecord,
  MemorySaveInput,
  MemorySearchInput,
  MemoryScope,
} from "./memory";

export { FakeModel } from "./model/fake";
export { OpenAICompatibleClient } from "./model/openai-compatible";
export type { ModelClient } from "./model/client";
export { startKestrelHttpServer } from "./http/server";
export type { KestrelHttpServer, StartKestrelHttpServerOptions } from "./http/server";
export { openDatabase } from "./store/database";
export { StoreRepository, Repository } from "./store/repository";
export type {
  ApprovalRecord,
  EventRecord,
  MemoryRecord as StoreMemoryRecord,
  RunRecord,
  ScheduleRecord,
  TaskRecord,
  ToolCallRecord,
} from "./store/repository";
export { ApprovalManager } from "./policy/approvals";
export { PolicyEngine, classifyTool, evaluateToolCall, canonicalJson, hashToolCall } from "./policy/rules";
export type { ApprovalRequest, Decision, PolicyContext, Risk } from "./policy/types";
export { ToolRegistry, createToolRegistry, isTrustedBuiltInTool } from "./tools/registry";
export { boundToolResult } from "./tools/types";
export type { Tool, ToolContext, ToolResult } from "./tools/types";
export { parseMessage, parseModelResponse, parseToolCall } from "./protocol/validation";
export type { Message, ModelRequest, ModelResponse, Role, RunStatus, ToolCall, ToolDefinition } from "./protocol/types";
