# Kestrel Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working single-user local Kestrel agent in Bun/TypeScript with an OpenAI-compatible model adapter, durable kernel loop, local tools, approval-gated security, SQLite memory, scheduler, and guarded self-upgrades.

**Architecture:** Kestrel is a local CLI and daemon sharing one kernel. The kernel persists each task step, assembles bounded context, asks an OpenAI-compatible model for text or typed tool calls, evaluates each call through policy, executes approved tools, and resumes until a terminal state. SQLite is the source of truth; the filesystem workspace is the only default execution scope.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, native `fetch`, Bun subprocess APIs, Node-compatible `crypto`, and the Bun test runner. No agent framework or vendor SDK is required.

---

## Repository map

Create the following focused files. Keep public interfaces in `src/*/types.ts` files and keep persistence, policy, tool execution, and orchestration separate.

```text
package.json
tsconfig.json
README.md
src/index.ts
src/config.ts
src/errors.ts
src/protocol/types.ts
src/protocol/validation.ts
src/model/client.ts
src/model/openai-compatible.ts
src/model/fake.ts
src/store/database.ts
src/store/migrations.ts
src/store/repository.ts
src/policy/types.ts
src/policy/engine.ts
src/policy/approvals.ts
src/tools/types.ts
src/tools/registry.ts
src/tools/filesystem.ts
src/tools/search.ts
src/tools/shell.ts
src/tools/memory.ts
src/tools/schedule.ts
src/kernel/context.ts
src/kernel/loop.ts
src/kernel/resume.ts
src/scheduler/daemon.ts
src/self/upgrade.ts
src/cli/main.ts
tests/protocol.test.ts
tests/model.test.ts
tests/store.test.ts
tests/policy.test.ts
tests/tools.test.ts
tests/shell.test.ts
tests/kernel.test.ts
tests/memory.test.ts
tests/scheduler.test.ts
tests/self-upgrade.test.ts
tests/e2e.test.ts
tests/smoke.test.ts
tests/fixtures/fake-model.json
```

Use one commit per task. A subagent may own Tasks 1, 2, 3, 4, or 5 independently. Tasks 6 and 7 depend on the earlier interfaces. Tasks 8 and 9 can proceed in parallel after Task 3. The main agent owns integration, security review, and final verification.

## Task 1: Bootstrap the Bun repository and shared errors

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `src/errors.ts`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

```ts
import { expect, test } from "bun:test";
import { version } from "../src/index";

test("exports a Kestrel version", () => {
  expect(version).toBe("0.1.0");
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `bun test tests/smoke.test.ts`

Expected: FAIL because `src/index.ts` does not exist.

- [ ] **Step 3: Add the minimal repository configuration and export**

`package.json` must define `type: "module"`, scripts `test: "bun test"`, `typecheck: "tsc --noEmit"`, and `dev: "bun run src/cli/main.ts"`. `tsconfig.json` must enable strict TypeScript, ES2022 target, and Bun types. `src/index.ts` exports `const version = "0.1.0"`.

Define `KestrelError`, `ValidationError`, `PolicyError`, `ApprovalRequiredError`, `ToolExecutionError`, and `PersistenceError` in `src/errors.ts`; each extends `Error` and carries a stable `code` string.

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test tests/smoke.test.ts && bun run typecheck`

Expected: PASS and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json src tests/smoke.test.ts
git commit -m "chore: bootstrap Kestrel Bun repository"
```

## Task 2: Define and validate the model/message protocol

**Files:**
- Create: `src/protocol/types.ts`
- Create: `src/protocol/validation.ts`
- Create: `tests/protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Test that a valid assistant tool call parses into `{ id, name, arguments }`, that malformed JSON arguments produce `ValidationError`, and that an unknown message role is rejected. Test the terminal status union: `completed`, `failed`, `blocked_on_approval`, and `budget_exhausted`.

- [ ] **Step 2: Run the focused tests**

Run: `bun test tests/protocol.test.ts`

Expected: FAIL because protocol types and validators are absent.

- [ ] **Step 3: Implement the protocol**

Define these types in `src/protocol/types.ts`:

```ts
export type Role = "system" | "user" | "assistant" | "tool";
export type RunStatus = "running" | "completed" | "failed" | "blocked_on_approval" | "budget_exhausted";

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type Message = {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  capability: string;
};

export type ModelRequest = {
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  temperature?: number;
};

export type ModelResponse = {
  message: Message;
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};
```

