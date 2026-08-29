# macOS and Linux Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Kestrel’s unconditional Darwin native filesystem dependency with a shared adapter that supports macOS and Linux while preserving secure traversal, rollback, and process behavior.

**Architecture:** Introduce a lazy native-filesystem adapter with one shared symbol contract and Darwin/Linux implementations. Keep security policy and filesystem operations in src/tools/secure-fs.ts; move only library loading, ABI constants, errno access, and directory-entry decoding behind the adapter. Expand CI to test both supported operating systems and both supported Bun lanes.

**Tech Stack:** TypeScript, Bun bun:ffi, Bun test, Node-compatible filesystem APIs, GitHub Actions.

---

### Task 1: Add failing adapter and ABI tests

**Files:**
- Create: tests/native-fs.test.ts
- Modify: tests/tools.test.ts

- [ ] **Step 1: Write tests for platform selection and native contracts**

Create tests/native-fs.test.ts with tests for the API that will be introduced:

~~~~ts
import { expect, test } from "bun:test";
import { getNativeFs, loadNativeFsForPlatform } from "../src/tools/native-fs";

test("loads a complete native adapter on macOS and Linux", () => {
  expect(["darwin", "linux"]).toContain(process.platform);
  const native = getNativeFs();
  expect(native.platform).toBe(process.platform);
  expect(native.symbols.openat).toBeFunction();
  expect(native.symbols.renameat).toBeFunction();
  expect(native.symbols.unlinkat).toBeFunction();
  expect(native.dirent.maxRecordBytes).toBeGreaterThan(0);
});

test("rejects unsupported platforms before selecting a library", () => {
  expect(() => loadNativeFsForPlatform("win32")).toThrow(/unsupported platform/i);
});

test("Linux and Darwin adapters expose platform-specific constants", () => {
  const native = getNativeFs();
  expect(Number.isInteger(native.constants.atFdcwd)).toBe(true);
  expect(Number.isInteger(native.constants.atRemovedir)).toBe(true);
  expect(native.errnoNames[2]).toBe("ENOENT");
});
~~~~

Replace the direct libSystem.B.dylib load in tests/tools.test.ts with getNativeFs().symbols.mkfifo for both FIFO tests.

- [ ] **Step 2: Add ABI fixture tests**

In tests/native-fs.test.ts, add one fixture for each supported ABI. Darwin uses record length at offset 16, name length at 18, type at 20, and name at 21. Linux uses d_reclen at offset 16, d_type at 18, and a NUL-terminated name at 19. Assert both decode the same name/type and reject oversized records and missing NUL terminators.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

~~~~sh
mise exec -- bun test tests/native-fs.test.ts tests/tools.test.ts
~~~~

Expected: failure because src/tools/native-fs and the adapter-backed FIFO path do not exist. Fix only test typos if the failure is unrelated to the missing adapter.

### Task 2: Implement the shared native filesystem contract and adapters

**Files:**
- Create: src/tools/native-fs/types.ts
- Create: src/tools/native-fs/darwin.ts
- Create: src/tools/native-fs/linux.ts
- Create: src/tools/native-fs/index.ts
- Test: tests/native-fs.test.ts

- [ ] **Step 1: Define the shared contract**

Create src/tools/native-fs/types.ts with this contract:

~~~~ts
export type NativePlatform = "darwin" | "linux";

export type NativeSymbols = {
  openat: (directoryFd: number, path: string, flags: number, mode: number) => number;
  flock: (fd: number, operation: number) => number;
  linkat: (oldFd: number, oldPath: string, newFd: number, newPath: string, flags: number) => number;
  mkdirat: (directoryFd: number, path: string, mode: number) => number;
  renameat: (oldFd: number, oldPath: string, newFd: number, newPath: string) => number;
  unlinkat: (directoryFd: number, path: string, flags: number) => number;
  fdopendir: (fd: number) => unknown;
  readdir: (directory: unknown) => unknown;
  closedir: (directory: unknown) => number;
  errnoPointer: () => unknown;
  strerror: (errorNumber: number) => string | null;
  mkfifo: (path: string, mode: number) => number;
};

export type NativeDirentLayout = {
  headerBytes: number;
  nameOffset: number;
  typeOffset: number;
  maxRecordBytes: number;
  maxNameBytes: number;
  decodeDirent: (record: Uint8Array) => { recordLength: number; name: string; type: number };
};

export type NativeFs = {
  platform: NativePlatform;
  libraryPath: string;
  symbols: NativeSymbols;
  constants: {
    atFdcwd: number;
    atRemovedir: number;
    lockExclusive: number;
    lockNonblocking: number;
  };
  dirent: NativeDirentLayout;
  errnoNames: Readonly<Record<number, string>>;
  errno: () => number;
};
~~~~

Keep the FFI cast isolated at the adapter boundary. decodeDirent must validate record bounds, NUL termination, name bounds, and UTF-8 before returning.

- [ ] **Step 2: Implement Darwin loading**

Create src/tools/native-fs/darwin.ts. Load /usr/lib/libSystem.B.dylib, map __error to errnoPointer, use atFdcwd -2 and atRemovedir 0x0080, preserve the current Darwin dirent layout and errno map, and expose mkfifo.

- [ ] **Step 3: Implement Linux loading**

Create src/tools/native-fs/linux.ts. Try fixed library candidates libc.so.6, libc.musl-x86_64.so.1, and libc.musl-aarch64.so.1. Map __errno_location to errnoPointer, use atFdcwd -100 and atRemovedir 0x0200, and decode Linux struct dirent with d_reclen at 16, d_type at 18, and name at 19.

