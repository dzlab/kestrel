# Secret Scanning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a least-privilege Gitleaks CI gate that scans pull-request trees and complete Git history, enable GitHub-native Secret Scanning for `dzlab/kestrel`, and document remediation.

**Architecture:** Keep secret detection in a dedicated Ubuntu workflow. A full-history checkout feeds the official Gitleaks Action pinned to its v3.0.0 release commit for the event-range gate, followed by explicit redacted current-tree and `--all` full-graph history scans. The action result and both direct scan results are aggregated fail-closed; comments and artifact uploads are disabled so the job needs only read access. The checkout action is pinned to its immutable v6.1.0 commit. Root `gitleaks.toml` and `.gitleaks.toml` files are rejected until a reviewed configuration policy exists. GitHub-native Secret Scanning is enabled separately through the repository security API and verified after the workflow is committed.

**Tech Stack:** GitHub Actions YAML, Gitleaks Action v3.0.0, GitHub REST API via `gh`, Bun tests, TypeScript repository tooling.

---

## File map

- Create `.github/workflows/secret-scanning.yml`: the pull-request, main-branch, and manual Gitleaks workflow with explicit tree/full-graph scans and fail-closed aggregation.
- Create `tests/secret-scanning.test.ts`: deterministic assertions for workflow triggers, immutable action references, full-history checkout, direct scan commands, permissions, safe output settings, and a temporary merged second-parent history fixture.
- Modify `docs/security.md`: operational guidance for CI findings, native alerts, credential rotation, and the explicit push-protection boundary.
- Modify `README.md`: point contributors to the secret-scanning workflow and GitHub Security tab.
- Create `docs/superpowers/specs/2026-08-30-secret-scanning-design.md`: approved design, already completed before this plan.
- Create `docs/superpowers/plans/2026-08-30-secret-scanning.md`: this implementation plan.

The GitHub-native setting is external repository state and does not have a source file. Verify it with the `gh api` commands in Task 4 and report any entitlement or permission failure without weakening the Gitleaks gate.

### Task 1: Write failing workflow contract tests

**Files:**

- Create: `tests/secret-scanning.test.ts`

- [ ] **Step 1: Add tests that describe the required workflow.**

Create a test that reads `.github/workflows/secret-scanning.yml` and asserts all required controls. Use plain text assertions so the test does not add a YAML dependency or parse untrusted expressions as JavaScript.

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../.github/workflows/secret-scanning.yml");

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

test("secret scanning runs on pull requests, main pushes, and manual dispatch", () => {
  const source = workflow();

  expect(source).toMatch(/pull_request:\s*\n/);
  expect(source).toMatch(/push:\s*\n\s+branches:\s*\n\s+[-] main/);
  expect(source).toMatch(/workflow_dispatch:/);
});