Implement `parseToolCall`, `parseMessage`, and `parseModelResponse` with explicit runtime checks. Reject missing IDs, empty names, non-object arguments, invalid roles, and assistant messages containing neither content nor tool calls.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/protocol.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol tests/protocol.test.ts
git commit -m "feat: add typed agent message protocol"
```

## Task 3: Add SQLite persistence and migrations

**Files:**
- Create: `src/store/database.ts`
- Create: `src/store/migrations.ts`
- Create: `src/store/repository.ts`
- Create: `tests/store.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Use a temporary database file. Test that `createTask` writes a task and initial `created` event, `appendMessage` preserves message order, `recordToolCall` is idempotent by call ID, pending approvals survive reopening the database, and `claimDueSchedule` returns a job only once.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/store.test.ts`

Expected: FAIL because the database and repository do not exist.

- [ ] **Step 3: Implement schema and repository**

`src/store/database.ts` opens `bun:sqlite`, enables foreign keys, and runs migrations in a transaction. `src/store/migrations.ts` creates these tables: `tasks`, `runs`, `messages`, `tool_calls`, `events`, `memories`, `schedules`, and `approvals`. Use integer timestamps in milliseconds and JSON text for structured payloads.

`src/store/repository.ts` exposes:

```ts
createTask(input: { title: string; prompt: string; workspace: string; maxSteps: number }): TaskRecord;
startRun(taskId: string, idempotencyKey: string): RunRecord;
appendMessage(runId: string, message: Message): void;
appendEvent(runId: string, type: string, payload: unknown): void;
recordToolCall(runId: string, call: ToolCall, state: string): boolean;
finishToolCall(runId: string, callId: string, result: unknown, state: string): void;
saveApproval(input: ApprovalRecord): void;
getApproval(callId: string, argumentsHash: string): ApprovalRecord | null;
saveMemory(input: MemoryRecord): void;
searchMemories(query: string, limit: number): MemoryRecord[];
createSchedule(input: ScheduleRecord): void;
claimDueSchedule(now: number, owner: string): ScheduleRecord | null;
finishSchedule(id: string, nextRunAt: number | null, error: string | null): void;
```

Use `INSERT ... ON CONFLICT` only for explicitly idempotent records. Event rows are append-only and must never be updated or deleted by repository methods.

- [ ] **Step 4: Run persistence tests and typecheck**

Run: `bun test tests/store.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store tests/store.test.ts
git commit -m "feat: add durable SQLite task store"
```

## Task 4: Implement model adapters

**Files:**
- Create: `src/model/client.ts`
- Create: `src/model/openai-compatible.ts`
- Create: `src/model/fake.ts`
- Create: `tests/model.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Test that the OpenAI-compatible client sends `model`, normalized messages, and tools to `${baseUrl}/chat/completions`; converts assistant tool calls into internal `ToolCall` values; rejects non-2xx responses; and retries one transient 429. Test that `FakeModel` returns scripted responses in order and throws when its script is exhausted.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/model.test.ts`

Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Implement adapters**

Define `ModelClient` in `src/model/client.ts` with `complete(request: ModelRequest): Promise<ModelResponse>`.

`OpenAICompatibleClient` accepts `{ baseUrl, apiKey, model, timeoutMs, fetchImpl }`, strips a trailing slash, uses `fetch` with an abort timeout, sends `Authorization: Bearer ...` when configured, maps OpenAI `tool_calls.function.arguments` JSON into records, and returns normalized usage fields. Retry only status 429 and 5xx once with a short bounded delay.

`FakeModel` accepts `ModelResponse[]`, returns the next response, records requests, and exposes `remaining()` for assertions.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/model.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/model tests/model.test.ts
git commit -m "feat: add OpenAI-compatible model adapters"
```

## Task 5: Build tool registry and safe filesystem/search tools

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/registry.ts`
- Create: `src/tools/filesystem.ts`
- Create: `src/tools/search.ts`
- Create: `tests/tools.test.ts`

- [ ] **Step 1: Write failing tool tests**

Test registry lookup and schema rejection, successful `fs.list` and bounded `fs.read`, rejection of `../` traversal and symlink escape, `fs.write` creating a workspace file, `fs.patch` applying a unified patch, and `search.text` returning file/line matches while skipping `.git` and node_modules.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/tools.test.ts`

Expected: FAIL because the registry and tools do not exist.

