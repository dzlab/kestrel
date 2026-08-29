# Kestrel Agent Design

**Date:** 2026-08-28  
**Status:** Approved for implementation planning  
**Repository:** `/Users/bachir/co/github/dzlab/kestrel`

## Goal

Kestrel is a single-user local macOS agent that can receive natural-language tasks, reason with an OpenAI-compatible model, use locally implemented tools, request approval for risky actions, persist its work, and run scheduled tasks while the user is away.

The first release is intentionally local and single-user. It will not ship messaging or social-automation integrations. Future external side-effect tools must be independently declared, policy-checked, and approval-gated.

## Design principles

- The kernel owns task progress, budgets, retries, and completion state.
- Tools are explicit capabilities with typed inputs and bounded outputs.
- Every model turn, tool call, approval, and result is durable and auditable.
- The model receives only bounded, assembled context; it does not receive unrestricted host state.
- Risky behavior pauses for a human decision rather than relying on prompt instructions alone.
- Self-improvement is a guarded workflow that produces a patch, verifies it, and requires approval before applying it.
- The implementation uses Bun and TypeScript as the primary runtime, with a provider-neutral model interface.

## System architecture

```text
User/task
  -> Kernel
  -> context + memory assembly
  -> OpenAI-compatible model
  -> validated tool call
  -> policy/approval gate
  -> Bun tool runtime
  -> persisted result/event
  -> model continues until success, blocked, or budget exhausted
```

The repository is organized into focused modules:

- `kernel/`: bounded reasoning loop, task state machine, retries, completion detection
- `model/`: OpenAI-compatible HTTP adapter and provider-neutral message types
- `tools/`: filesystem, search, shell, Bun execution, memory, and scheduler tools
- `policy/`: capability classification, workspace containment, approvals, command restrictions
- `store/`: SQLite persistence for tasks, runs, messages, tool calls, approvals, memories, and events
- `scheduler/`: durable sleep/wake jobs with retries and idempotency
- `cli/`: interactive execution, approval prompts, history, and daemon management
- `self/`: guarded self-upgrade flow

The user-facing entry points are a CLI for foreground tasks and approvals, plus a local daemon for scheduled work. The daemon and CLI use the same kernel and policy paths.

## Model and message protocol

The model configuration is provided through:

```text
KESTREL_MODEL_BASE_URL
KESTREL_MODEL_API_KEY
KESTREL_MODEL_NAME
```

The model layer exposes one internal operation:

```ts
complete(request: ModelRequest): Promise<ModelResponse>
```

The protocol normalizes OpenAI-compatible responses into system, user, assistant, and tool messages; typed tool definitions; assistant text; zero or more tool calls; finish reason; and usage metadata when available.

A tool call has an opaque ID, a registered name, and JSON arguments. Kestrel validates the name and arguments against the registered schema before any execution. Invalid calls become structured tool errors that are returned to the model; they never execute.

The first release includes a real HTTP adapter, a deterministic fake model for tests, recorded fixtures for end-to-end tests, bounded retries for transient model failures, and configurable step, timeout, and token/cost budgets.

Context assembly is bounded and includes the current task, relevant memory, workspace metadata, prior events, and tool results. Tool output is marked untrusted and size-limited before it is added to model context.

## Tools and security

Initial tools:

- `fs.list`: list workspace files
- `fs.read`: read bounded file contents
- `search.text`: search the workspace
- `fs.write`: create or replace files
- `fs.patch`: apply validated patches
- `shell.exec`: execute a command through Bun
- `bun.run`: run a Bun script with explicit arguments
- `memory.search` and `memory.save`
- `schedule.create`, `schedule.list`, and `schedule.cancel`

Security policy:

- Every filesystem path is canonicalized and must remain inside the configured workspace unless an explicit approval grants otherwise.
- Reads and searches are automatic, bounded, and logged.
- Writes inside the workspace are allowed and logged.
- Shell execution, process control, network access, credential access, and paths outside the workspace require approval.
- Recursive deletion, package installation, self-modification, and daemon/service changes always require approval.
- Tool environments use an explicit variable allowlist. Secrets are never copied into model messages or tool output.
- Tool output is size-limited, redacted where applicable, and treated as untrusted data.
- No messaging or social-automation tool is included in the initial release.

