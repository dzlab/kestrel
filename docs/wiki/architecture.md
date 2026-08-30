# Kestrel architecture

## System purpose and shape

Kestrel is a single-user local agent. A model proposes text responses or structured tool calls; the kernel validates and budgets those calls, the policy engine decides whether they are allowed, and the registry executes only known tools. SQLite records the durable state needed to recover, audit, schedule, and resume work.

**Synthesis:** the system is best understood as a durable control loop, not as a chat wrapper:

```text
CLI / scheduler
      |
      v
  RunKernel <----> ModelClient
      |
      v
 ToolRegistry ---> PolicyEngine ---> ApprovalManager
      |                                  |
      +------ tools ---------------------+
             | filesystem / process / memory / scheduler / upgrade
             v
          SQLite repository
```

The public factory wires the database, repository, approvals, trusted built-in registry, model adapter, and kernel. Production uses the OpenAI-compatible client; tests can inject `FakeModel` into the same composition path. [src/index.ts](../../src/index.ts#L32-L91), [docs/architecture.md](../architecture.md#components)

## Entry points and dependency direction

1. `src/cli/main.ts` translates command-line arguments into run, approval, history, status, memory, schedule, self-inspection, tick, and daemon operations. It is a lifecycle adapter, not a second execution engine. [src/cli/main.ts](../../src/cli/main.ts#L13-L40), [src/cli/main.ts](../../src/cli/main.ts#L70-L298)
2. `src/index.ts` is the composition root. `createKestrel` loads or receives configuration, opens SQLite, creates the repository and approval manager, creates the tool registry, chooses an injected or OpenAI-compatible model, and creates `RunKernel`. [src/index.ts](../../src/index.ts#L32-L91)
3. `RunKernel` owns orchestration. It receives abstractions for model, repository, registry, approvals, policy, clock, and self paths, which keeps the core loop testable and makes policy state explicit. [src/kernel/loop.ts](../../src/kernel/loop.ts#L67-L78), [src/kernel/loop.ts](../../src/kernel/loop.ts#L134-L153)
4. Lower layers do not call the CLI. Tools receive a `ToolContext`, the repository is the durable boundary, and the model adapter implements the provider-neutral `ModelClient` interface. [src/tools/types.ts](../../src/tools/types.ts#L12-L31), [src/model/client.ts](../../src/model/client.ts#L1-L5)

## One run: request to terminal state

The normal path is:

1. `run` loads an existing task or creates one, snapshots bounded run options, and obtains an idempotent run record. A terminal run is returned as-is; blocked runs can resume. [src/kernel/loop.ts](../../src/kernel/loop.ts#L155-L176)
2. On a fresh run, the kernel optionally retrieves bounded memory, builds system/user context, persists the initial messages, and records `run.started`. [src/kernel/loop.ts](../../src/kernel/loop.ts#L217-L239), [src/kernel/context.ts](../../src/kernel/context.ts#L44-L68)
3. Before entering the model loop, recovery checks unfinished tool calls. An executing call is not replayed because its side effect may have happened; pending approved calls are restored to the approval path. [src/kernel/loop.ts](../../src/kernel/loop.ts#L240-L259)
4. Each turn checks cancellation, wall-clock, turn, token, and tool-call limits. It records a bounded model-request event, calls `ModelClient.complete`, validates the response, and records usage. [src/kernel/loop.ts](../../src/kernel/loop.ts#L271-L344)
5. A stop response completes the run. Tool calls are canonicalized for duplicate detection, recorded before execution, and dispatched one at a time through the registry. [src/kernel/loop.ts](../../src/kernel/loop.ts#L345-L392)
6. A tool result is converted into a bounded tool message and appended to the run. The loop continues until the model stops or a terminal limit/cancellation/failure is reached. [src/kernel/loop.ts](../../src/kernel/loop.ts#L345-L392), [src/kernel/context.ts](../../src/kernel/context.ts#L98-L106)
7. Every terminal transition is persisted as a run status and event, so the CLI can return a durable summary rather than relying on process memory. [src/kernel/loop.ts](../../src/kernel/loop.ts#L485-L509)

## Context and model protocol

The internal protocol uses four roles (`system`, `user`, `assistant`, `tool`), structured tool calls, explicit finish reasons, and optional token usage. Validation rejects unknown roles, malformed tool arguments, empty assistant messages without tool calls, invalid finish reasons, and invalid usage counts. [src/protocol/types.ts](../../src/protocol/types.ts#L1-L36), [src/protocol/validation.ts](../../src/protocol/validation.ts#L42-L142)

The context builder creates a system instruction that labels tool output as untrusted, includes the workspace, optionally adds memory as explicitly untrusted reference data, and bounds the system/user content. `boundMessages` preserves the leading context and newest messages while compacting content and tool arguments to a byte budget. [src/kernel/context.ts](../../src/kernel/context.ts#L44-L96)

The OpenAI-compatible adapter normalizes internal messages and tools to the provider's `chat/completions` shape, adds a bearer token only when configured, bounds response bodies, retries one 429/5xx response, supports cancellation/timeouts, and converts provider output back through the same validator. [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L29-L117), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L149-L210), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L227-L286)

## Tool execution pipeline

The registry is the execution gate:

```text
raw model call
  -> parseToolCall
  -> known tool lookup
  -> trusted-built-in identity check
  -> schema validation
  -> PolicyEngine.evaluate
  -> optional durable approval consumption
  -> tool.execute(ToolContext)
  -> bound/redacted ToolResult
```

It registers filesystem, search, shell/Bun, memory, scheduling, and self-upgrade tools. Definitions are exposed to the model, while execution verifies the call again rather than trusting the model's earlier description. Automatic built-in names cannot be impersonated by an untrusted implementation. [src/tools/registry.ts](../../src/tools/registry.ts#L158-L213), [src/tools/registry.ts](../../src/tools/registry.ts#L215-L278)

## Durable state and recovery

SQLite is the source of truth for tasks, runs, messages, events, tool calls, approvals, memories, and schedules. The repository converts rows into typed records, uses transactions for state transitions, and enforces schema lineage and constraints through migrations. [src/store/repository.ts](../../src/store/repository.ts#L9-L136), [src/store/migrations.ts](../../src/store/migrations.ts#L325-L340), [src/store/migrations.ts](../../src/store/migrations.ts#L1854-L1935)

Idempotency is layered: run creation uses an idempotency key; tool-call records are unique by call identity and argument hash; approvals are versioned and consumed transactionally; schedule claims use owner/token predicates. This lets recovery distinguish safe retries from side effects that must not be replayed. [src/store/repository.ts](../../src/store/repository.ts#L403-L531), [src/store/repository.ts](../../src/store/repository.ts#L636-L751), [src/store/repository.ts](../../src/store/repository.ts#L859-L1010)

Configuration places default state under `~/.kestrel`, rejects CLI in-memory databases, symlinked database files, and unsafe paths, and applies private directory/database permissions. [src/config.ts](../../src/config.ts#L45-L70), [src/config.ts](../../src/config.ts#L136-L148)

## Proactivity: schedules and daemon

Schedules are durable prompts with a workspace, next-run time, interval or RRULE, attempt count, lease metadata, and pending approval/run references. Schedule input validates names, prompts, time zones, and minimum intervals. [src/tools/schedule.ts](../../src/tools/schedule.ts#L21-L105), [src/scheduler/expressions.ts](../../src/scheduler/expressions.ts#L1-L128)

`SchedulerDaemon.runOnce` claims one due schedule through SQLite, starts a heartbeat that renews its lease, runs or resumes the task through the same kernel, and only commits completion if its owner and fencing token are still valid. Successful recurring jobs advance; failures use bounded exponential retry; approval-blocked jobs remain resumable. `start` adds a non-overlapping timer around this operation. [src/scheduler/daemon.ts](../../src/scheduler/daemon.ts#L42-L178), [src/store/repository.ts](../../src/store/repository.ts#L859-L1010)

## Self-improvement lifecycle

Self-improvement is intentionally a two-phase workflow:

1. `propose` validates and bounds a patch and verification argv, resolves targets, snapshots files and repository state, records hashes, creates a synthetic `self.apply` approval, and persists the proposal without mutating source. [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L205-L249)
2. `apply` rechecks workspace, patch/target hashes, self-target metadata, base revision, repository state, and approval. It applies through the guarded patch tool, runs the approved bounded verifier, records before/after hashes, and restores the prior snapshot on verification failure. [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L267-L347)

This design permits Kestrel to upgrade itself while keeping mutation, approval, verification, and rollback explicit and auditable. It does not make arbitrary code safe: subprocess execution remains a policy-controlled local process, not a hostile-code sandbox. [docs/security.md](../security.md#threat-model)

## Portability boundary

The application targets Bun and supports macOS/Linux. General filesystem and process behavior is expressed through portable TypeScript, while native directory enumeration is isolated behind platform adapters selected at runtime. Native loaders expose a common shape and decode Darwin/Linux dirent records through platform-specific parsers. [src/tools/native-fs/index.ts](../../src/tools/native-fs/index.ts#L1-L54), [src/tools/native-fs/types.ts](../../src/tools/native-fs/types.ts#L1-L80)

The OS-independent guarantee is therefore an adapter boundary, not an assumption that every syscall has identical semantics. Unsupported platforms fail explicitly; tests cover Darwin and Linux record decoding. [tests/native-fs.test.ts](../../tests/native-fs.test.ts#L1-L240)

