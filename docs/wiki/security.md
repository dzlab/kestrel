# Kestrel security model

## Security summary

Kestrel is designed to reduce accidental overreach by a model-driven local agent. It is not a multi-tenant boundary, a privilege separation mechanism, or a hostile-code sandbox. The primary security strategy is layered control: validate untrusted data, constrain filesystem/process scope, classify tool risk, require exact human approval for high-risk actions, persist decisions and audit events, bound all model-facing data, and fail closed when recovery is ambiguous. [docs/security.md](../security.md#threat-model), [docs/security.md](../security.md#boundaries-and-mitigations)

## Threat model and trust boundaries

### Trusted

- The local user and the Kestrel executable/configuration are trusted to define the workspace, model endpoint, and approval decisions.
- Built-in tool implementations created by the registry are trusted identities for their declared capabilities, subject to runtime validation and policy. [src/tools/registry.ts](../../src/tools/registry.ts#L17-L61), [src/tools/registry.ts](../../src/tools/registry.ts#L171-L204)
- SQLite is treated as durable application state, but migrations and typed decoders still validate its shape before use. [src/store/migrations.ts](../../src/store/migrations.ts#L1641-L1935), [src/store/repository.ts](../../src/store/repository.ts#L155-L362)

### Untrusted or treated as untrusted

- Model output, including tool names, arguments, content, finish reasons, and usage.
- Filesystem content and search results, which may contain prompt injection or credentials.
- Memory content, explicitly labelled untrusted when added to the model context.
- Provider response bodies and error details.
- Custom tool implementations and tool metadata supplied outside the canonical built-in set.
- Scheduled prompts and persisted task content, which are user-controlled inputs but run later under the same policy.

The model is an orchestrator, not an authority: the registry parses and validates its calls, and the policy engine independently determines whether each call is allowed. [src/protocol/validation.ts](../../src/protocol/validation.ts#L42-L142), [src/tools/registry.ts](../../src/tools/registry.ts#L215-L269)

## Data-flow controls

```text
provider response / local file / memory
             |
             v
      parse + validate + bound
             |
             v
     registry + policy decision
       |                 |
       | low/standard    | high-risk
       v                 v
   execute + redact   durable approval
       |                 |
       +---------> bounded result/audit
```

The control is repeated at component boundaries. Provider-shaped responses are normalized then parsed; tool calls are parsed and schema-checked again by the registry; results are redacted and bounded before entering the next model turn or durable audit payload. [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L227-L286), [src/tools/registry.ts](../../src/tools/registry.ts#L215-L269), [src/tools/types.ts](../../src/tools/types.ts#L31-L83), [src/store/repository.ts](../../src/store/repository.ts#L138-L188)

## Filesystem and path security

The configured workspace is the filesystem boundary for ordinary tools. Path resolution rejects traversal, absolute escapes, NULs, existing symlink components, and unsafe special files. Secure filesystem helpers use no-follow/non-blocking flags, descriptor identity checks, parent revalidation, and atomic temporary/recovery operations for writes and patches. [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L47-L155), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L18-L23), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L122-L205), [src/tools/secure-fs.ts](../../src/tools/secure-fs.ts#L298-L491)

Reads and searches are bounded by bytes/matches and avoid sensitive paths. Search skips `.git`, `node_modules`, symlinks, and special files; sensitive file names include `.env`, private-key extensions, and credential-like names. [src/tools/search.ts](../../src/tools/search.ts#L26-L80), [src/tools/redaction.ts](../../src/tools/redaction.ts#L3-L17)

Patches validate all file headers and hunks before mutation, preserve recovery artifacts when cleanup cannot be proven safe, and restore earlier files if a later commit operation fails. [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L289-L408), [src/tools/filesystem.ts](../../src/tools/filesystem.ts#L540-L981)

## Shell, Bun, and process security

`shell.exec` and `bun.run` are high-risk policy capabilities. They require approval through the registry, accept argv rather than shell command strings, reject nested shell and detached/background launcher patterns, limit executable environment variables, force a safe PATH, and bind cwd to the workspace. [src/policy/rules.ts](../../src/policy/rules.ts#L252-L284), [src/tools/shell.ts](../../src/tools/shell.ts#L72-L125)

The process runtime bounds stdout/stderr, terminates process groups on timeout or cancellation, and reports only bounded metadata/output. This prevents indefinite hangs and reduces accidental output leakage, but it does not constrain arbitrary code that the trusted local user permits the process to execute. [src/runtime/process.ts](../../src/runtime/process.ts#L84-L149), [docs/security.md](../security.md#boundaries-and-mitigations)

## Model endpoint and secret handling

The OpenAI-compatible client sends the configured API key only as an HTTP bearer header. It does not put the key into internal messages, tool definitions, or model-visible context. Response bodies are capped at 1 MiB; provider error text is capped before propagation; retryable bodies are cancelled/discarded before retry. [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L6-L10), [src/model/openai-compatible.ts](../../src/model/openai-compatible.ts#L227-L286)

Tool output and structured data pass through redaction for common assignments, bearer values, AWS/GitHub/OpenAI-like tokens, JWTs, and configured patterns. Memory admission independently rejects credential-like content and common instruction-injection phrases. [src/tools/redaction.ts](../../src/tools/redaction.ts#L1-L49), [src/tools/types.ts](../../src/tools/types.ts#L31-L45), [src/memory/security.ts](../../src/memory/security.ts#L3-L35)

Redaction is a defense against accidental disclosure, not proof that all possible secrets are detected. Operators must still avoid putting credentials in prompts, task content, logs, or intentional fixtures.

## Policy and approval security

The policy engine has a closed set of known tool rules. Unknown names, mismatched capability metadata, malformed schemas, invalid JSON values, unsafe paths, self-targeting operations, risky command signals, and high-risk capabilities fail closed or require approval. Standard workspace writes are allowed but logged; shell/process/network/credential/destructive/package/daemon/schedule mutation/self-modification capabilities require explicit approval. [src/policy/rules.ts](../../src/policy/rules.ts#L16-L43), [src/policy/rules.ts](../../src/policy/rules.ts#L284-L334)

An approval binds the exact tool and canonical arguments hash, task/run identity, capability, risk, expiry, and version. Approve/deny requires a pending version; consume requires the same hash, approved state, valid expiry, and expected version. Consumption is transactional and one-shot, so changed arguments cannot reuse an old decision. [src/policy/approvals.ts](../../src/policy/approvals.ts#L52-L108), [src/policy/approvals.ts](../../src/policy/approvals.ts#L110-L211), [src/store/repository.ts](../../src/store/repository.ts#L636-L751)

## Persistence and recovery security

The default data directory is private (`0700`) and the database file is private (`0600`). CLI configuration rejects `:memory:`, directories, symlink database files, and unsafe symlink ancestors. [src/config.ts](../../src/config.ts#L45-L91), [src/config.ts](../../src/config.ts#L136-L148)

Events are append-only at the repository layer. Runs and tool calls are recorded before execution; idempotency keys and unique call identity prevent duplicate safe work; unfinished executing calls fail closed instead of being replayed. Schema migrations verify checksums, lineage, tables, indexes, foreign keys, status checks, and lease tuple shape before exposing the repository. [src/kernel/loop.ts](../../src/kernel/loop.ts#L240-L259), [src/store/repository.ts](../../src/store/repository.ts#L403-L531), [src/store/migrations.ts](../../src/store/migrations.ts#L1000-L1190), [docs/architecture.md](../architecture.md#persistence-lifecycle)

Backups/restores require stopping the daemon first. A damaged database should be preserved for diagnosis; recovery should use a protected known-good backup rather than deleting or rebuilding state in place. [README.md](../../README.md#persistence-backups-and-recovery), [docs/security.md](../security.md#recovery-expectations)

## Scheduler security

Schedules are high-risk mutations when created or cancelled. Execution uses SQLite owner/lease/fencing-token predicates, heartbeat renewal, stale-lease reclamation, bounded retry delay, and a final lease check before committing results. If a lease is lost, the worker cannot finalize the schedule and the kernel receives cancellation. Approval-blocked work remains paused with durable run/approval references. [src/tools/schedule.ts](../../src/tools/schedule.ts#L21-L105), [src/scheduler/daemon.ts](../../src/scheduler/daemon.ts#L60-L151), [src/store/repository.ts](../../src/store/repository.ts#L859-L1010)

This prevents duplicate scheduler workers from committing the same occurrence, but a scheduled prompt is still an instruction to a trusted local runtime. It should be treated as user-authored automation and reviewed with the same care as an interactive request.

## Self-modification security

Self-upgrade is not a direct arbitrary write. The proposal records target files, patch hash, base revision, repository state hash, snapshot hash, verification command, and self-target metadata. Apply rechecks all of those values, consumes an exact high-risk approval, applies through the filesystem patch engine, runs the approved verifier under bounded rules, and rolls back on verification failure. [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L205-L249), [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L267-L347)

The invariant is “approval covers this exact proposal against this exact workspace state,” not “the model is trusted to improve itself.” Verification cannot silently fetch packages or alter its command after approval. [src/upgrade/workflow.ts](../../src/upgrade/workflow.ts#L91-L130), [docs/security.md](../security.md#boundaries-and-mitigations)

## Repository secret scanning

The repository workflow runs on pull requests, `main` pushes, and manual dispatch. It uses immutable action pins, a full-history checkout, a configuration guard before scanning, a redacted current-tree scan, a redacted `--all` Git-history scan, and a final fail-closed aggregation step. It grants only `contents: read`, disables comments/artifact uploads, and rejects unreviewed root Gitleaks configuration files. [secret-scanning.yml](../../.github/workflows/secret-scanning.yml#L1-L70), [tests/secret-scanning.test.ts](../../tests/secret-scanning.test.ts#L226-L416)

The workflow is separate from GitHub-native Secret Scanning. Gitleaks findings appear in the failed check/workflow under Actions; native provider-aware alerts, when enabled by a repository administrator, appear under Security → Secret scanning. [docs/security.md](../security.md#secret-scanning)

## Finding response

Treat any real credential finding as compromised:

1. Revoke or rotate the credential with its provider immediately.
2. Remove it from the current tree and inspect logs, artifacts, task content, memory, and other copies.
3. If it exists in history, use an approved history-remediation procedure, then rotate again.
4. Do not paste secret values into issues, pull requests, logs, or remediation notes.

These operational steps are sourced from the project security guidance. [docs/security.md](../security.md#finding-response)

## GitHub-native Secret Scanning status

Native Secret Scanning is repository configuration, not a source-controlled fact. Administrators can verify permissions and status with the command in [docs/security.md](../security.md#github-native-secret-scanning-status), then enable only `security_and_analysis.secret_scanning.status=enabled` through the documented REST API request. Push protection is intentionally a separate setting and is not implied by this repository workflow. [docs/security.md](../security.md#github-native-secret-scanning-status)

## Residual risks

- A local user/process with access to the account, workspace, database, or process can bypass application-level controls.
- Approved shell/Bun execution can run arbitrary local code within the OS account; process control is not sandboxing.
- Redaction patterns are finite and can miss novel or encoded credentials.
- Provider/API security, model quality, and GitHub entitlement are outside Kestrel's local enforcement boundary.
- The project has no messaging/social automation integration in the initial release, reducing contact-facing side effects but also leaving those integrations out of scope. [docs/security.md](../security.md#threat-model)

