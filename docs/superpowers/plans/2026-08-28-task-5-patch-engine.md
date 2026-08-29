# Task 5 Patch Engine Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Kestrel unified patch parsing and filesystem rollback/cleanup against pathname replacement races while accepting standard Git diff metadata.

**Architecture:** Keep one nonblocking advisory transaction lock on the workspace directory for the complete patch operation. Retain open descriptors for staged, installed, and backup identities; cleanup opens and verifies the pathname, keeps that descriptor open through any test hook and mutation, and re-verifies before unlinking. Newly-created files receive a hard-linked recovery artifact until commit cleanup succeeds. Parse only recognized `diff --git`, `index`, and standard mode metadata outside strict unified file/hunk sections.

**Tech Stack:** TypeScript, Bun, Bun FFI to Darwin libc, Bun test.

---

### Task 1: Add parser regressions

**Files:**
- Modify: `tests/tools.test.ts`

- [x] Add a regression for EOF insertion using `@@ -2,0 +3,1 @@` and assert the new line is appended.
- [x] Add a regression accepting `diff --git` and `index` metadata for multiple file sections.
- [x] Add a regression rejecting malformed `diff --git` metadata.
- [x] Add an adversarial `beforeCleanup` replacement-hook regression asserting the replacement survives rollback and the backup remains recoverable.
- [x] Run the focused tests and confirm the new tests fail for the current implementation.

### Task 2: Correct unified parser semantics and metadata grammar

**Files:**
- Modify: `src/tools/filesystem.ts`

- [x] Parse recognized Git metadata before each file section and reject unrecognized nonempty section data.
- [x] Require the complete hunk header shape while preserving optional section headings.
- [x] Keep `newStart` and `newCount` as parsed values and validate their zero-count combinations.
- [x] Map old zero-count hunks to the insertion offset after `oldStart` old lines; preserve the one-based offset for nonzero ranges and validate new offsets against produced output.
- [x] Run focused parser regressions to green.

### Task 3: Make patch cleanup descriptor-held and lock-scoped

**Files:**
- Modify: `src/tools/secure-fs.ts`
- Modify: `src/tools/filesystem.ts`

- [x] Add a nonblocking Darwin `flock` transaction lock on the opened workspace directory.
- [x] Return and retain the temporary file descriptor from staging; do not pathname-unlink an uncertain staging artifact after closing its identity descriptor.
- [x] Add `linkat` support so newly-created files retain a same-identity recovery hard link until commit cleanup.
- [x] Retain backup descriptors through commit and rollback.
- [x] Implement cleanup that opens/verifies the current pathname, keeps the identity descriptor open through the unlink, and re-verifies after the adversarial hook; fail closed without removing or restoring on mismatch.
- [x] Move created-directory identity verification and removal before closing the directory descriptor.
- [x] Run all filesystem tests and typecheck.

### Task 4: Full verification and commit

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-task-5-patch-engine.md`
- Modify: `src/tools/filesystem.ts`
- Modify: `src/tools/secure-fs.ts`
- Modify: `tests/tools.test.ts`

- [x] Run managed Bun focused tests.
- [x] Run managed Bun full tests.
- [x] Run `npm run typecheck`.
- [x] Inspect `git diff --check` and the final diff, preserving pre-existing untracked files.
- [ ] Commit the patch-engine changes with a focused message and report exact verification results.