test("secret scanning checks complete history with a pinned Gitleaks action", () => {
  const source = workflow();

  expect(source).toMatch(/fetch-depth:\s*0/);
  expect(source).toMatch(
    /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e\s+# v3\.0\.0/,
  );
  expect(source).toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test("secret scanning uses least privilege and does not publish findings", () => {
  const source = workflow();

  expect(source).toMatch(/permissions:\s*\n\s+contents:\s*read/);
  expect(source).not.toMatch(/pull-requests:\s*write/);
  expect(source).toMatch(/GITLEAKS_ENABLE_COMMENTS:\s*["']?false["']?/);
  expect(source).toMatch(/GITLEAKS_ENABLE_UPLOAD_ARTIFACT:\s*["']?false["']?/);
  expect(source).toMatch(/GITLEAKS_ENABLE_SUMMARY:\s*["']?true["']?/);
});
```

- [ ] **Step 2: Run the new tests and verify the failure is meaningful.**

Run:

```sh
mise exec -- bun test tests/secret-scanning.test.ts
```

Expected: the tests fail because `.github/workflows/secret-scanning.yml` does not yet exist. Do not create the workflow before observing this failure.

- [ ] **Step 3: Commit the failing contract tests.**

```sh
git add tests/secret-scanning.test.ts
git commit -m "test: specify secret scanning workflow contract"
```

### Task 2: Add the Gitleaks workflow

**Files:**

- Create: `.github/workflows/secret-scanning.yml`
- Test: `tests/secret-scanning.test.ts`

- [ ] **Step 1: Add the minimal workflow that satisfies the contract.**

Use the workflow with `fetch-depth: 0` and the immutable checkout pin `d23441a48e516b6c34aea4fa41551a30e30af803` (v6.1.0). Keep the Gitleaks v3.0.0 action pin for the event-range scan, allow that step to continue only so explicit diagnostics can run, and aggregate its result with `gitleaks dir --redact --exit-code=2 .` and `gitleaks git --redact --exit-code=2 --log-opts='--all'`. Reject root `gitleaks.toml` and `.gitleaks.toml` files before scanning.

```yaml
name: Secret Scanning

on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  gitleaks:
    name: Gitleaks
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Check out repository history
        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Scan repository and Git history
        id: event-range
        continue-on-error: true
        uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_ENABLE_COMMENTS: "false"
          GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false"
          GITLEAKS_ENABLE_SUMMARY: "true"
      - name: Run explicit tree and full-history scans
        if: ${{ always() }}
        shell: bash
        run: |
          for config in gitleaks.toml .gitleaks.toml; do
            if [ -e "$config" ]; then
              echo "Refusing to scan with an unreviewed root Gitleaks configuration: $config"
              exit 1
            fi
          done

          tree_status=0
          history_status=0
          gitleaks dir --redact --exit-code=2 . || tree_status=$?
          gitleaks git --redact --exit-code=2 --log-opts='--all' || history_status=$?

          if [ "$tree_status" -ne 0 ] || [ "$history_status" -ne 0 ] || [ "${{ steps.event-range.outcome }}" != "success" ]; then
            echo "Secret scanning failed; review the redacted findings and rotate any exposed credentials."
            exit 1
          fi
```

- [ ] **Step 2: Run the contract tests and inspect the workflow.**

Run:

```sh
mise exec -- bun test tests/secret-scanning.test.ts
```

Expected: all workflow contract tests pass. Also inspect the file to confirm no secret value, custom token, mutable Gitleaks branch, PR write permission, or user-controlled scanner input is present.

- [ ] **Step 3: Run workflow linting where available.**

Run:

```sh
if command -v actionlint >/dev/null 2>&1; then actionlint .github/workflows/secret-scanning.yml; else echo "actionlint unavailable locally"; fi
```

Expected: actionlint passes, or the command reports that it is unavailable without treating that absence as a workflow failure. GitHub's existing actionlint workflow remains the authoritative remote YAML check.

- [ ] **Step 4: Commit the workflow.**

```sh
git add .github/workflows/secret-scanning.yml tests/secret-scanning.test.ts
git commit -m "ci: add full-history Gitleaks scanning"
```

### Task 3: Document detection and remediation

**Files:**

- Modify: `docs/security.md`
- Modify: `README.md`
- Test: `tests/secret-scanning.test.ts`

- [ ] **Step 1: Extend the test with documentation assertions.**

Append a test that reads both documentation files and requires the operational guidance:

```ts
test("security documentation explains alerts and remediation", () => {
  const security = readFileSync(join(import.meta.dir, "../docs/security.md"), "utf8");
  const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
  const documentation = `${security}\n${readme}`;

  expect(documentation).toContain("Gitleaks");
  expect(documentation).toMatch(/Secret Scanning|secret scanning/);
  expect(documentation).toMatch(/Security tab|security tab/);
  expect(documentation).toMatch(/revoke|rotate/i);
  expect(documentation).toMatch(/push protection/i);
});
```

Run:

```sh
mise exec -- bun test tests/secret-scanning.test.ts
```

Expected: this new test fails because the operational documentation has not yet been added.

- [ ] **Step 2: Add the security-model guidance.**

Add a `## Secret scanning` section to `docs/security.md` stating that pull requests and pushes to `main` run the full-history Gitleaks workflow, GitHub-native alerts appear in the repository Security tab, and findings require immediate credential revocation/rotation, removal from current files, and history remediation where appropriate. State explicitly that push protection is not enabled by this change.

- [ ] **Step 3: Add a concise README pointer.**

Add a paragraph in the development/security area of `README.md` directing contributors to the Gitleaks workflow and the GitHub Security tab, with the same rotate/revoke response and push-protection boundary. Do not include example credentials or scanner suppressions.

- [ ] **Step 4: Run documentation tests and commit.**

```sh
mise exec -- bun test tests/secret-scanning.test.ts
git add docs/security.md README.md tests/secret-scanning.test.ts
git commit -m "docs: explain secret scanning response"
```

Expected: all secret-scanning tests pass before the commit.

### Task 4: Enable and verify GitHub-native Secret Scanning

**Files:**

- External setting: GitHub repository `dzlab/kestrel`

- [ ] **Step 1: Confirm the repository identity and current setting.**

Run:

```sh
gh repo view dzlab/kestrel --json nameWithOwner,isPrivate,url
gh api repos/dzlab/kestrel --jq '.security_and_analysis.secret_scanning.status // "not-enabled-or-unavailable"'
```

Expected: the repository identity is `dzlab/kestrel`. Record whether native Secret Scanning is already enabled, disabled, or unavailable to the current token.

- [ ] **Step 2: Enable native Secret Scanning without enabling push protection.**

Run:

```sh
gh api --method PATCH repos/dzlab/kestrel \
  --field 'security_and_analysis={"secret_scanning":{"status":"enabled"}}' \
  --jq '.security_and_analysis.secret_scanning.status'
```

Expected: the response is `enabled`. If GitHub returns an entitlement or permission error, preserve the Gitleaks workflow, report the exact bounded error, and do not attempt a weaker or unrelated setting.

- [ ] **Step 3: Verify native status and push-protection boundary.**

Run:

```sh
gh api repos/dzlab/kestrel --jq '{secret_scanning: .security_and_analysis.secret_scanning.status, push_protection: (.security_and_analysis.secret_scanning_push_protection.status // "not-changed")}'
```

Expected: `secret_scanning` is `enabled`; push protection is not changed by this task.

- [ ] **Step 4: Record the external-setting result.**

Include the status and any plan/permission limitation in the final implementation report. Do not persist API tokens, alert payloads, or secret values in the repository.

### Task 5: Full verification and review

**Files:**

- Verify: `.github/workflows/secret-scanning.yml`, `tests/secret-scanning.test.ts`, `README.md`, `docs/security.md`

- [ ] **Step 1: Run the complete local checks.**

```sh
mise exec -- bun run check
mise exec -- bun run smoke
git diff --check
git status --short
```

Expected: typecheck, all tests, diff check, and smoke pass; the working tree is clean after committing.

- [ ] **Step 2: Run a local full-history Gitleaks scan when installed.**

```sh
if command -v gitleaks >/dev/null 2>&1; then gitleaks git --redact --verbose; else echo "gitleaks unavailable locally; GitHub workflow will run the scan"; fi
```

Expected: no findings, or a bounded list of findings that must be resolved before completion. Never paste detected secret values into the report.

- [ ] **Step 3: Perform the final static security checks.**

```sh
! rg -n "GITLEAKS_LICENSE|pull-requests:\\s*write|GITLEAKS_ENABLE_COMMENTS:\\s*[\"']?true" .github/workflows/secret-scanning.yml
rg -n 'fetch-depth:\s*0|gitleaks/gitleaks-action@[0-9a-f]{40}' .github/workflows/secret-scanning.yml
```

Expected: the first command finds no insecure settings; the second confirms full history and an immutable Gitleaks action reference.

- [ ] **Step 4: Request a code review of the complete change.**

Review the diff against `docs/superpowers/specs/2026-08-30-secret-scanning-design.md`. Confirm that the workflow is least privilege, the scanner scans the current tree and history, documentation does not contain credentials, and native Secret Scanning status was verified. Resolve all blockers and majors before completion.

- [ ] **Step 5: Commit any review corrections and summarize the result.**

```sh
git status --short
git log -6 --oneline --decorate
```

Expected: clean `main`, documented commits, local checks passing, and a final report that distinguishes repository-file changes from the external GitHub security setting.
