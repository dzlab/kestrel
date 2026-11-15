# Kestrel React UI design

## Goal

Give Kestrel a friendly, persistent local chat interface for coding and general tasks. Users should be able to converse with the agent, see readable progress and rich results, review proposed actions, and approve or deny risky tool calls without leaving the conversation.

The first release is a local browser app. Its frontend and backend boundaries should allow a future desktop wrapper to reuse the React UI and the same local API.

## Current state

Kestrel is a single-user Bun/TypeScript application. `RunKernel` owns the model/tool loop, context and execution budgets, durable run state, and approval pauses. The CLI starts one prompt per run and prints JSON. There is no browser API or persistent multi-turn conversation abstraction today. The OpenAI-compatible model adapter completes a request without streaming tokens.

The UI must preserve the kernel as the owner of model calls, tool execution, and policy decisions. It must not reproduce those responsibilities in the browser.

## Approaches considered

1. **Local browser app with a Bun API (recommended).** Add a same-origin local API around Kestrel and build a React single-page app. This fits the existing local runtime, supports a polished chat experience, and keeps a clean path to a desktop wrapper.
2. **Desktop wrapper first.** Package the React app in a desktop shell immediately. This adds platform packaging and lifecycle work before validating the interaction design.
3. **Hosted multi-user web app.** Separate frontend and remote backend. This requires account, tenancy, deployment, and remote security design that do not fit Kestrel's current single-user local scope.

## User experience

The main view has three areas:

- **Conversation sidebar:** create a chat, find recent chats, and reopen previous chats. Each conversation has a readable title and last activity time.
- **Conversation thread:** display user and assistant messages, a multiline composer, stop/cancel control for an active run, and a clear sending state. Assistant work appears as concise, expandable activity cards for file reads, writes, process execution, and results rather than raw JSON.
- **Details panel:** show run state, pending approval details, and a bounded changed-file/diff view when that information is available. A narrow viewport may collapse this panel into a drawer.

Approvals appear in the thread and details panel. Each card identifies the tool, exact arguments, working directory where applicable, and policy reason. Approve and deny actions resume or resolve the pending run in place. Approval must remain tied to the durable call ID and exact argument hash already enforced by Kestrel.

Rich assistant messages support Markdown, GitHub-flavored tables/lists, highlighted code blocks with copy controls, and safe workspace image previews. The first release does not add file uploads, collaborative users, or arbitrary HTML/MDX rendering.

## Architecture

```text
React SPA (assistant-ui custom runtime)
        | same-origin HTTP + Server-Sent Events
Local Bun HTTP server (static assets + API + workspace preview)
        | ConversationService / Application facade
Kestrel RunKernel, PolicyEngine, ApprovalManager, StoreRepository
        | model and registered tools
Configured model endpoint, workspace, and SQLite state
```

The Kestrel process exposes local HTTP endpoints using Bun's server support; no separate backend process or embedded runtime is needed. One `kestrel ui` command starts the runtime and serves the production frontend and API from one origin. Users do not install, configure, or manage a separate backend service. Development can use Vite with a proxy to the same endpoints. The API facade constructs and owns the existing Kestrel runtime; browser code receives no model credentials and cannot call tools directly. Closing the foreground UI command stops the HTTP server and runtime; the existing optional scheduler daemon remains a separate feature with its own lifecycle.

### Conversation persistence

Add a conversation abstraction above runs. A conversation stores ordered user and completed assistant messages. Each user turn creates a durable run with a bounded snapshot of the prior conversation plus the new request. The run continues to own its model/tool messages, events, approval state, and exact audit history. On completion, the assistant's final answer is appended to the conversation. A run paused for approval is resumed as the same run; its pending tool result and eventual answer belong to that turn.

Context construction uses the current kernel limits and compaction behavior. Conversation history must not bypass configured byte/token/turn budgets. The UI may show that older context has been shortened, but semantic summarization is out of scope for this UI change.

### API and events

The API exposes operations to list/create/open conversations, submit a user turn, cancel an active run, approve/deny a pending call, and fetch bounded run details and approved workspace previews. Exact route names can be settled in the implementation plan.

