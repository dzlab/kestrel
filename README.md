# Kestrel

Kestrel is a single-user, local macOS/Linux task agent. It uses an OpenAI-compatible chat-completions endpoint, a bounded TypeScript/Bun kernel, explicit local tools, durable SQLite state, approval gates for risky actions, and a lease-based scheduler. Messaging and social-automation integrations are deliberately not included.

## Quick start

Kestrel requires Bun 1.4 or newer. With [mise](https://mise.jdx.dev/), the repository pins the version in `.mise.toml`:

```sh
mise install
mise exec -- bun install
cp .env.example .env
mise exec -- bun run src/cli/main.ts --help
```

`bun install` and `bun run ...` work as well when Bun is already on `PATH`. The package also exposes a `kestrel` bin entry when installed or linked.

## Model configuration

Kestrel speaks the OpenAI-compatible `POST {base-url}/chat/completions` shape. Set the base URL to the provider's API root, not the full completions path; Kestrel appends `/chat/completions` itself.

```dotenv
KESTREL_MODEL_BASE_URL=http://127.0.0.1:8000/v1
KESTREL_MODEL_API_KEY=
KESTREL_MODEL_NAME=my-model
```

`KESTREL_MODEL_API_KEY` is optional for local providers. It is read by the model adapter and is never placed in model messages, subprocess environments, audit payloads, or tool output. Do not commit `.env`; `.env.example` contains no credential.

The remaining settings are in `.env.example`. They bound model turns, tool calls, tokens, wall-clock time, per-tool time, and context bytes. Invalid numeric values fail closed at startup.

## CLI

```text
kestrel run <prompt>
kestrel approve <call-id>
kestrel deny <call-id>
kestrel history
kestrel status [task-or-run-id]
kestrel schedule list
kestrel schedule cancel <id>
kestrel tick
kestrel daemon start|status|stop
```

Run a task from the configured workspace:

```sh
mise exec -- bun run src/cli/main.ts run "Read README.md and summarize it"
```

### Recorded CLI session

The repository includes a reproducible [asciinema recording](docs/assets/kestrel-cli.cast) showing `--help` followed by a real read-and-summarize task through the local OpenAI-compatible proxy. Replay it with:

```sh
uvx --from asciinema asciinema play docs/assets/kestrel-cli.cast
```

The CLI prints durable results as JSON. If a tool crosses an approval boundary, `run` returns `blocked_on_approval` and includes the approval/call ID. `approve` and `deny` display the exact stored tool name and canonical arguments before recording the decision. Approval is tied to that call ID and argument hash; changing the arguments requires a new decision. A denied call is persisted as a failed run and is not retried automatically.

Use `history` and `status` after restarting the CLI to inspect the same SQLite-backed state. `tick` claims at most one due schedule and runs it through the same kernel and policy path as `run`. The daemon polls on a one-second interval, uses SQLite leases and fencing tokens to prevent duplicate workers, renews long jobs, retries failures with bounded backoff, and pauses jobs that need approval.

## Tools and approval boundaries

The built-in registry contains `fs.list`, `fs.read`, `fs.write`, `fs.patch`, `search.text`, `shell.exec`, `bun.run`, `memory.save`, `memory.search`, `schedule.list`, `schedule.create`, `schedule.cancel`, `self.upgrade`, `self.apply`, and `self.status`. Each built-in has a trusted identity, an explicit schema, and a policy capability.

Reads and searches are low-risk and bounded. Workspace writes are allowed and audited. Shell/process execution, network or credential access, destructive deletion, package installation, daemon changes, schedule mutations, and self-modification require explicit approval; unknown tools and paths outside the workspace are denied. A patch targeting Kestrel's own source is treated as self-modifying. Local subprocesses are approval-gated but are not a hostile-code sandbox.

## Memory

Memory is opt-in. The agent can use `memory.save` only for an explicitly supplied fact, with bounded content, tags, provenance, and a user/task namespace. `memory.search` returns bounded, untrusted records. Secrets, control characters, and common prompt-injection instructions are rejected. The kernel never silently converts ordinary assistant prose into memory.

## Self-upgrades

`self.upgrade` proposes a bounded patch and records the base Git revision, target hashes, patch hash, and an explicit verification argv. The proposal does not mutate source. `self.apply` requires the exact approval, rechecks the workspace and revision, applies through the guarded patch engine, runs the approved verification command, records output and before/after hashes, and restores the prior files if verification fails. Verification cannot invoke a shell, fetch packages, or silently change after approval.

## Persistence, backups, and recovery

The default data directory is `~/.kestrel` with private `0700` permissions. The default database is `~/.kestrel/kestrel.sqlite` with `0600` permissions. Set `KESTREL_DATA_DIR` to a private directory or `KESTREL_DB` to a file path; relative database paths remain under `KESTREL_DATA_DIR`, and CLI configuration rejects `:memory:`, directories, and symlink database files. A project-local `.kestrel-data/` is supported and ignored by Git.

Stop the daemon before making a file backup, then copy the database to a protected backup directory:

```sh
kestrel daemon stop
mkdir -p ~/.kestrel/backups
cp ~/.kestrel/kestrel.sqlite ~/.kestrel/backups/kestrel-$(date +%Y%m%d-%H%M%S).sqlite
```

To recover, stop Kestrel, preserve the damaged file for diagnosis, restore a known-good backup to the configured database path, and start the CLI/daemon again. Migrations validate schema lineage and fail closed on corruption or mismatches; they do not delete user files.

## Development

```sh
mise exec -- bun test
npm run typecheck
mise exec -- bun run diff:check
mise exec -- bun run smoke
```

GitHub Actions runs the same `check` and `smoke` commands on macOS and Linux for both Bun 1.4.0 and the latest Bun release on pull requests and pushes to `main`. Unsupported operating systems fail closed. The repository also runs actionlint, scheduled CodeQL analysis, and pull-request dependency review. CI installs the committed npm lockfile with `npm ci --ignore-scripts`; local Bun development remains supported through `bun install`.

## Secret scanning

The dedicated Gitleaks workflow checks pull-request trees and the complete reachable Git history, including merged second-parent commits. It runs with redacted output, read-only permissions, and a fail-closed result; findings appear in the failed check and workflow run under the **Actions tab**. If GitHub-native Secret Scanning is enabled by a repository administrator, its provider-aware alerts appear under the **Security tab** → **Secret scanning**. Treat any finding as compromised: revoke or rotate the credential, remove it from the current tree, and remediate history when appropriate. This project does not enable or provide push protection; see [docs/security.md](docs/security.md) for the exact API verification/enablement path and current pending status.

The public `createKestrel` factory accepts an injected `FakeModel`, so integration tests can construct the complete registry/kernel/store without network access. See [docs/architecture.md](docs/architecture.md) and [docs/security.md](docs/security.md) for the system flow and threat model.
