# Wiki source map

This page records the raw evidence used to compile the Kestrel wiki. The source files listed here are immutable evidence for the purposes of the wiki; generated pages under `docs/wiki/` may be revised as the implementation changes.

## Source groups

| Source group | Files | Evidence provided |
| --- | --- | --- |
| Project contract | [README.md](../../README.md), [package.json](../../package.json) | User-facing capabilities, CLI, runtime requirements, scripts, and supported model configuration |
| Architecture/security baselines | [docs/architecture.md](../architecture.md), [docs/security.md](../security.md) | Existing system diagram, component overview, threat model, security boundaries, and operational expectations |
| Public composition | [src/index.ts](../../src/index.ts), [src/config.ts](../../src/config.ts), [src/cli/main.ts](../../src/cli/main.ts) | Runtime assembly, configuration loading, persistence paths, and command surface |
| Agent execution | [src/kernel/loop.ts](../../src/kernel/loop.ts), [src/kernel/context.ts](../../src/kernel/context.ts), [src/kernel/resume.ts](../../src/kernel/resume.ts) | Turn loop, budgets, context bounds, tool dispatch, terminal states, and approval resumption |
| Model/protocol | [src/protocol/types.ts](../../src/protocol/types.ts), [src/protocol/validation.ts](../../src/protocol/validation.ts), [src/model/client.ts](../../src/model/client.ts), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts), [src/model/fake.ts](../../src/model/fake.ts) | Internal message schema, validation, provider normalization, retries, cancellation, and deterministic testing seam |
| Tools and runtime | [src/tools/registry.ts](../../src/tools/registry.ts), [src/tools/types.ts](../../src/tools/types.ts), [src/tools/filesystem.ts](../../src/tools/filesystem.ts), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts), [src/tools/search.ts](../../src/tools/search.ts), [src/tools/shell.ts](../../src/tools/shell.ts), [src/runtime/process.ts](../../src/runtime/process.ts), [src/tools/native-fs/](../../src/tools/native-fs/) | Tool definitions, schema enforcement, workspace-safe files, search, subprocess execution, output bounds, and portable native filesystem adapters |
| Policy and approvals | [src/policy/rules.ts](../../src/policy/rules.ts), [src/policy/approvals.ts](../../src/policy/approvals.ts), [src/policy/types.ts](../../src/policy/types.ts) | Capability/risk classification, path and command signals, exact argument hashes, expiry, and one-shot approvals |
| Durable state | [src/store/database.ts](../../src/store/database.ts), [src/store/migrations.ts](../../src/store/migrations.ts), [src/store/repository.ts](../../src/store/repository.ts), [src/store/transaction.ts](../../src/store/transaction.ts) | SQLite opening, migration lineage, schema invariants, transactions, repository records, idempotency, and leases |
| Memory/scheduling | [src/memory/security.ts](../../src/memory/security.ts), [src/memory/store.ts](../../src/memory/store.ts), [src/memory/tools.ts](../../src/memory/tools.ts), [src/scheduler/expressions.ts](../../src/scheduler/expressions.ts), [src/scheduler/daemon.ts](../../src/scheduler/daemon.ts), [src/tools/schedule.ts](../../src/tools/schedule.ts) | Memory admission/search, bounded schedule expressions, lease renewal, retries, pause/resume, and proactive execution |
| Self-improvement | [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts), [src/upgrade/tools.ts](../../src/upgrade/tools.ts) | Proposal/apply lifecycle, target and repository hashes, approvals, verification, rollback, and self-target detection |
| Verification evidence | [tests/](../../tests/), [CI workflow](../../.github/workflows/ci.yml), [secret scanning workflow](../../.github/workflows/secret-scanning.yml) | Executable behavioral contracts, cross-platform checks, action linting, and repository/history scanning policy |

## Provenance and confidence

- **High confidence:** exported types, function behavior, policy rules, and persistence constraints directly inspected in source and covered by tests.
- **Medium confidence:** end-to-end operational behavior inferred from the composition of independently tested modules, especially daemon lifecycle and external provider behavior.
- **External/unresolved:** GitHub-native Secret Scanning enablement is repository configuration, not a committed source fact. The current procedure and permission limitation are recorded in [docs/security.md](../security.md#github-native-secret-scanning-status).

## Review metadata

- Reviewed: 2026-08-30
- Operation: initial project documentation ingest
- Raw source mutations: none
- Generated pages: `index.md`, `sources.md`, `architecture.md`, `components.md`, `security.md`

