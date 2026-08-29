# Task 6 Fail-Closed Policy Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce policy and one-shot durable approvals at the tool execution boundary, including parsed patch risk, restart-safe approval lifecycle, and regression coverage.

**Architecture:** `ToolRegistry.execute` will parse and validate every call, evaluate a configurable `PolicyEngine`, and only dispatch after an atomic matching approval consume for approval-required decisions. `ApprovalManager` will use versioned SQLite approval fields and repository compare-and-set operations so managers share expiry, status, and audit history. `fs.patch` will expose parsed target/deletion/self-path facts to policy without weakening filesystem safety.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, Bun test, SQLite migrations.

---

## Repository map

- Modify `src/tools/registry.ts`: execution-boundary policy/approval gate and injectable dependencies.
- Modify `src/tools/types.ts`: policy/approval-aware context or registry options as needed.
- Modify `src/policy/types.ts`: durable approval fields and manager/store interfaces.
- Modify `src/policy/rules.ts`: parsed patch path/deletion/self-target classification.
- Modify `src/policy/approvals.ts`: restart-safe exact expiry, atomic consume, and durable lifecycle calls.
- Modify `src/store/migrations.ts`: versioned approval schema migration and invariant metadata.
- Modify `src/store/repository.ts`: approval CAS consume, expiry, and audit event repository methods.
- Modify `tests/policy.test.ts`, `tests/store.test.ts`, and `tests/tools.test.ts`: red/green regressions for boundary enforcement, persistence, race, patch risk, and audit.

## Task 1: Add failing boundary and patch classification regressions

- [ ] Add tests proving an injected custom shell tool cannot execute without a matching approval, a matching approval is consumed once, unknown tools fail closed, and malformed calls do not dispatch.
- [ ] Add tests proving `fs.patch` deletion and configured self-path targets require high-risk approval.
- [ ] Run the focused tests and confirm they fail because the registry does not yet gate execution and patch facts are not classified.

## Task 2: Integrate fail-closed policy and approvals into ToolRegistry

- [ ] Add registry options for injected `PolicyEngine`, `ApprovalManager`, and policy context derivation while preserving the default filesystem/search registry.
- [ ] Parse/validate the call and evaluate policy before any tool invocation; reject disallowed decisions and require exact call-id/tool/argument approval for approval-required decisions.
- [ ] Consume approval atomically before dispatch so custom shell/network/unknown implementations cannot bypass policy.

## Task 3: Add failing durable approval lifecycle regressions

- [ ] Add tests for exact persisted `expiresAt`, approve/deny by call ID after manager/database restart, durable expire/approve/deny/consume audit events, and concurrent managers where exactly one consume succeeds.
- [ ] Run the focused persistence tests and confirm they fail with the current process-local consumed set and missing schema fields.

## Task 4: Implement versioned durable approval repository

- [ ] Add a new migration with approval expiration and consumed state/timestamp fields, preserving legacy rows and exact expiry values.
- [ ] Extend repository records and implement atomic compare-and-set consume plus durable expiry and audit events in transactions.
- [ ] Update `ApprovalManager` to restore full state from storage, preserve exact expiry, persist expiry/consumption, and use repository CAS semantics across managers.

## Task 5: Verify, inspect, and commit

- [ ] Run managed Bun full tests, typecheck, and `git diff --check`.
- [ ] Inspect the final diff for fail-closed behavior, preserve unrelated user files, and commit with a focused Task 6 message.