- [ ] **Step 3: Implement tools**

Define:

```ts
export type ToolContext = { workspace: string; runId: string; repository: Repository };
export type ToolResult = { ok: boolean; content: string; data?: unknown; redactions?: string[] };
export interface Tool { definition: ToolDefinition; execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>; }
```

The registry maps exact names to tools and calls `parseToolCall` before dispatch. Implement `resolveWorkspacePath(workspace, requested)` using `realpath` on existing ancestors and reject resolved paths outside the workspace. Set byte limits of 64 KiB for reads and 128 KiB for tool output.

`fs.patch` accepts a patch string, writes only after validating all target paths, and never shells out to `patch`. `search.text` walks the workspace with an explicit ignored-directory set and returns at most 100 matches.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/tools.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools src/protocol tests/tools.test.ts
git commit -m "feat: add guarded filesystem and search tools"
```

## Task 6: Add policy classification and approvals

**Files:**
- Create: `src/policy/types.ts`
- Create: `src/policy/engine.ts`
- Create: `src/policy/approvals.ts`
- Modify: `src/tools/types.ts`
- Create: `tests/policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Test that `fs.read`, `fs.list`, and `search.text` classify as low risk and execute automatically; workspace writes classify as standard; `shell.exec`, network-capable commands, credential access, package installation, recursive deletion, self-modification, and external paths classify as high risk and require approval. Test that approval hashes include the complete tool name and canonical arguments, and changed arguments do not reuse an approval.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/policy.test.ts`

Expected: FAIL because policy types and engine do not exist.

- [ ] **Step 3: Implement fail-closed policy**

Define `Risk = "low" | "standard" | "high"`, `Decision = { allowed: boolean; requiresApproval: boolean; capability: string; risk: Risk; reason: string }`, and `ApprovalRecord` with `callId`, `argumentsHash`, `decision`, `status`, and timestamps.

`PolicyEngine.evaluate(tool, args, context)` must classify before execution. Deny unknown tools, external paths, missing workspace context, and malformed arguments. Permit low-risk reads and standard workspace writes. Require approval for shell/process/network/credential/destructive/self-modifying actions. Hash canonical JSON with sorted object keys using SHA-256.

`ApprovalManager` persists requests and exposes `request`, `approve`, `deny`, and `isApproved`. Approval is valid only for the exact call ID and argument hash.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/policy.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy src/tools/types.ts tests/policy.test.ts
git commit -m "feat: enforce fail-closed tool policy and approvals"
```

## Task 7: Implement shell/Bun execution with cancellation

**Files:**
- Create: `src/tools/shell.ts`
- Modify: `src/tools/registry.ts`
- Create: `tests/shell.test.ts`

- [ ] **Step 1: Write failing subprocess tests**

Test `bun.run` executes a temporary script with explicit arguments, captures stdout/stderr and exit code, enforces a timeout, and terminates a long-running process when its abort signal fires. Test that shell input is passed as one command string only after policy approval and that the environment contains only an explicit allowlist.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/shell.test.ts`

Expected: FAIL because subprocess tools do not exist.

- [ ] **Step 3: Implement subprocess tools**

Use `Bun.spawn` with an argument array for `bun.run`; never interpolate user arguments into a shell string. For `shell.exec`, invoke `/bin/zsh -lc` only after policy approval, pass a scrubbed environment containing `PATH`, `HOME` only when explicitly configured, `PWD`, and `KESTREL_*` correlation variables, and capture bounded stdout/stderr.

Return `{ ok, content, data: { exitCode, stdout, stderr, durationMs } }`. On timeout or abort, kill the process, await exit, and return a structured failure. Keep output below 128 KiB and redact values matching configured secret patterns.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/shell.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/shell.ts src/tools/registry.ts tests/shell.test.ts
git commit -m "feat: add bounded Bun and shell execution"
```

## Task 8: Implement the kernel loop and foreground CLI

**Files:**
- Create: `src/kernel/context.ts`
- Create: `src/kernel/loop.ts`
- Create: `src/kernel/resume.ts`
- Create: `src/config.ts`
- Create: `src/cli/main.ts`
- Create: `tests/kernel.test.ts`

- [ ] **Step 1: Write failing kernel tests**

