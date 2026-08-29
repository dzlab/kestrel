# Kestrel Final Three Signoff Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three remaining whole-project signoff findings at commit `5b60f51): integrated self-upgrade resume correctness, structured ToolResult secrecy, and approval run fencing.

**Architecture:** Keep the durable synthetic self-upgrade approval as an idempotent internal record while making kernel resume reconcile synthetic and model-originated calls without treating their shared operation as a duplicate. Pass the redacted structured result through the existing aggregate byte bound, and require every registry/workflow approval consumption to supply and match the current run ID.

**Tech Stack:** Bun 1.4, TypeScript strict mode, `bun:test`, `bun:sqlite`, durable repository records, and the existing policy/upgrade abstractions.

---

### Task 1: Add the three regression tests

**Files:**
- Modify: `tests/kernel.test.ts`, `tests/tools.test.ts`, `tests/policy.test.ts`
- Modify: `tests/upgrade.test.ts` only if the integrated fixture needs a focused upgrade assertion

- [x] Add an integrated self-upgrade test with a model response for `self.upgrade`, approval/resume, a dynamically selected `self.apply` proposal, and a final answer; assert the target changes once, the run completes, and no duplicate-call budget failure is recorded.
- [x] Add a structured-data test that passes `TOKEN=...` inside nested ToolResult data through `boundToolResult`; assert both returned data and the serialized tool message contain only the redacted bounded value.
- [x] Add a run-fencing test that approves a call for run A, attempts registry execution in run B, asserts no execution and no consumption, then verifies run A can still consume the approval once.
- [x] Run each new focused test before implementation and confirm it fails for the corresponding current defect.

### Task 2: Fix idempotent integrated self-upgrade resume

**Files:**
- Modify: `src/kernel/loop.ts`
- Modify: `src/upgrade/tools.ts`, `src/upgrade/workflow.ts`, and `src/upgrade/types.ts` if caller approval context must be carried into `SelfUpgrade.apply`
- Test: `tests/kernel.test.ts`, `tests/upgrade.test.ts`

- [x] Identify synthetic upgrade approval calls by their durable metadata and exclude them from model duplicate-call keys and ordinary model-call selection.
- [x] Reconcile a model `self.apply` call with the durable synthetic proposal approval exactly once, preserving exact proposal/workspace/hash/approval checks and durable tool-call completion.
- [x] Make repeated resume/retry observations idempotent: an already completed synthetic or model call must not execute the patch a second time or turn a valid approved apply into a budget failure.
- [x] Run the integrated regression and the existing upgrade/kernel approval suites.

### Task 3: Fix redacted structured ToolResult propagation

**Files:**
- Modify: `src/tools/types.ts`
- Test: `tests/tools.test.ts`, `tests/kernel.test.ts` if model-bound persistence coverage is needed

- [x] Bound `safeResult.data` rather than the original `result.data`, retain the aggregate serialized-result budget, and keep content/redactions behavior unchanged.
- [x] Verify returned, persisted, and model-fed representations cannot contain the raw TOKEN fixture.

### Task 4: Fence approval consumption by run

**Files:**
- Modify: `src/policy/types.ts`, `src/policy/approvals.ts`, `src/tools/registry.ts`, `src/upgrade/workflow.ts`
- Test: `tests/policy.test.ts`, `tests/tools.test.ts`, `tests/upgrade.test.ts`

- [x] Add a current-run argument to approval consumption and reject when the stored approval run ID differs or is unavailable for a run-scoped consume.
- [x] Pass `ToolContext.runId` from the registry and upgrade workflow into consumption while preserving legacy direct manager calls that have no current execution context.
- [x] Run approval lifecycle, registry, and upgrade tests to confirm one-shot and exact-argument behavior remains intact.

### Task 5: Full verification and commit

- [x] Run `mise exec -- bun test`.
- [x] Run `mise exec -- bun run typecheck`.
- [x] Run `mise exec -- bun run diff:check` and `mise exec -- bun run smoke`.
- [x] Inspect the complete diff for preserved policy/security behavior, then commit with a clear signoff-remediation message.
