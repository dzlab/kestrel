# Kestrel internal components

This page describes the implementation seams that make the architecture work. It focuses on ownership and invariants rather than repeating user-facing setup instructions.

## Composition and configuration

### `src/index.ts` — public composition root

`createKestrel` is the supported assembly API. It accepts an injected model or model configuration, workspace/data/database overrides, and returns the database, repository, approvals, registry, kernel, defaults, and an idempotent `close` function. If construction fails after opening SQLite, the factory closes the database before rethrowing. [src/index.ts](../../src/index.ts#L7-L30), [src/index.ts](../../src/index.ts#L32-L91)

### `src/config.ts` — runtime configuration boundary

Configuration normalizes absolute paths, validates numeric bounds, accepts HTTP(S) model URLs, selects the default self-source root, creates private state directories, and opens a private SQLite file. The API key is carried as optional configuration but is not part of model messages. [src/config.ts](../../src/config.ts#L38-L133), [src/config.ts](../../src/config.ts#L136-L148)

## Agent execution

### `src/kernel/loop.ts` — orchestration kernel

Responsibilities:

- Create or load tasks and idempotent runs.
- Snapshot effective limits so a resumed run keeps its original budget.
- Build initial context and optional memory context.
- Recover pending approvals without replaying unfinished execution.
- Call the model under timeout/cancellation and token/turn limits.
- Detect repeated canonical calls, persist calls before execution, and append bounded tool messages.
- Produce durable `completed`, `failed`, `blocked_on_approval`, `budget_exhausted`, and `cancelled` summaries.

The kernel depends on interfaces/abstractions for model, storage, registry, policy, approvals, clock, and self paths. [src/kernel/loop.ts](../../src/kernel/loop.ts#L29-L78), [src/kernel/loop.ts](../../src/kernel/loop.ts#L155-L392)

### `src/kernel/context.ts` — bounded prompt construction

`buildInitialMessages` constructs a small system contract and task request; `boundMessages` compacts messages to a byte budget while retaining the system/user prefix and most recent history; `buildToolMessage` serializes results. Memory is labelled untrusted at the point it enters context. [src/kernel/context.ts](../../src/kernel/context.ts#L44-L106)

### `src/kernel/resume.ts` — resume seam

`resumeRun` is a narrow adapter over `RunKernel.resume`. The durable resume behavior lives in the kernel, ensuring CLI approvals, scheduler pauses, and programmatic callers use the same state machine. [src/kernel/resume.ts](../../src/kernel/resume.ts#L1-L5)

## Model and protocol

### `src/protocol/`

`types.ts` defines internal roles, run statuses, tool calls, messages, model requests, tool definitions, and normalized responses. `validation.ts` is the trust boundary for external/provider-shaped values: it validates object shape, strings, tool argument JSON, roles, tool calls, finish reasons, and usage counts. [src/protocol/types.ts](../../src/protocol/types.ts#L1-L36), [src/protocol/validation.ts](../../src/protocol/validation.ts#L1-L142)

### `src/model/client.ts`, `openai-compatible.ts`, `fake.ts`

`ModelClient` exposes one asynchronous `complete` operation. The OpenAI-compatible implementation translates internal tools to function definitions, normalizes tool calls and usage, enforces a 1 MiB response-body cap, caps provider error detail, retries one transient response, and propagates abort/timeouts. `FakeModel` records requests and returns scripted responses for deterministic integration tests. [src/model/client.ts](../../src/model/client.ts#L1-L5), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L29-L117), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L149-L210), [src/model/fake.ts](../../src/model/fake.ts#L1-L22)

## Tools and execution runtime

### `src/tools/registry.ts` — tool gate

The registry owns tool identity, definitions, schema validation, policy evaluation, approval consumption, and result bounding. It distinguishes trusted built-ins from caller-supplied implementations, denies unknown tools, and rejects an untrusted implementation that attempts to take the name of an automatic built-in. [src/tools/registry.ts](../../src/tools/registry.ts#L17-L61), [src/tools/registry.ts](../../src/tools/registry.ts#L158-L278)

### Filesystem and search

- `filesystem.ts` defines workspace path resolution, bounded reads/listing, writes, and a unified patch parser/apply engine. Its patch path and transaction helpers preserve rollback and verify target identity. [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L47-L177), [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L232-L408), [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L592-L981)
- `secure-fs.ts` supplies descriptor/native-backed directory and file operations, no-follow flags, regular-file checks, identity revalidation, atomic temporary/recovery operations, and verified rename/link/unlink helpers. [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L18-L23), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L103-L205), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L298-L491)
- `search.ts` recursively searches bounded text while skipping `.git`, `node_modules`, sensitive paths, symlinks, and special files. Matches are capped by count and serialized size. [src/tools/search.ts](../../src/tools/search.ts#L26-L80), [src/tools/search.ts](../../src/tools/search.ts#L87-L132)

### Shell, Bun, and process control

`shell.ts` exposes `shell.exec` and `bun.run`. Inputs are argv arrays, shell/background launchers are rejected, the environment is allowlisted and scrubbed, the cwd is secured/revalidated, and output is redacted and bounded. `bun.run` invokes the current Bun executable against a workspace script. [src/tools/shell.ts](../../src/tools/shell.ts#L29-L125), [src/tools/shell.ts](../../src/tools/shell.ts#L144-L242)

`runtime/process.ts` is the process lifecycle primitive: it captures stdout/stderr independently, imposes a timeout, handles aborts, terminates process groups with grace/kill escalation, drains bounded output, and returns exit/timing metadata. [src/runtime/process.ts](../../src/runtime/process.ts#L38-L149), [src/runtime/process.ts](../../src/runtime/process.ts#L151-L216)

### Redaction and native adapters

`redaction.ts` recognizes sensitive path names and common credential forms (assignments, bearer values, AWS/GitHub/OpenAI-like tokens, JWTs), and recursively redacts structured output. The native-fs directory isolates Darwin/Linux directory-record differences and rejects malformed records. [src/tools/redaction.ts](../../src/tools/redaction.ts#L1-L49), [src/tools/native-fs/index.ts](../../src/tools/native-fs/index.ts#L1-L54)

## Policy and approvals

### `src/policy/rules.ts`

The policy engine maps known tool names to capabilities and risk levels, validates tool schemas/JSON arguments, detects external or unsafe paths, detects self-modifying targets, recognizes risky command signals, and returns a decision with a canonical argument hash. Unknown tools, malformed metadata, invalid schemas, and invalid arguments fail closed. [src/policy/rules.ts](../../src/policy/rules.ts#L14-L43), [src/policy/rules.ts](../../src/policy/rules.ts#L200-L284)

### `src/policy/approvals.ts`

Approvals are durable when backed by the repository and can also operate in-memory for isolated uses. A request binds tool, exact canonical arguments, run/task identity, capability, risk, timestamps, and version. Approve/deny transitions require the expected pending version; consume requires an approved, unexpired exact match and is one-shot. [src/policy/approvals.ts](../../src/policy/approvals.ts#L35-L108), [src/policy/approvals.ts](../../src/policy/approvals.ts#L110-L211), [src/policy/approvals.ts](../../src/policy/approvals.ts#L281-L330)

## Durable storage

`database.ts` opens the Bun SQLite database. `migrations.ts` owns the versioned SQL lineage and extensive schema assertions. `repository.ts` translates records and performs task/run/message/event/tool-call/approval/memory/schedule operations. `transaction.ts` provides bounded immediate transaction behavior for contention. [src/store/database.ts](../../src/store/database.ts#L1-L23), [src/store/migrations.ts](../../src/store/migrations.ts#L325-L340), [src/store/migrations.ts](../../src/store/migrations.ts#L1641-L1935), [src/store/repository.ts](../../src/store/repository.ts#L350-L531), [src/store/transaction.ts](../../src/store/transaction.ts#L1-L120)

## Memory

Memory is explicit, scoped, provenance-bearing, bounded, and opt-in. `assertSafeMemory` rejects control characters, credential-like content, and common prompt-injection instructions. `MemoryStore.save` requires an existing source task and derives an idempotent identity; `search` validates scope/user/limits and delegates bounded ranking/filtering to the repository. [src/memory/security.ts](../../src/memory/security.ts#L3-L35), [src/memory/store.ts](../../src/memory/store.ts#L83-L133), [src/memory/tools.ts](../../src/memory/tools.ts#L1-L140)

## Scheduling and proactivity

`expressions.ts` validates bounded prompt/name/time-zone/interval/RRULE input and computes occurrences. `tools/schedule.ts` exposes list/create/cancel operations. `daemon.ts` provides claim/heartbeat/execute/finish behavior, fencing stale workers and retaining approval-blocked runs for later resume. [src/scheduler/expressions.ts](../../src/scheduler/expressions.ts#L1-L128), [src/tools/schedule.ts](../../src/tools/schedule.ts#L21-L105), [src/scheduler/daemon.ts](../../src/scheduler/daemon.ts#L42-L178)

## Self-upgrade

`upgrade/workflow.ts` owns the proposal/apply state machine. It bounds patches and verification, resolves targets below the workspace, records base and repository hashes, detects self-targeting, and performs guarded patch/verify/rollback. `upgrade/tools.ts` exposes the workflow through policy-managed `self.upgrade` and `self.apply` tools. [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L42-L130), [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L205-L249), [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L267-L347), [src/upgrade/tools.ts](../../src/upgrade/tools.ts#L1-L100)

## CLI and daemon lifecycle

The CLI keeps command handling thin and uses the public composition path. `daemon start` writes a private PID file and creates a scheduler loop; `status` detects stale PIDs; `stop` terminates and removes the PID file. Commands that need a model require a kernel, while read-only history/status/memory/schedule paths can open only the repository. [src/cli/main.ts](../../src/cli/main.ts#L40-L68), [src/cli/main.ts](../../src/cli/main.ts#L124-L187), [src/cli/main.ts](../../src/cli/main.ts#L248-L340)

