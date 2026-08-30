# Kestrel project wiki

This wiki is the compiled, source-linked documentation for Kestrel: a local, single-user agent that turns an OpenAI-compatible model into a bounded tool-using runtime. It is intentionally separate from the implementation and design-history documents so that future maintenance can update the knowledge layer without changing evidence.

## Navigation

| Page | Scope |
| --- | --- |
| [Architecture](architecture.md) | End-to-end system shape, execution lifecycle, persistence, scheduling, and self-improvement |
| [Internal components](components.md) | Module responsibilities, APIs, invariants, and extension points |
| [Security model](security.md) | Trust boundaries, policy and approvals, filesystem/process controls, secrets, recovery, and residual risk |
| [Source map](sources.md) | Evidence inventory and provenance for the generated pages |
| [Maintenance log](log.md) | Append-only wiki operations history |

## Reading conventions

- Claims are either **sourced facts** or explicitly labelled **synthesis**. Sourced facts link to implementation files, tests, or project design documents.
- Line references identify the relevant implementation at the time this page was reviewed. If a source moves, follow the file link and re-check the surrounding function or heading.
- Tests demonstrate intended behavior, but they do not replace runtime or platform-specific review. Current workflow and native Secret Scanning status are external repository state; the repository records the enablement procedure and known permission boundary in [docs/security.md](../security.md).

## Current snapshot

- Project: Kestrel 0.1.0, TypeScript with Bun runtime. [src/index.ts](../../src/index.ts#L1-L4), [package.json](../../package.json#L1-L17)
- Primary entry points: `createKestrel`, `RunKernel`, the CLI, and `SchedulerDaemon`. [src/index.ts](../../src/index.ts#L32-L91), [src/cli/main.ts](../../src/cli/main.ts#L298-L340)
- Persistence: SQLite-backed tasks, runs, messages, events, tool calls, approvals, memories, and schedules. [src/store/repository.ts](../../src/store/repository.ts#L9-L136)
- External model contract: normalized internal messages and tool definitions translated to `POST {base-url}/chat/completions`. [src/protocol/types.ts](../../src/protocol/types.ts#L1-L36), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L227-L286)
- Security posture: explicit approvals for high-risk operations, workspace/path checks, bounded outputs, redaction, durable audit records, and fail-closed recovery. [docs/security.md](../security.md), [src/policy/rules.ts](../../src/policy/rules.ts#L284-L334)

## Open questions and external state

1. GitHub-native Secret Scanning is not a source-controlled setting. Its administrator enablement and verification path is documented, but must be confirmed in repository settings by an account with the required permission and entitlement. [docs/security.md](../security.md#github-native-secret-scanning-status)
2. Kestrel is deliberately a trusted-user application, not a hostile-code sandbox or multi-tenant isolation boundary. Stronger OS/container isolation is required for hostile local users or untrusted code. [docs/security.md](../security.md#threat-model)

