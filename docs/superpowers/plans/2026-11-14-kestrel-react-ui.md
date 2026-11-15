# Kestrel React UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent local React chat interface to Kestrel, with readable tool activity, inline approvals, and safe rich-content rendering.

**Architecture:** The existing Kestrel process exposes loopback HTTP endpoints using `node:http` under Bun and serves the built React app from the same origin. A new conversation service stores multi-turn transcripts and delegates each user turn to the existing `RunKernel`; the frontend consumes that API and SSE lifecycle events through an assistant-ui custom runtime.

**Tech Stack:** Existing Bun + TypeScript + SQLite runtime; `node:http`; React + TypeScript + Vite; assistant-ui; shadcn/ui; react-markdown + remark-gfm; Shiki.

---

## Scope and delivery order

This is one integrated feature: the browser chat depends on conversation persistence, and both depend on the local API. Implement it in vertical slices in this order: persistence and conversation orchestration, HTTP/API boundary, chat shell, then rich renderers and packaging. Keep Kestrel's tool loop, policy, durable approvals, and process controls as the only execution path.

The design spec is [2026-11-14-kestrel-react-ui-design.md](../specs/2026-11-14-kestrel-react-ui-design.md). Do not introduce a separately managed backend process or a desktop wrapper in this plan.

## File map

### Existing files to modify

- `src/store/migrations.ts` — add the next checksummed SQLite migration for conversation and transcript tables.
- `src/store/repository.ts` — add validated conversation CRUD, ordered message persistence, task association, and event pagination.
- `src/kernel/loop.ts` and `src/kernel/context.ts` — accept a persisted conversation snapshot as the initial context for a new run while keeping existing context bounds and resume behavior.
- `src/index.ts` — export the conversation service and HTTP server APIs used by the CLI and integration points.
- `src/cli/main.ts` — add `kestrel ui`, create one runtime, start the HTTP server, print its local URL, and close cleanly on shutdown.
- `package.json` — add frontend development/build scripts and approved React/UI dependencies.
- `tsconfig.json` — keep backend and frontend type-checking configuration explicit without emitting frontend code into the Bun runtime.
- `.gitignore` — ignore generated frontend build output while keeping package lockfiles committed.

### New backend files

- `src/conversations/types.ts` — conversation, transcript message, submit-turn, and turn-result types.
- `src/conversations/service.ts` — create/list/open conversations, submit serialized turns, persist completed answers, and resume approval-blocked runs.
- `src/http/server.ts` — create/start/stop a same-origin local server using `node:http`.
- `src/http/router.ts` — parse and validate API routes and JSON request bodies; translate errors into bounded JSON responses.
- `src/http/auth.ts` — mint the per-process browser token, set/check same-origin session cookies, and validate host/origin/CSRF boundaries.
- `src/http/events.ts` — resume SSE from durable event IDs and send heartbeats/terminal state.
- `src/http/static.ts` — serve only the built UI files with safe MIME types and path confinement.
- `src/http/workspace-preview.ts` — resolve workspace-relative paths and serve bounded passive raster image previews.

### New frontend files

- `ui/index.html`, `ui/vite.config.ts`, `ui/tsconfig.json` — React/Vite entry and frontend type-checking/build configuration.
- `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/styles.css` — app boot, three-pane responsive layout, and visual theme.
- `ui/src/api/client.ts`, `ui/src/api/events.ts` — typed same-origin API client and reconnecting SSE client.
- `ui/src/chat/KestrelRuntime.ts` — assistant-ui runtime adapter for conversations, events, approvals, and cancellation.
- `ui/src/chat/ConversationSidebar.tsx`, `ConversationThread.tsx`, `Composer.tsx` — conversation navigation, chat thread, and input surface.
- `ui/src/chat/MessageContent.tsx`, `CodeBlock.tsx`, `WorkspaceImage.tsx` — safe Markdown, highlighted code, and approved image previews.
- `ui/src/chat/ToolActivityCard.tsx`, `ApprovalCard.tsx`, `RunDetails.tsx` — expandable run activity, exact-argument approval controls, and status/details panel.

## Task 1: Persistent conversations and transcript repository

**Files:**
- Modify: `src/store/migrations.ts`
- Modify: `src/store/repository.ts`
- Create: `src/conversations/types.ts`

