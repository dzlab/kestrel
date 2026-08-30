# Wiki maintenance log

This log is append-only. It records source ingestion and generated-page changes, not implementation commits.

## [2026-08-30] ingest | Kestrel project architecture and security

- Operation: initial project documentation ingest using the `llm-wiki` workflow.
- Sources read: README, existing architecture/security docs, public composition/config/CLI, kernel/context, protocol/model, tools/runtime, policy/approvals, store/migrations/repository, memory, scheduler, and upgrade modules; related tests and CI/security workflows were used as verification evidence.
- Pages created: `index.md`, `sources.md`, `architecture.md`, `components.md`, `security.md`.
- Material coverage: end-to-end architecture, internal components, model/tool protocol, persistence, proactive scheduling, self-upgrade, portability, security boundaries, approvals, secret handling, recovery, and repository secret scanning.
- Raw sources changed: none.
- Unresolved: GitHub-native Secret Scanning enablement remains external repository state and requires administrator permission/entitlement; the exact verification and enablement procedure is linked from the generated security page.

