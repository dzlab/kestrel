# Kestrel Final Audit Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate the seven final whole-project audit findings at commit `849c5c8` with regression tests, compatible migrations, and full managed-Bun verification.

**Architecture:** Keep all tool execution behind `ToolRegistry`, move secret filtering into shared bounded redaction helpers, and make built-in trust an internal registry identity set rather than a public branding function. Persist immutable run execution options and use linked abort controllers from kernel through scheduler, model, tools, processes, and upgrade verification. Make approval pause recoverable by reconciling durable approvals with unfinished calls after restart, while upgrade approvals use actual durable call rows.

**Tech Stack:** Bun 1.4, TypeScript strict mode, bun:test, bun:sqlite, native AbortController, and additive SQLite migrations.

---

### Task 1: Secret-safe bounded reads, outputs, and audit payloads

**Files:**
- Create: `src/tools/redaction.ts`
- Modify: `src/tools/filesystem.ts`, `src/tools/search.ts`, `src/tools/shell.ts`, `src/tools/types.ts`, `src/store/repository.ts`
- Test: `tests/tools.test.ts`, `tests/kernel.test.ts`

- [x] Write tests proving sensitive paths are refused, secret-like values in ordinary reads/search matches are redacted, shell output is redacted without optional patterns, and persisted event audit payloads contain no raw secret.
- [x] Run the focused tests and verify the expected red failures.
- [x] Implement shared built-in secret detection/redaction, apply it before returning or persisting bounded values, and preserve low-risk path/output limits.
- [x] Run focused tests and verify green.

### Task 2: Non-forgeable built-in identities

**Files:**
- Modify: `src/tools/trust.ts`, all built-in tool factories, `src/tools/registry.ts`, `src/tools/types.ts`, `src/index.ts`
- Test: `tests/tools.test.ts`, `tests/e2e.test.ts`

- [x] Add a regression proving no public `markTrustedBuiltIn` export exists and an arbitrary implementation cannot obtain automatic-tool trust.
- [x] Run the focused test to verify red.
- [x] Remove public branding and have the registry mark only its own canonical factory-created built-in instances as trusted.
- [x] Run focused tests and verify green.

### Task 3: Durable upgrade approvals and crash-atomic pause recovery

**Files:**
- Modify: `src/upgrade/workflow.ts`, `src/upgrade/types.ts`, `src/upgrade/tools.ts`, `src/kernel/loop.ts`, `src/store/repository.ts`
- Test: `tests/upgrade.test.ts`, `tests/kernel.test.ts`, `tests/cli.test.ts`

- [x] Add tests for approval by proposal/call ID, durable `self.apply` tool-call rows, no public bypass flag, and restart reconciliation of an approval persisted before the pause state.
- [x] Run focused tests to verify red.
- [x] Record upgrade approvals as real tool calls, accept only the durable approved/consumed state associated with the executing call, and reconcile pending calls safely after restart.
- [x] Run focused tests and verify green.

### Task 4: Persist exact run options and fail closed on unknown usage

**Files:**
- Modify: `src/store/migrations.ts`, `src/store/repository.ts`, `src/kernel/loop.ts`
- Test: `tests/store.test.ts`, `tests/kernel.test.ts`

- [x] Add tests that run budgets/options survive approval and restart unchanged, and an oversized response without provider usage is not persisted or accepted past `maxTokens`.
- [x] Run focused tests to verify red.
- [x] Add an additive run-options column/migration, snapshot effective limits at run creation, reuse them on resume, and check response cost before durable message persistence.
- [x] Run focused tests and verify green.

### Task 5: Linked cancellation through upgrade verification

**Files:**
- Modify: `src/kernel/loop.ts`, `src/model/client.ts`, `src/model/fake.ts`, `src/model/openai-compatible.ts`, `src/runtime/process.ts`, `src/tools/shell.ts`, `src/upgrade/types.ts`, `src/upgrade/workflow.ts`
- Test: `tests/kernel.test.ts`, `tests/process.test.ts`, `tests/upgrade.test.ts`

- [x] Add tests for cancellation of model, shell, and upgrade verification work with durable `cancelled` status and no unfinished executing call.
- [x] Run focused tests to verify red.
- [x] Thread linked abort signals through each boundary and persist cancellation idempotently before returning.
- [x] Run focused tests and verify green.

### Task 6: Fence scheduler workers on lease loss

**Files:**
- Modify: `src/store/repository.ts`, `src/scheduler/daemon.ts`
- Test: `tests/scheduler.test.ts`, `tests/store.test.ts`

- [x] Add a regression that revokes/reclaims a lease while a worker is running and proves the old kernel is aborted and cannot commit side effects or schedule completion.
- [x] Run focused tests to verify red.
- [x] Link renewal loss to the kernel signal, check fencing before and after execution, and retain conditional durable completion.
- [x] Run focused tests and verify green.

### Task 7: Full verification and commit

- [x] Run `mise exec -- bun test`.
- [x] Run `mise exec -- bun run typecheck`.
- [x] Run `mise exec -- bun run diff:check` and `mise exec -- bun run smoke`.
- [x] Inspect the complete diff for migration compatibility, secret safety, and absence of messaging integrations.
- [ ] Commit with a clear audit-remediation message and report the commit hash plus exact verification results.