- [ ] Define `ConversationRecord`, `ConversationMessageRecord`, and transcript role types in `src/conversations/types.ts`. Roles are only `user` and `assistant`; tool activity remains in existing run/tool/event records.
- [ ] Add migration version 11 after version 10. Create `conversations` with ID/title/workspace/timestamps and `conversation_messages` with conversation ID, monotonic sequence, role, content, optional run ID, and timestamp. Add foreign keys, a role check, a unique `(conversation_id, sequence_number)` index, and an index for recent conversations. Do not alter historical migrations.
- [ ] Add repository methods `createConversation`, `listConversations`, `getConversation`, `appendConversationMessage`, `listConversationMessages`, and `getEventsAfter`. Validate positive bounded limits, message roles, non-empty text, and non-negative event cursors consistently with existing repository conventions.
- [ ] Use `immediateTransaction` to allocate message sequence numbers and insert rows atomically. Ensure `getEventsAfter(runId, eventId)` returns ascending durable event IDs and does not expose events from another run.
- [ ] Add a task-to-conversation association in the version 11 migration so each user turn's existing task/run history can be retrieved from its conversation without changing the meaning of `tasks.prompt`.
- [ ] Keep event payloads going through the existing `redactUnknown` path. Conversation messages contain user/assistant text, but never model credentials or raw environment values.
- [ ] Keep schema validation and repository method boundaries consistent with the existing migration lineage and repository error conventions.

## Task 2: Conversation orchestration and kernel context

**Files:**
- Create: `src/conversations/service.ts`
- Modify: `src/conversations/types.ts`
- Modify: `src/kernel/loop.ts`
- Modify: `src/kernel/context.ts`
- Modify: `src/store/repository.ts`
- Modify: `src/index.ts`

- [ ] Add `initialMessages?: readonly Message[]` to `RunOptions`. This option is only used when a run has no persisted messages. On a resumed run, persisted run messages always win, so approval resume cannot replace the approved context.
- [ ] In `RunKernel.execute`, initialize a new run from the provided conversation context plus its current user message. Apply `boundMessages` at the model boundary exactly as today; do not remove token, turn, timeout, or tool-call limits. Keep the existing task-only path unchanged when `initialMessages` is omitted.
- [ ] In `ConversationService.submitTurn`, transactionally persist the user message and its task association before invoking the kernel. Serialize turns per conversation; reject a new turn while a run for that conversation is running or awaiting approval.
- [ ] Build the next run's initial context from the conversation transcript using the existing system-message builder and `boundMessages`. Preserve user/assistant ordering and include only completed assistant responses. Do not copy old tool-call messages into the new run; those remain in each run's audit history.
- [ ] After `RunKernel.run` completes, persist its final answer as an assistant transcript message. On `blocked_on_approval`, keep the user turn pending and return the approval call details; do not append a final assistant message yet.
- [ ] Implement `ConversationService.resolveApproval` to verify the call belongs to that conversation's active run, call the existing `ApprovalManager`, and resume the same kernel run. Persist the final assistant answer only after completion. A denied or expired decision remains a failed/resolved turn and is never executed.
- [ ] Implement restart recovery: opening a conversation reads its durable turns/runs; an awaiting-approval run is displayed as pending and can be resolved; never replay an unfinished call in `executing` state. If a task exists but has no run context yet, rebuild that turn's initial context from the stored transcript and use its stable turn ID as the idempotency key.
- [ ] Export the service and public types from `src/index.ts` without changing existing `createKestrel` behavior.

## Task 3: Local HTTP API, authorization, and event stream

**Files:**
- Create: `src/http/server.ts`
- Create: `src/http/router.ts`
- Create: `src/http/auth.ts`
- Create: `src/http/events.ts`
- Create: `src/http/static.ts`
- Modify: `src/store/repository.ts`
- Modify: `src/index.ts`

- [ ] Define the initial API contract:

  - `GET /api/conversations?limit=50` lists recent chats.
  - `POST /api/conversations` creates a chat using the configured workspace.
  - `GET /api/conversations/:id` returns the transcript and bounded recent run summaries.
  - `POST /api/conversations/:id/turns` accepts `{ "text": "..." }` and returns the turn/run state.
  - `POST /api/conversations/:id/runs/:runId/approvals/:callId` accepts `{ "decision": "approve" | "deny" }`.
  - `POST /api/conversations/:id/runs/:runId/cancel` requests cancellation through the active run's `AbortController`.
  - `GET /api/runs/:runId/events` streams durable run events and honors `Last-Event-ID`.
  - `GET /api/workspace/image?path=...` serves only an allowed raster file under that conversation's configured workspace.