Submission returns a run identifier. The browser subscribes to a resumable SSE stream for run and tool lifecycle events: run started/completed/failed/cancelled, model turn started, tool started/completed, and approval required/resolved. Event frames carry stable IDs so reconnecting does not silently lose durable updates. The initial implementation streams lifecycle and tool activity; token streaming is deferred until the model client supports it.

The conversation service should reject a second concurrent turn in the same conversation unless concurrency semantics are explicitly designed. A pending approval blocks new turns in that conversation until the user resolves or cancels the run.

## Open-source frontend stack

- **React + TypeScript + Vite** for the local SPA and development workflow.
- **assistant-ui** for accessible chat thread/composer primitives and a custom runtime backed by Kestrel's API. Kestrel retains control of the agent loop.
- **shadcn/ui** for editable, accessible buttons, dialogs, cards, tabs, and responsive drawers.
- **react-markdown + remark-gfm** for safe-by-default Markdown and tables/lists. Do not enable raw HTML or MDX for model messages.
- **Shiki** for language-aware code highlighting. Code blocks include copy, wrap, and language labels.

These are open-source projects; the implementation should record and review the precise package licenses and versions when dependencies are selected.

## Security and privacy

- Listen only on `127.0.0.1` by default. Validate `Host` and `Origin`, use a per-instance secret for API requests, reject cross-origin browser requests, and avoid permissive CORS.
- Keep model API keys and all runtime secrets in the Bun process. Never serialize them to UI state, HTML, browser storage, tool events, or subprocess output.
- Reuse the kernel's policy and durable approvals. UI buttons cannot directly execute commands or override policy.
- Workspace preview endpoints canonicalize paths and reuse workspace boundary checks. Restrict image preview to bounded, passive raster formats; do not serve SVG or arbitrary local files.
- Render model/file Markdown without raw HTML. Escape tool output and treat workspace text as untrusted content.
- Keep existing audit records authoritative for tool calls and approval decisions. Do not expose secrets in event payloads.
- The web UI does not make subprocess execution a hostile-code sandbox. Kestrel's existing process isolation limits remain, and stronger OS/container sandboxing is a separate project.

## Failure and recovery behavior

Show distinct UI states for connecting, running, waiting for approval, completed, failed, cancelled, and disconnected. A network interruption reconnects to the event stream using its last event ID and fetches durable run state to fill any gap. A server restart restores conversation and approval state from SQLite. If a run was interrupted during a side effect, retain the kernel's fail-closed recovery behavior rather than replaying the tool call.

If an approval expires or is denied, explain that in the conversation and allow the user to submit a revised request. If workspace preview is unavailable, show the path and a clear error without exposing paths outside the configured workspace.

## Acceptance criteria

1. A user can create, reopen, and continue a persisted conversation in the browser.
2. A model response can invoke existing tools through `RunKernel`; tool activity and bounded outputs appear in the thread.
3. A risky call pauses with its exact details; approving resumes the same run, while denying resolves it without executing the call.
4. The UI renders Markdown, highlighted code, and permitted workspace images without enabling raw HTML or arbitrary local file access.
5. Refreshing or reconnecting restores conversation/run state without replaying completed side effects.
6. The API remains local-only by default, and model credentials never reach the browser.
7. The React UI communicates through a transport abstraction so a later desktop wrapper can reuse it without changing conversation components.

## Verification strategy

The implementation plan should include unit coverage for conversation sequencing, context bounds, API authorization, and event IDs; integration coverage for run/approval/resume and reconnect behavior; and a browser-level check for the primary chat and rich-content flows. Security review should verify loopback binding, origin/host checks, path confinement, image type/size limits, and absence of credentials in browser payloads.

## Out of scope

Desktop packaging, remote/multi-user access, collaboration, uploads, custom tool plugins, semantic memory compaction, and hostile-code sandboxing are not part of this UI design. The transport and service boundaries should leave room for a future desktop shell without committing to its framework now.