Use `FakeModel` and in-memory temporary SQLite. Test a two-tool task reaches `completed`, messages and events are persisted in order, invalid tool calls become tool errors, a high-risk tool produces `blocked_on_approval` without executing, step limits produce `budget_exhausted`, and resume executes an approved pending call exactly once.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/kernel.test.ts`

Expected: FAIL because the kernel does not exist.

- [ ] **Step 3: Implement context assembly and loop**

Define `Kernel.run(taskId, runId): Promise<RunSummary>` and `Kernel.resume(runId): Promise<RunSummary>`. Before each model call, append the request message/event, include the task prompt, a compact workspace description, up to 20 relevant memories, and prior messages under a byte budget. Persist the assistant response before dispatching calls.

For each tool call: record it idempotently, evaluate policy, persist an approval request and stop if required, execute through the registry otherwise, persist the result/event, and append a tool message. A response with no tool calls and non-empty text completes the run. Enforce `maxSteps`, per-tool timeout, and total wall-clock deadline. Catch model/tool errors, persist structured failures, and transition to `failed` unless a retry budget remains.

`src/config.ts` loads `KESTREL_MODEL_BASE_URL`, `KESTREL_MODEL_API_KEY`, `KESTREL_MODEL_NAME`, `KESTREL_WORKSPACE`, `KESTREL_DB`, and numeric limits with safe defaults.

The CLI supports `kestrel run <prompt>`, `kestrel approve <call-id>`, `kestrel deny <call-id>`, `kestrel history`, and `kestrel status`. Approval commands must display the exact canonical tool arguments before recording a decision.

- [ ] **Step 4: Run tests, typecheck, and CLI help**

Run: `bun test tests/kernel.test.ts && bun run typecheck && bun run src/cli/main.ts --help`

Expected: PASS and help lists `run`, `approve`, `deny`, `history`, and `status`.

- [ ] **Step 5: Commit**

```bash
git add src/kernel src/config.ts src/cli tests/kernel.test.ts
git commit -m "feat: add durable reasoning kernel and CLI"
```

## Task 9: Add explicit memory tools and retrieval

**Files:**
- Create: `src/tools/memory.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/kernel/context.ts`
- Create: `tests/memory.test.ts`

- [ ] **Step 1: Write failing memory tests**

Test `memory.save` requires a non-empty fact, source task ID, and confidence from 0 to 1; `memory.search` returns matching records with provenance; duplicate facts from the same source are idempotent; and context assembly limits memory results to the configured count and byte budget.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/memory.test.ts`

Expected: FAIL because memory tools do not exist.

- [ ] **Step 3: Implement explicit memory behavior**

Implement `memory.save` as a typed tool that writes only facts explicitly supplied in its arguments and records `sourceTaskId`, `sourceRunId`, confidence, tags, and timestamps. Implement `memory.search` using SQLite case-insensitive matching over fact, summary, and tags, returning at most the requested limit.

Update context assembly to call repository search with a normalized query derived from the current task title and prompt, then include only records that fit the context budget. Never persist arbitrary assistant prose as memory.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/memory.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/memory.ts src/tools/registry.ts src/kernel/context.ts tests/memory.test.ts
git commit -m "feat: add provenance-aware long-term memory"
```

## Task 10: Add scheduler tools and daemon leases

**Files:**
- Create: `src/tools/schedule.ts`
- Create: `src/scheduler/daemon.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/cli/main.ts`
- Create: `tests/scheduler.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Test one-shot jobs, fixed-interval recurring jobs, cancellation, atomic lease claiming, stale lease recovery, bounded retry backoff, and a scheduled task that pauses when a tool requires approval. Test that two daemon instances cannot claim the same due row.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/scheduler.test.ts`

Expected: FAIL because scheduler tools and daemon do not exist.

- [ ] **Step 3: Implement scheduler**

Represent schedules with `runAt`, optional `intervalMs`, `nextRunAt`, `leaseOwner`, `leaseUntil`, `attempts`, and `status`. `schedule.create` accepts a prompt, workspace, and either an ISO one-shot time or interval in milliseconds; reject intervals below 60 seconds. `schedule.cancel` marks a row cancelled without deleting history.

`SchedulerDaemon` polls every second, claims due jobs with a compare-and-set update, invokes the same `Kernel.run`, writes heartbeat/status events, and computes retry delays of `min(15m, 2^attempt * 5s)`. Approval-blocked runs release the lease and remain resumable. Add CLI commands `daemon start`, `daemon status`, and `daemon stop` using a PID file under the configured Kestrel data directory.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/scheduler.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/schedule.ts src/scheduler src/tools/registry.ts src/cli tests/scheduler.test.ts
git commit -m "feat: add durable proactive scheduler"
```