- [ ] Implement request parsing with explicit body-size limits, JSON content-type checks, exact method/path matching, and schema validation. Return JSON errors with stable `{ error: { code, message } }` shape; do not return stack traces.
- [ ] Build the listener with `node:http` and bind to `127.0.0.1` only. Serve the production `ui/dist` bundle and API from one origin. In development, Vite proxies `/api` to this listener.
- [ ] Generate a random per-process token and set it in an `HttpOnly`, `SameSite=Strict` cookie on the UI bootstrap response. Require the cookie for API requests, validate `Host` and same-origin `Origin` on state-changing requests, and send no permissive CORS headers. Do not put the token in a URL or local storage.
- [ ] Implement SSE with stable numeric IDs from the existing `events.id` column. On reconnect, query `getEventsAfter` and emit only events for the requested run. Send periodic comment heartbeats; close on terminal run state or client disconnect. Poll at a bounded interval and clean up timers/listeners in `finally` paths.
- [ ] Emit or derive `tool.started` UI events at the moment a tool call is persisted, without changing policy decisions; use durable `tool.completed`, `tool.cancelled`, `run.blocked_on_approval`, `run.completed`, `run.failed`, `run.cancelled`, and `run.budget_exhausted` events already written by the kernel. If the kernel needs one new event for start visibility, append it before dispatch and keep payloads bounded/redacted.
- [ ] Serve static files only from the resolved build directory; reject traversal, symlink escapes, unsupported methods, and unknown asset paths. SPA fallback applies only to non-API GET routes.
- [ ] Implement workspace images through `resolveWorkspacePath`, allow PNG/JPEG/GIF/WebP only, cap size at 5 MiB, reject symlinks/special files, set `X-Content-Type-Options: nosniff`, and never return absolute workspace paths in image errors.
- [ ] Expose `startKestrelHttpServer` with explicit `listen`, `url`, and idempotent `close` lifecycle so the CLI owns the listener and runtime together.

## Task 4: React chat shell and typed transport

**Files:**
- Modify: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`
- Create: `ui/index.html`, `ui/vite.config.ts`, `ui/tsconfig.json`
- Create: `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/styles.css`
- Create: `ui/src/api/client.ts`, `ui/src/api/events.ts`
- Create: `ui/src/chat/KestrelRuntime.ts`, `ui/src/chat/ConversationSidebar.tsx`, `ui/src/chat/ConversationThread.tsx`, `ui/src/chat/Composer.tsx`

- [ ] Add the approved open-source dependencies to the root package manifest and lockfile: React, React DOM, Vite, the official React Vite plugin, assistant-ui, shadcn/ui dependencies selected by generated components, react-markdown, remark-gfm, and Shiki. Keep the existing Bun runtime requirement and npm lockfile CI path.
- [ ] Add scripts `ui:dev` and `ui:build`; frontend source stays under `ui/`, and build output goes to ignored `ui/dist/`. Make `tsconfig.json` continue checking backend/tests while `ui/tsconfig.json` checks the React app with `jsx: "react-jsx"` and strict mode.
- [ ] Implement `KestrelApi` methods corresponding to the Task 3 contract. Parse every response at the boundary and throw a typed `ApiError` containing the stable API code and safe message.
- [ ] Implement `RunEventStream` using native `EventSource` so same-origin cookies are sent automatically. Track the last event ID, reconnect on transient loss, refetch the durable run state after reconnect, and close the stream on terminal state or route change.
- [ ] Connect assistant-ui through a custom runtime adapter backed by `KestrelApi`; do not use an LLM SDK runtime that bypasses Kestrel's `RunKernel`.
- [ ] Build the first screen with a conversation sidebar, central thread, details drawer, and multiline composer. Disable submission during a running or approval-blocked turn; show stop while running and approval controls while blocked. Keep narrow screens usable by turning the side panels into drawers.
- [ ] Represent connection, running, blocked-on-approval, completed, failed, cancelled, and disconnected states as explicit UI state. On initial load, fetch conversation list and selected conversation; on refresh, restore the selected conversation from a URL path or query parameter.

## Task 5: Rich content, tool activity, and approvals

**Files:**
- Create: `ui/src/chat/MessageContent.tsx`
- Create: `ui/src/chat/CodeBlock.tsx`
- Create: `ui/src/chat/WorkspaceImage.tsx`
- Create: `ui/src/chat/ToolActivityCard.tsx`
- Create: `ui/src/chat/ApprovalCard.tsx`
- Create: `ui/src/chat/RunDetails.tsx`
- Modify: `ui/src/chat/ConversationThread.tsx`, `ui/src/styles.css`

- [ ] Render assistant/user Markdown with `react-markdown` and `remark-gfm`; do not enable `rehype-raw`, MDX, or arbitrary HTML. Render links with safe `http`, `https`, and `mailto` schemes and open external links with `rel="noreferrer"`.
- [ ] Render fenced code through Shiki with lazy language loading, copy-to-clipboard, wrap toggle, language label, and a plain-text fallback if highlighting fails. Do not execute code from a rendered block.
- [ ] Render workspace images by requesting the API image endpoint with the workspace-relative path. Show a placeholder for unsupported formats/oversized files and never construct `file://` URLs.
- [ ] Map run/tool SSE events into chronological expandable cards. Display tool name, concise status, bounded result, stdout/stderr separately, and truncation indicators; avoid showing internal stack traces.
- [ ] Render pending approvals with exact canonical stored arguments, tool name, risk, policy reason, and working directory. Buttons call the API and remain disabled until the response; use the call ID and run ID from persisted state, not client-generated substitutes.
- [ ] Populate the details panel with run state and bounded changed-file information. Only show diffs when they can be collected safely from workspace-scoped, already-observed file changes; do not imply arbitrary shell side effects are fully captured.

