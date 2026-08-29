# Task 7 Runtime and Shell Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Kestrel process execution and shell argument validation against process-tree escapes, pipe hangs, nested shells/background launchers, PATH injection, and cwd replacement races.

**Architecture:** Keep process execution in `src/runtime/process.ts`, but spawn every managed POSIX child as a detached session/process-group leader and terminate its group using a validated negative-PID kill with direct-child fallback. Make `shell.exec` an explicit argv tool that never invokes a shell, rejects shell/background launcher forms structurally, and uses a fixed PATH unless the caller explicitly supplies the approved value. Add a no-follow secure cwd descriptor in `secure-fs.ts`; hold it while spawning and revalidate its identity immediately before Bun.spawn.

**Tech Stack:** TypeScript, Bun, Bun subprocess groups, Darwin no-follow directory descriptors via existing Bun FFI, Bun tests.

---

### Task 1: Add failing process-tree and cwd-race regressions

**Files:**
- Create: `tests/process.test.ts`
- Modify: `tests/shell.test.ts`

- [x] Add a timeout regression that runs a Bun parent which creates a long-lived descendant inheriting stdout/stderr, then assert the process result is timed out and returns within a bounded interval.
- [x] Add an abort regression with the same descendant setup and assert the result is aborted and returns within a bounded interval.
- [x] Add a cwd replacement regression that opens a secure cwd descriptor, replaces the pathname with a different directory before `runProcess`, and asserts no process starts and execution fails closed.
- [x] Update shell tests to call `shell.exec` with `argv`, and add cases for `sh/bash/zsh/dash/fish -c`, `cmd /c`, PowerShell command flags, quoted background commands, and direct `&` tokens.
- [x] Run the focused tests against `bfc416d`; the new process-tree/cwd tests and argv-schema tests must fail for the current implementation.

### Task 2: Implement safe detached process-group termination and bounded pipe capture

**Files:**
- Modify: `src/runtime/process.ts`

- [x] Spawn with `detached: true` so POSIX Bun calls `setsid()` and makes the leader the process-group leader.
- [x] Add a safe POSIX group-signal helper that refuses invalid/self/parent PIDs, sends `SIGTERM` then `SIGKILL` to `-pid`, and falls back to the Bun direct-child handle without ever signaling the agent PID or parent PID.
- [x] Make timeout/abort termination cancel both stream readers, bound final pipe draining, and return a result even if a descendant retains a pipe unexpectedly.
- [x] Keep the timeout/abort outcome metadata and exit status behavior stable, and rethrow spawn/validation failures as `ToolExecutionError`.

### Task 3: Make shell execution argv-only and fail closed

**Files:**
- Modify: `src/tools/shell.ts`
- Modify: `src/policy/rules.ts`

- [x] Replace the `command` schema field with required `argv: string[]`, invoke `runProcess` directly with that argv, and remove shell-string/background regex parsing.
- [x] Structurally reject known shell executable tokens and command flags (POSIX shells, `cmd`, PowerShell, and `pwsh`), wrapper forms that contain them, known session/background launchers, and standalone shell control tokens such as `&`.
- [x] Keep the approval capability/risk model, but include argv in command-risk classification so existing network/destructive/package/credential approval signals continue to work.
- [x] Stop inheriting `process.env.PATH`; use the fixed fallback PATH by default and accept a requested PATH only when it exactly matches the approved fallback value. Preserve the existing HOME-only override and credential-key rejection.

### Task 4: Hold and revalidate a no-follow cwd descriptor across spawn

**Files:**
- Modify: `src/tools/secure-fs.ts`
- Modify: `src/runtime/process.ts`
- Modify: `src/tools/shell.ts`

- [x] Export secure cwd-directory open/revalidate/close helpers backed by the existing `O_DIRECTORY | O_NOFOLLOW` traversal.
- [x] Open the resolved cwd descriptor before environment setup, retain it through `runProcess`, revalidate both the held fd and the pathname-resolved fd immediately before Bun.spawn, and close it in a `finally` block.
- [x] Fail closed when the cwd path is replaced, becomes a symlink, or ceases to be a directory.

### Task 5: Verify, inspect, and commit

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-task-7-runtime-shell.md`
- Modify: `src/runtime/process.ts`
- Modify: `src/tools/secure-fs.ts`
- Modify: `src/tools/shell.ts`
- Modify: `src/policy/rules.ts`
- Modify: `tests/process.test.ts`
- Modify: `tests/shell.test.ts`

- [x] Run managed Bun focused tests for process and shell execution.
- [x] Run managed Bun full tests.
- [x] Run `npm run typecheck`.
- [x] Run `git diff --check` and inspect the final diff, preserving unrelated untracked files.
- [x] Commit the tracked Task 7 changes with a focused message and report exact verification results.