## Task 11: Implement the guarded self-upgrade workflow

**Files:**
- Create: `src/self/upgrade.ts`
- Create: `tests/self-upgrade.test.ts`

- [ ] **Step 1: Write failing self-upgrade tests**

Test that a self-upgrade plan records the current git commit, proposed patch, and verification command; a patch is applied only after exact approval; verification failure leaves the original files unchanged; and a successful upgrade records before/after hashes and test output.

- [ ] **Step 2: Run focused tests**

Run: `bun test tests/self-upgrade.test.ts`

Expected: FAIL because the self-upgrade module does not exist.

- [ ] **Step 3: Implement inspect/verify/apply**

`SelfUpgrade.inspect(workspace)` captures `git status --short`, `git rev-parse HEAD`, and a bounded file inventory. `SelfUpgrade.propose` accepts a patch and verification command, hashes both, and creates a high-risk approval record. `SelfUpgrade.apply` requires the exact approval, applies the patch through the existing patch engine, runs the verification command through the approved shell path, and restores the prior file contents if verification fails. Record all hashes and outputs as events.

Do not allow the workflow to modify files outside the configured workspace or change the Kestrel data directory. The verification command must be explicit and cannot be silently replaced by model output after approval.

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test tests/self-upgrade.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/self tests/self-upgrade.test.ts
git commit -m "feat: add approval-gated self-upgrade workflow"
```

## Task 12: Integrate, document, and harden

**Files:**
- Create: `tests/e2e.test.ts`
- Create: `tests/fixtures/fake-model.json`
- Create: `README.md`
- Modify: `src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the end-to-end acceptance tests**

Use a temporary workspace and fake model fixture for: inspect files → write a file → run `bun test` → complete; attempt a risky command → block → approve → resume; close/reopen the database → resume; create a scheduled task → daemon claim → complete; and propose/apply a self-upgrade after verification.

- [ ] **Step 2: Run the acceptance tests before hardening**

Run: `bun test tests/e2e.test.ts`

Expected: FAIL only where integration wiring is incomplete; record each failure as an implementation defect and fix it before proceeding.

- [ ] **Step 3: Add integration wiring and public documentation**

Export the public factory from `src/index.ts`, add `kestrel` bin wiring in `package.json`, and document installation, environment variables, CLI commands, workspace policy, approval flow, memory, scheduler behavior, model endpoint shape, and the explicit limitation that local subprocess execution is not a hostile-code sandbox.

Document a safe demo using a temporary workspace. Do not include instructions for messaging contacts or automating social communication.

- [ ] **Step 4: Run the complete verification suite**

Run:

```bash
bun run typecheck
bun test
```

Expected: all tests pass with no TypeScript errors.

- [ ] **Step 5: Perform a security review**

Check every tool for path traversal, symlink escape, argument/schema bypass, output overrun, secret leakage, approval hash mismatch, duplicate side effects, and subprocess termination behavior. Run the end-to-end suite with a workspace containing a symlink outside the workspace and a fake secret in environment/output; both must remain inaccessible or redacted.

- [ ] **Step 6: Commit the integrated release**

```bash
git add .
git commit -m "feat: deliver Kestrel local agent MVP"
```

## Subagent execution assignments

Use a fresh subagent for each isolated task and require it to run the task’s focused tests and commit only its owned files. Dispatch these in dependency order:

1. Agent A: Task 1 (bootstrap)
2. Agent B: Task 2 (protocol)
3. Agent C: Task 3 (store)
4. Agent D: Task 4 (model adapters)
5. Agent E: Task 5 (safe filesystem/search tools)
6. Agent F: Task 6 (policy/approvals), after Tasks 2–5 are merged
7. Agent G: Task 7 (shell/Bun execution), after Task 6 is merged
8. Main integration agent: Task 8 (kernel/CLI), because it coordinates all interfaces
9. Agent H: Task 9 (memory), after Task 3 and Task 8 interfaces exist
10. Agent I: Task 10 (scheduler), after Task 8 interfaces exist
11. Agent J: Task 11 (self-upgrade), after Tasks 5–7 exist
12. Main integration agent: Task 12

After each subagent returns, review its diff and focused test output before merging its commit. Do not run independent subagents concurrently when they modify the same file. The main agent must run the full suite and security review after all subagent work is integrated.