Approvals are durable records tied to the exact tool-call arguments, requested capability, risk level, task/run, and user decision. A denied approval blocks the run at a resumable point. An approval cannot be reused for changed arguments.

Self-upgrading is a workflow rather than a privileged command: Kestrel can inspect its source and prepare a patch, but applying it requires approval and a verification command.

The local boundary is designed for a trusted local user, not hostile multi-tenant isolation. Untrusted code must not be executed without a stronger sandbox in a future release.

## Persistence and memory

SQLite is the source of truth. The schema includes:

- `tasks`: user intent, status, workspace, budgets, and timestamps
- `runs`: execution attempts and terminal states
- `messages`: normalized model conversation
- `tool_calls`: arguments, approval state, result, duration, and errors
- `events`: append-only audit timeline
- `memories`: durable facts, decisions, summaries, and task learnings
- `schedules`: recurring or one-shot jobs
- `approvals`: pending and resolved high-risk actions

Run history stores the exact records needed to audit or resume work. Long-term memory stores explicitly extracted facts and summaries with source task IDs and confidence. Kestrel never silently turns every model statement into memory; memory writes use a dedicated tool and include provenance.

Every step is persisted before execution. A restart resumes from the last durable state without replaying an already-completed side effect. Idempotency keys identify tool calls and scheduled runs.

## Proactivity

The scheduler runs as a local daemon backed by SQLite leases. It atomically claims due jobs, executes them through the same kernel and policy path as interactive tasks, retries transient failures with bounded backoff, persists heartbeats and status, prevents duplicate execution after restart, and pauses jobs requiring approval.

The CLI supports foreground execution, approval interaction, task history, memory inspection, and daemon start/status/stop.

## State and failure handling

Terminal run states are:

- `completed`
- `failed`
- `blocked_on_approval`
- `budget_exhausted`

Failure behavior:

- Model timeouts and rate limits use bounded retries with backoff.
- Invalid model or tool output becomes a structured error and may continue within budget.
- Tool failures capture exit code, stderr, duration, and a redacted result.
- Approval denial blocks the task with a clear resume point.
- Cancellation is persisted and active subprocesses are terminated.
- Budget exhaustion stops safely and reports unfinished work.
- Scheduler crashes recover through leases and stale-run detection.
- Database migration mismatch or corruption fails closed with a diagnostic.

## Testing and acceptance

Tests will cover protocol validation, policy decisions, path containment, command classification, memory, state transitions, model loops with the fake model, subprocess execution and cancellation, approval enforcement, restart/resume, scheduler leases/retries/duplicate prevention, and a self-upgrade simulation in a temporary workspace.

An end-to-end CLI smoke test will use a local fake OpenAI-compatible server.

The first release is accepted when Kestrel can:

1. Receive a natural-language task.
2. Reason through multiple tool calls.
3. Inspect and modify a workspace.
4. Run Bun tests.
5. Pause for approval before a risky action.
6. Persist and resume after restart.
7. Save and retrieve task memory.
8. Run a scheduled task while the CLI is closed.
9. Safely propose and apply a guarded self-upgrade.

## Planned implementation slices

Implementation will proceed as independently testable slices:

1. Repository bootstrap, typed protocol, SQLite migrations, and fake model.
2. Kernel loop, tool registry, filesystem/search tools, and CLI foreground mode.
3. Bun/shell execution, policy engine, approval flow, and audit events.
4. Memory extraction/search and restart/resume behavior.
5. Scheduler daemon, leases, retries, and CLI lifecycle commands.
6. Self-upgrade workflow, end-to-end fixtures, documentation, and hardening.

Subagents may implement isolated slices in parallel only where their file and interface boundaries do not conflict. Integration, security review, and final verification remain centralized.