## Task 6: CLI lifecycle, packaging, and user docs

**Files:**
- Modify: `src/cli/main.ts`, `package.json`, `README.md`, `docs/architecture.md`, `docs/security.md`

- [ ] Add `kestrel ui` to CLI help and dispatch. It creates one runtime, starts `startKestrelHttpServer`, prints the loopback URL, and remains in the foreground until SIGINT/SIGTERM. Shutdown closes the HTTP server and SQLite runtime exactly once; do not change scheduler-daemon lifecycle.
- [ ] Make `ui:build` a prerequisite for packaging/release only; local development documents `ui:dev` plus the API server. Do not make the existing CLI smoke path require React dependencies to be built.
- [ ] Update README setup with the one-command runtime launch, required model configuration, local browser URL, development command, and how to stop the foreground UI.
- [ ] Update architecture/security docs to describe conversation/run persistence, loopback API boundaries, origin checks, cookie token, workspace image allowlist, and the fact that process execution remains outside a hostile-code sandbox.
- [ ] Review package licenses from installed manifests and preserve committed lockfile determinism. Keep generated `ui/dist/` out of Git unless repository packaging conventions require the built assets.

## Acceptance checklist for implementation review

- [ ] `kestrel ui` starts one foreground Kestrel process that serves both the React app and API on loopback; no second backend service is installed or managed.
- [ ] A user can create, reopen, and continue a conversation; each turn has a durable task/run and bounded context snapshot.
- [ ] Tool activity appears in the thread, output is bounded, and a pending approval can be approved/denied inline and resume the same run.
- [ ] Refresh/reconnect restores transcript, event cursor, and pending approval without replaying completed or uncertain side effects.
- [ ] Markdown, GFM, code highlighting, and permitted workspace images render without raw HTML or arbitrary file access.
- [ ] Model credentials are absent from browser payloads/storage; cross-origin state changes fail; server binds only to loopback.
- [ ] The UI transport is isolated from chat components so a later desktop wrapper can supply another transport without replacing the React views.

## Implementation constraints

- Keep model calls, tool policy, approvals, and subprocess execution inside the existing Kestrel kernel/registry.
- Keep conversation transcript separate from per-run tool/model audit messages.
- Preserve existing SQLite migration history and append a new migration only.
- Do not add token streaming in this iteration; lifecycle/tool-event streaming is sufficient until `ModelClient` supports streaming.
- Do not add desktop packaging, uploads, remote/multi-user access, semantic memory summaries, or a hostile-code sandbox in this plan.
- This plan does not add or run tests; no test files are part of these tasks.
