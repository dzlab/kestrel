# Kestrel architecture

Kestrel is a local, single-user application with one durable source of truth: SQLite. The public `createKestrel` factory wires a database, repository, approval manager, trusted built-in registry, and `RunKernel`. Production construction uses `OpenAICompatibleClient`; tests can inject `FakeModel` and run the same end-to-end path.

```text
CLI or SchedulerDaemon
        |
     RunKernel -- bounded context --> ModelClient
        |                                |
   PolicyEngine                    normalized response
        |
 ApprovalManager -- if needed --> durable pause/resume
        |
     ToolRegistry --> filesystem/process/memory/schedule/upgrade tools
        |
       SQLite events, messages, calls, approvals, memories, schedules
```

Every model response and tool call is validated before it is used. Calls are recorded before execution, tool results are bounded before entering model context, and events are append-only. A restart loads the task, messages, tool calls, and approval state; completed side effects are not replayed. An unfinished executing call fails closed rather than guessing whether its side effect happened.

## Components

- `src/kernel` owns turns, tool-call and token budgets, timeouts, terminal states, context bounds, persistence, and resumable approval pauses.
- `src/model` contains the provider-neutral protocol, the OpenAI-compatible HTTP adapter, and the deterministic `FakeModel`.
- `src/tools` contains the schema-validated registry, secure filesystem/search tools, bounded subprocess tools, and scheduler entry tools.
- `src/policy` classifies capabilities and maintains durable, exact, one-shot approvals.
- `src/memory` stores only explicit, provenance-bearing facts and presents them to the model as untrusted reference data.
- `src/scheduler` claims due jobs with SQLite leases and fencing tokens. A `tick` runs one job; the daemon repeats ticks, renews leases, retries bounded failures, and pauses approval-blocked jobs.
- `src/upgrade` treats self-improvement as a proposal/apply workflow with exact hashes, explicit verification, approval, and rollback.
- `src/cli` is a thin foreground/daemon lifecycle interface over the same runtime.

## Proactivity and scheduling

Schedules contain a prompt, workspace, one-shot or recurring timing, attempts, lease ownership, fencing token, and the last result. `schedule.create` is approval-gated. The daemon atomically claims one due row, executes it through `RunKernel`, writes heartbeats/status events, and releases or finishes the lease. A stale lease can be reclaimed by another daemon; the old worker's token cannot finish the job. Successful recurring jobs calculate their next occurrence, while failures retry with a capped exponential delay. Approval-blocked jobs remain durable and resumable instead of silently running later.

## Persistence lifecycle

The default database location is `~/.kestrel/kestrel.sqlite`; `KESTREL_DATA_DIR` and `KESTREL_DB` can override it. The CLI creates the data directory privately, rejects in-memory persistence and symlink database files, and sets the database file private. Back up only with the daemon stopped. Schema migrations validate historical lineage, constraints, and status domains before exposing the repository.
