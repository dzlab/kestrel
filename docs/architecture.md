# Kestrel architecture

Kestrel is a local, single-user application with one durable source of truth: SQLite. The public `createKestrel` factory wires a database, repository, approval manager, trusted built-in registry, and `RunKernel`. Production construction uses `OpenAICompatibleClient`; tests can inject `FakeModel` and run the same end-to-end path.

```text
CLI or SchedulerDaemon ------------------------------------+
                                                            |
Browser -> loopback HTTP API -> ConversationService -------+
                                                            |
                                                            v
     RunKernel -- bounded context --------------------> ModelClient
        |                                |
   PolicyEngine                    normalized response
        |
 ApprovalManager -- if needed --> durable pause/resume
        |
     ToolRegistry --> filesystem/process/memory/schedule/upgrade tools
        |
       SQLite conversations, transcript, runs, events, calls, approvals,
              memories, and schedules
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
- `src/conversations` serializes browser turns per conversation and persists the user/assistant transcript separately from each run's detailed model/tool audit history. Every submitted turn is associated with its durable task and run. A completed answer joins the transcript; an approval-blocked run remains pending and resumes the same run after a decision.
- `src/http` exposes the conversation service, durable event stream, approved workspace-image previews, and built React assets from one `127.0.0.1` origin. The server does not create a second kernel or backend process.
- `src/cli` is a thin foreground/daemon lifecycle interface over the same runtime. `kestrel ui` owns one Kestrel runtime plus its HTTP listener and closes both on `SIGINT` or `SIGTERM`; scheduler-daemon lifecycle remains separate.

## Browser boundary

The browser receives conversation transcript and bounded run/event views, not model credentials or raw process environment values. A per-process token is established through `/api/session` in an `HttpOnly`, `SameSite=Strict` cookie. API requests validate a loopback `Host`; state-changing requests also require the request `Origin` to match that host. The server sends no permissive CORS policy, and the React app and API share an origin in a packaged build. During development, Vite proxies `/api` to the printed Kestrel origin.

Workspace images are fetched through the API using a conversation ID and workspace-relative path. The endpoint confines resolution to that conversation's configured workspace, rejects symlinks and special files, allows only PNG, JPEG, GIF, and WebP raster files, and caps responses at 5 MiB. The browser never receives a `file://` URL or uses this endpoint as general filesystem access.

## Proactivity and scheduling

Schedules contain a prompt, workspace, one-shot or recurring timing, attempts, lease ownership, fencing token, and the last result. `schedule.create` is approval-gated. The daemon atomically claims one due row, executes it through `RunKernel`, writes heartbeats/status events, and releases or finishes the lease. A stale lease can be reclaimed by another daemon; the old worker's token cannot finish the job. Successful recurring jobs calculate their next occurrence, while failures retry with a capped exponential delay. Approval-blocked jobs remain durable and resumable instead of silently running later.

## Persistence lifecycle

The default database location is `~/.kestrel/kestrel.sqlite`; `KESTREL_DATA_DIR` and `KESTREL_DB` can override it. The CLI creates the data directory privately, rejects in-memory persistence and symlink database files, and sets the database file private. Back up only with the daemon stopped. Schema migrations validate historical lineage, constraints, and status domains before exposing the repository.

Conversation records hold title, workspace, and timestamps. Transcript rows contain ordered user/assistant text and the associated run ID where applicable; tool messages stay in per-run records instead of being copied into future conversation context. Run events use durable numeric IDs so browser reconnects can resume without replaying completed or uncertain side effects. On restart, approval-blocked work can be reopened, while an unfinished call recorded as executing fails closed rather than being guessed or replayed.
