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

## Secret scanning

Kestrel's [Secret Scanning workflow](../.github/workflows/secret-scanning.yml) runs on pull requests, pushes to `main`, and manual dispatches. It checks the checked-out tree and the complete reachable Git commit graph, including merged second-parent history. The workflow rejects unreviewed root `gitleaks.toml` and `.gitleaks.toml` files before the scanner starts, uses immutable action pins, and keeps `contents: read` permissions.

The workflow uses redacted Gitleaks output, disables comments and artifact uploads, and fails closed if the event-range action scan, current-tree scan, or full-history scan fails. Review Gitleaks results in the failed check and the workflow run under the repository's **Actions tab**; Gitleaks findings are CI results, not GitHub-native Secret Scanning alerts.

When GitHub-native Secret Scanning is available and enabled, provider-aware alerts appear under the repository's **Security tab** → **Secret scanning** → **Secret scanning alerts**. Native alerts and Gitleaks results are separate signals, so review both locations.

### Finding response

Treat every real finding as compromised: immediately revoke or rotate the credential with its provider, remove it from the current tree, and check logs, artifacts, and other copies. If the credential exists in Git history, remove it from history when appropriate using an approved repository procedure, then force-rotate it even after cleanup. Do not paste secret values into issues, pull requests, logs, or remediation notes. Intentional synthetic fixtures must remain obviously non-secret and must not be allowlisted without a reviewed policy change.

### GitHub-native Secret Scanning status

Repository administrators can verify the setting and the caller's repository permissions with:

```sh
gh api repos/dzlab/kestrel --jq '{admin: (.permissions.admin // false), push: (.permissions.push // false), secret_scanning: (.security_and_analysis.secret_scanning.status // "unavailable"), push_protection: (.security_and_analysis.secret_scanning_push_protection.status // "unavailable")}'
```

An administrator can enable native Secret Scanning through the GitHub REST API with this exact `gh` path and payload:

```sh
gh api --method PATCH repos/dzlab/kestrel --input - <<'JSON'
{
  "security_and_analysis": {
    "secret_scanning": {
      "status": "enabled"
    }
  }
}
JSON
```

Then rerun the verification command and confirm the returned `secret_scanning` value. Native Secret Scanning is repository state, not represented in this repository's source, so this project does not claim that it is enabled. A repository administrator with the required admin permission and GitHub Secret Protection or Advanced Security entitlement must run and verify the commands. If the setting is unavailable, the authenticated identity may lack access or the repository plan may not expose it.

Push protection is intentionally outside this change. This workflow detects findings in pull requests, `main` pushes, and full history, but it does not intercept a developer's local `git push`. Do not describe Kestrel as having push protection until an administrator separately enables and verifies `secret_scanning_push_protection`.

## Approval policy

Low-risk reads (`fs.list`, `fs.read`, `search.text`, `memory.search`, `schedule.list`, and `self.status`) can run automatically. Workspace writes and explicit memory saves are logged and allowed within the workspace. Shell/process execution, schedule creation/cancellation, external paths, network/credential access, destructive operations, package installation, daemon changes, and self-upgrade/apply require approval. Unknown capabilities are denied.

Approval is a human decision at the boundary, not a prompt instruction. A pending action pauses the run and is resumable after `kestrel approve <call-id>`; `kestrel deny <call-id>` persists the denial. The scheduler uses the same policy and pauses a scheduled job when approval is needed.

## Recovery expectations

Stop the daemon before backing up or restoring the SQLite file. Keep multiple protected backups and preserve a damaged database before replacement. Kestrel's migration checks are intended to prevent unsafe startup on malformed state; they cannot recover a backup that was never made. Never commit `.env`, local state, database files, or review artifacts.
