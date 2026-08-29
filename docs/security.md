# Kestrel security model

## Threat model

Kestrel is designed for a trusted local user who wants protection from accidental overreach, malformed provider output, prompt injection in local files, and duplicate or surprising side effects. It is not a multi-tenant boundary and it is not a sandbox for hostile code. A malicious local user/process with access to the account, filesystem, SQLite file, or running process can bypass application-level controls; use OS isolation and a stronger sandbox for that threat.

The initial release has no messaging, social-automation, or contact-facing integration. Network-capable tools are not registered by default.

## Boundaries and mitigations

- Paths are canonicalized and checked against the configured workspace. Existing symlink escapes and special files are rejected; patch operations validate every target before changing any file.
- Built-ins are created by trusted constructors and carry exact name/capability/schema metadata. The registry rejects duplicate names, malformed schemas, unknown policy rules, and untrusted implementations impersonating automatic tools.
- Reads/searches are bounded. Model context, memory, subprocess output, provider response bodies, and tool results have explicit byte limits.
- Shell and Bun execution are approval-gated, use argument arrays where possible, use a small environment allowlist, cannot launch nested/background shells, and terminate process groups on timeout/cancellation. This reduces accidental leakage but is not a hostile-code sandbox.
- Secrets are not copied into model messages. API keys are optional configuration, process environments are scrubbed, and configured secret patterns are redacted from subprocess output. Memory rejects common credentials and injection markers.
- Approval records bind the exact call ID and canonical argument hash, persist the requested capability/risk, expire, and are consumed once. Approval of changed arguments cannot be reused. Approval commands show the stored arguments before changing state.
- Self-upgrade cannot apply without exact approval. It rechecks Git revision and target hashes, refuses network/package-fetching verification, records output, and rolls back on verification failure.
- SQLite events are append-only at the repository layer. Idempotency keys, tool-call records, and scheduler fencing tokens prevent safe retries from replaying completed work.
- The default state directory and database permissions are private. Configuration rejects the CLI's in-memory database mode, directory targets, and symlink database files. Schema mismatches fail closed.

## Approval policy

Low-risk reads (`fs.list`, `fs.read`, `search.text`, `memory.search`, `schedule.list`, and `self.status`) can run automatically. Workspace writes and explicit memory saves are logged and allowed within the workspace. Shell/process execution, schedule creation/cancellation, external paths, network/credential access, destructive operations, package installation, daemon changes, and self-upgrade/apply require approval. Unknown capabilities are denied.

Approval is a human decision at the boundary, not a prompt instruction. A pending action pauses the run and is resumable after `kestrel approve <call-id>`; `kestrel deny <call-id>` persists the denial. The scheduler uses the same policy and pauses a scheduled job when approval is needed.

## Recovery expectations

Stop the daemon before backing up or restoring the SQLite file. Keep multiple protected backups and preserve a damaged database before replacement. Kestrel's migration checks are intended to prevent unsafe startup on malformed state; they cannot recover a backup that was never made. Never commit `.env`, local state, database files, or review artifacts.
