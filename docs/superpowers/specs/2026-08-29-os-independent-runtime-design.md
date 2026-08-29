# macOS and Linux Portability Design

**Date:** 2026-08-29

## Goal

Make Kestrel work on both macOS and Linux while preserving the existing secure filesystem, patch-rollback, and process-cleanup guarantees. Windows support remains out of scope for this change.

## Current problem

Kestrel's secure filesystem module loads \`/usr/lib/libSystem.B.dylib\` at module initialization. That is correct for macOS but fails on Linux before tests or the CLI can start. The module also documents Darwin-specific directory-entry assumptions and native locking.

## Scope

This change includes:

- A shared native filesystem contract used by the existing secure filesystem and process code.
- A Darwin implementation backed by \`libSystem.B.dylib\`.
- A Linux implementation backed by the host C library, resolved from supported Linux library names.
- Runtime platform selection with fail-closed behavior for unsupported platforms.
- Linux and macOS test coverage for equivalent security behavior.
- CI checks on \`macos-latest\` and \`ubuntu-latest\`, each with Bun \`1.4.0\` and \`latest\`.
- Documentation updates that identify macOS and Linux as supported platforms.

Windows, cross-compilation, and weakening secure operations to make unsupported platforms appear to work are out of scope.

## Architecture

### Shared contract

Move the native symbol declarations and platform-independent wrappers behind a focused internal adapter boundary. The shared layer owns:

- Secure descriptor traversal using \`openat\`, \`mkdirat\`, \`renameat\`, \`linkat\`, and \`unlinkat\`.
- Directory enumeration through \`fdopendir\`, \`readdir\`, and \`closedir\`.
- Advisory patch locking through \`flock\`.
- Native errno access and error translation.
- Shared flags, descriptor identity checks, bounded directory-entry parsing, and rollback behavior.

Callers such as the filesystem, shell, upgrade workflow, and tests depend on the shared interface rather than loading a library directly.

### Platform adapters

The Darwin adapter loads \`/usr/lib/libSystem.B.dylib\`. The Linux adapter selects a system C library from an explicit ordered list appropriate to the running architecture, beginning with \`libc.so.6\` and allowing the standard loader to resolve it. Both adapters must expose the same symbol set and function signatures.

Adapter creation is lazy or performed by an explicit factory before the first native operation, not as an unconditional top-level import side effect. Missing libraries or symbols produce a stable \`ToolExecutionError\` describing the unsupported runtime and operation. No fallback silently replaces secure descriptor operations with pathname-only operations.

### Platform selection

Selection uses \`process.platform\`:

- \`darwin\` selects the Darwin adapter.
- \`linux\` selects the Linux adapter.
- Any other value throws a clear unsupported-platform error when the secure runtime is initialized.

The selected adapter is immutable for the process lifetime. The implementation must not allow an environment variable or model/tool argument to select an arbitrary library path.

## Security and behavioral invariants

Portability must not change these existing guarantees:

- Workspace traversal rejects paths outside the resolved workspace.
- Directory and file opens use no-follow and nonblocking protections where supported by the platform.
- Descriptor identity is revalidated across cwd races.
- Patch transactions hold their lock and descriptor identities through commit or rollback cleanup.
- Replacement or symlink races fail closed without unlinking an unverified path.
- Native directory records are bounded and validated before names are decoded.
- Managed process termination never signals the agent or its parent.
- Unsupported platforms fail closed rather than silently degrading security.

Platform-specific constants, such as directory-entry layout and errno values, belong in the relevant adapter. The shared layer must not assume Darwin-only record sizes or errno numbers.

## Error handling

Native library loading, missing symbols, invalid directory records, and unsupported platform selection are operational errors with bounded messages. Error output must not include credentials or unbounded native data. Linux and Darwin errno names must map to the same stable error categories used by callers, while retaining platform-specific numeric details only where already exposed as bounded metadata.

## Testing

The test suite will run natively on both macOS and Linux. Shared behavioral tests must cover:

- secure directory listing and bounded native entry parsing;
- traversal, symlink, special-file, and cwd replacement rejection;
- patch staging, commit, rollback, and recovery artifact behavior;
- concurrent patch lock handling;
- shell/process timeout and cancellation;
- adapter initialization and unsupported-platform failure.

Platform-specific tests will assert the adapter library selection and the local directory-entry ABI assumptions without hardcoding Darwin behavior into Linux tests. Tests that require native FFI must be skipped only for unsupported platforms, not for macOS or Linux.

## CI

The CI checks job will use an operating-system matrix with \`macos-latest\` and \`ubuntu-latest\`, combined with Bun \`1.4.0\` and \`latest\`. The actionlint job may remain on \`ubuntu-latest\`. CodeQL and dependency review remain unchanged except for documentation references.

## Compatibility and migration

Existing public APIs remain unchanged. The refactor only changes how secure native operations are selected and loaded. Existing macOS users retain the current library and behavior. Linux becomes a supported runtime, and unsupported platforms receive a deterministic startup error instead of a low-level dynamic-library exception.

## Acceptance criteria

The change is complete when:

1. \`mise exec -- bun run check\` passes on macOS.
2. The same typecheck and test commands pass on Ubuntu with Bun \`1.4.0\` and \`latest\`.
3. No production module contains an unconditional Darwin library load.
4. Secure filesystem and process callers use the shared adapter contract.
5. Unsupported platforms fail closed with a stable error.
6. CI runs both supported operating systems and the README documents them.