Catch each failed candidate. If all fail, throw a bounded ToolExecutionError naming Linux and the operation without exposing arbitrary loader text.

- [ ] **Step 4: Implement lazy platform selection**

Create src/tools/native-fs/index.ts with getNativeFs(): NativeFs and loadNativeFsForPlatform(platform: string): NativeFs. Select only darwin or linux, cache the immutable adapter after successful initialization, and throw a stable unsupported-platform ToolExecutionError otherwise. Never accept a library path from environment, tools, or model output.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

~~~~sh
mise exec -- bun test tests/native-fs.test.ts tests/tools.test.ts
mise exec -- bun run typecheck
~~~~

Expected: focused tests pass on macOS and the same tests pass on Linux without loading libSystem.B.dylib.

### Task 3: Refactor secure filesystem operations to use the adapter

**Files:**
- Modify: src/tools/secure-fs.ts
- Modify: tests/native-fs.test.ts
- Modify: tests/tools.test.ts

- [ ] **Step 1: Remove unconditional Darwin loading**

Remove dlopen, FFIType, and the top-level libSystem.B.dylib load from secure-fs.ts. Import getNativeFs and obtain it through a lazy helper. Replace hardcoded AT_FDCWD, AT_REMOVEDIR, lock values, errno access, and native symbol calls with adapter values.

- [ ] **Step 2: Use adapter directory-entry decoding**

Replace Darwin-only header constants and fixed name-length reads with native.dirent.decodeDirent. Preserve exported validation behavior and keep record/name bounds before copying or decoding.

- [ ] **Step 3: Preserve security invariants**

Keep descriptor identity checks, no-follow/nonblocking flags, patch lock lifetime, rollback descriptors, and fail-closed cleanup unchanged except for adapter-sourced constants and symbols. Ensure openRoot, traversal, FIFO rejection, directory listing, and patch cleanup behave identically on macOS and Linux.

- [ ] **Step 4: Run focused regressions**

Run:

~~~~sh
mise exec -- bun test tests/native-fs.test.ts tests/tools.test.ts tests/process.test.ts tests/shell.test.ts
mise exec -- bun run typecheck
~~~~

Expected: all focused tests pass on macOS; the same command must pass on Linux in CI.

### Task 4: Expand CI and documentation

**Files:**
- Modify: .github/workflows/ci.yml
- Modify: README.md

- [ ] **Step 1: Expand the CI matrix**

Change the checks matrix to:

~~~~yaml
strategy:
  fail-fast: false
  matrix:
    os: [macos-latest, ubuntu-latest]
    bun-version: ['1.4.0', latest]
runs-on: ${{ matrix.os }}
name: Checks (${{ matrix.os }}, Bun ${{ matrix.bun-version }})
~~~~

Keep checkout, Bun setup, Node setup, npm ci --ignore-scripts, check, smoke, concurrency, permissions, and the independent Ubuntu actionlint job.

- [ ] **Step 2: Document both supported operating systems**

Update the opening README sentence to say local macOS/Linux task agent. Update the CI paragraph to state that checks run on both macOS and Linux with Bun 1.4.0 and latest, and unsupported operating systems fail closed.

- [ ] **Step 3: Validate workflow and documentation**

Run:

~~~~sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml")'
rg -n "macOS/Linux|macos-latest|ubuntu-latest|1\.4\.0|latest|unsupported" README.md .github/workflows/ci.yml
git diff --check
~~~~

Expected: YAML parses, all support references are present, and no whitespace errors are reported.

### Task 5: Full cross-platform verification and commit

**Files:**
- Verify: src/tools/native-fs/*.ts
- Verify: src/tools/secure-fs.ts
- Verify: tests/native-fs.test.ts
- Verify: tests/tools.test.ts
- Verify: .github/workflows/ci.yml
- Verify: README.md

- [ ] **Step 1: Run macOS verification**

Run:

~~~~sh
npm ci --ignore-scripts
mise exec -- bun run check
mise exec -- bun run smoke
git diff --check
~~~~

Expected: typecheck and all tests pass with zero failures; smoke passes.

- [ ] **Step 2: Run Linux verification**

On Linux, run:

~~~~sh
npm ci --ignore-scripts
bun run check
bun run smoke
~~~~

Expected: libc.so.6 loads, all tests pass, and no libSystem.B.dylib error occurs. If local Linux is unavailable, use both Ubuntu matrix jobs as evidence and record their run URL.

- [ ] **Step 3: Inspect portability and security invariants**

Run:

~~~~sh
! rg -n 'dlopen\("/usr/lib/libSystem\.B\.dylib"|/usr/lib/libSystem\.B\.dylib' src tests
rg -n 'getNativeFs|loadNativeFsForPlatform|macos-latest|ubuntu-latest' src tests .github/workflows README.md
git status --short
~~~~

Expected: no unconditional Darwin load remains; native callers use the adapter; both CI operating systems are configured; and only intended changes are present.

- [ ] **Step 4: Commit focused changes**

Run:

~~~~sh
git add src/tools/native-fs src/tools/secure-fs.ts tests/native-fs.test.ts tests/tools.test.ts .github/workflows/ci.yml README.md
git commit -m "feat: support macOS and Linux runtimes"
~~~~

Expected: one focused portability commit containing only the listed implementation, tests, CI, and documentation files.
