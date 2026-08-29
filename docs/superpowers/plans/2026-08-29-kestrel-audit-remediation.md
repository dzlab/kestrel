# Kestrel Whole-Project Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the whole-project trust, approval, provenance, cancellation, budget, scheduler, upgrade, and CLI audit findings while preserving existing fail-closed behavior and durable state.

**Architecture:** Keep the registry as the mandatory execution boundary, with trusted built-ins branded only by private factory-created identity. Keep self-upgrade approval exact and durable, with a private internal capability available only to the kernel/upgrade workflow. Extend the existing SQLite schema through an additive migration for cancelled runs and memory provenance, and use one linked abort controller for the kernel, model, and subprocess/tool calls.

**Tech Stack:** Bun 1.4, TypeScript strict mode, bun:test, bun:sqlite, native AbortController, SQLite migrations, and the existing CLI.

---

## Repository map

- Modify `src/tools/types.ts` and `src/tools/registry.ts` for trusted built-in identity and automatic-name enforcement.
- Modify `src/policy/rules.ts`, `src/kernel/loop.ts`, and `src/index.ts` for repository-derived self paths, exact model-request auditing, cancellation, and bounded token accounting.
- Modify `src/model/client.ts`, `src/model/fake.ts`, and `src/model/openai-compatible.ts` so model requests can be aborted and missing usage is bounded.
- Modify `src/runtime/process.ts`, `src/tools/shell.ts`, and `src/upgrade/workflow.ts` so active subprocesses receive the linked abort signal.
- Modify `src/protocol/types.ts`, `src/store/migrations.ts`, `src/store/repository.ts`, `src/memory/types.ts`, `src/memory/store.ts`, and `src/memory/tools.ts` for cancelled status and required memory provenance/confidence.
- Modify `src/scheduler/daemon.ts`, `src/cli/main.ts`, and `src/upgrade/tools.ts` for approval-paused recurring resume, memory inspection, self-upgrade inspection, schedule workspace validation, and safe request/tool audit metadata.
- Extend `tests/policy.test.ts`, `tests/tools.test.ts`, `tests/kernel.test.ts`, `tests/model.test.ts`, `tests/process.test.ts`, `tests/memory.test.ts`, `tests/store.test.ts`, `tests/scheduler.test.ts`, `tests/upgrade.test.ts`, and `tests/cli.test.ts` with focused red/green regressions.

## Task 1: Harden built-in identity and policy context

- [x] Add tests for every automatic built-in name, including `self.status` and `memory.save`, proving a custom implementation is rejected, while the factory-created implementation remains usable.
- [x] Replace the exported mutable trust marker with a private brand created only by built-in factories; make the registry fail closed for all automatic names before policy or execution.
- [x] Derive `selfPaths` from configured repository/source roots passed through `createKestrel` into kernel policy context; preserve custom policy context fields and reject self-targeting patches with a durable approval request.
- [x] Add exact bounded `model.requested` metadata containing model name, message count, request byte bound, and the exact registered tool name/capability set, without persisting prompt secrets or unbounded arguments.

## Task 2: Remove self-upgrade bypass and add inspection capability

- [x] Add a regression proving direct `SelfUpgrade.apply` input cannot bypass approval, and `self.apply` can proceed only after the exact durable approval is consumed.
- [x] Remove `approvedByPolicy` from the public apply input and tool arguments/context.
- [x] Add a required `self.inspect` capability/tool that returns bounded proposal/approval/status data, and expose it in the built-in registry and policy rules.

## Task 3: Enforce token budget and linked cancellation

- [x] Add a failing test for `maxTokens: 1` with a huge model response that omits usage, plus tests that abort a pending model request and a running shell/process promptly.
- [x] Implement a bounded UTF-8 response estimate when provider usage is absent; count persisted estimated usage and fail closed at the limit rather than treating missing usage as zero.
- [x] Link the caller signal, run deadline, model request, tool dispatch, and subprocess signal; persist and return a distinct `cancelled` terminal state promptly.
- [x] Add the additive migration and repository/status checks for `cancelled`, preserving old databases and never relabeling cancellation as budget exhaustion.

## Task 4: Require memory provenance and confidence

- [x] Add tests that `memory.save` rejects missing/invalid `sourceTaskId` and confidence, persists both fields, exposes them in search/CLI data, and continues filtering secrets/injection text.
- [x] Extend memory input/record and tool schema with required `sourceTaskId` and confidence in `[0,1]`; validate that the source task exists and use source task identity in deterministic IDs.
- [x] Add a migration with non-null-safe legacy defaults, update repository row conversion/upsert/search, and retain compatibility for pre-existing legacy records without allowing new saves to omit provenance.

## Task 5: Resume approval-paused recurring schedules safely

- [x] Add a scheduler regression showing a recurring schedule remains enabled while approval-paused, then resumes the stored run on the next occurrence after approval rather than creating a duplicate run.
- [x] Add repository resume/clear methods that preserve recurrence metadata, pending run/approval IDs, and leases atomically; make the daemon resume pending runs before creating a new task run.
- [x] Validate schedule workspaces at creation and execution against real directories, reject malformed/outside paths, and bound scheduler retry attempts with an explicit terminal policy.

## Task 6: CLI and end-to-end verification

- [x] Add `kestrel memory list|search` and `kestrel self inspect` CLI smoke coverage using the existing runtime/repository boundaries.
- [x] Run managed Bun full tests, typecheck, diff check, and CLI smoke; inspect the diff for no messaging integrations and no weakened secret/path/process safety.
- [x] Commit all fixes in one clearly named commit at the requested HEAD lineage and report the exact verification results and commit hash.
