# Secret Scanning Design

**Date:** 2026-08-30

## Goal

Add layered secret detection to Kestrel so pull requests and pushes are checked by a reproducible CI gate, while GitHub provides persistent repository-level secret alerts across the repository's history.

## Scope

This change includes:

- A dedicated Gitleaks GitHub Actions workflow.
- Gitleaks scanning of the pull-request checkout and the complete Git history.
- GitHub-native Secret Scanning enabled for `dzlab/kestrel` through the repository security setting/API.
- Least-privilege workflow permissions and bounded, actionable documentation.
- Tests that validate the workflow's triggers, full-history checkout, action pinning, permissions, and scan configuration.

This change does not include push protection, automatic secret rotation, custom allowlists, or suppressions. False positives must be reviewed and documented before exclusions are added.

## Architecture

### Gitleaks CI gate

Add `.github/workflows/secret-scanning.yml` with `pull_request`, pushes to `main`, and `workflow_dispatch` triggers. The job runs on `ubuntu-latest`, checks out the repository with `fetch-depth: 0`, and invokes the official `gitleaks/gitleaks-action` using a fixed release commit. The full checkout allows Gitleaks to inspect both the current pull-request tree and all reachable Git history.

The workflow grants only `contents: read`. It supplies the read-only `GITHUB_TOKEN` required by the action, sets `GITLEAKS_ENABLE_COMMENTS=false` and `GITLEAKS_ENABLE_UPLOAD_ARTIFACT=false`, and retains a concise job summary. The workflow must not expose secret values in logs.

### GitHub-native Secret Scanning

Enable GitHub Secret Scanning for `dzlab/kestrel` through the GitHub repository security configuration. This is repository state rather than source code, so the repository workflow documents the setting and the implementation verifies the resulting API state when permissions and repository plan support it.

Native Secret Scanning remains independent of Gitleaks and is responsible for persistent alerts and provider-aware detection. Public repositories can use Secret Scanning at no additional repository configuration cost; private repository availability depends on GitHub Secret Protection or Advanced Security entitlement.

## Security behavior

- Never print, persist, or include detected secret values in workflow output, documentation, or application logs.
- Fail the Gitleaks job when a secret is detected.
- Use a pinned action commit rather than a mutable branch or floating tag.
- Keep workflow permissions read-only; no PR write token is needed for a blocking scan.
- Treat existing findings as a release/security decision: remove and rotate real credentials, and document any intentional test fixtures before adding an explicit narrow exception.
- Do not use user-controlled workflow inputs or repository content to select an alternate scanner binary, config path, or network endpoint.

## Testing and verification

Repository tests will validate the workflow text and YAML shape without embedding live credentials. Verification will include:

- Gitleaks workflow triggers pull requests, pushes to `main`, and manual dispatch.
- Checkout uses full history.
- The scanner action is pinned and runs with read-only permissions.
- No workflow setting grants PR write access or logs secret contents.
- The current repository tree passes a local Gitleaks scan when the scanner is available.
- The GitHub-native Secret Scanning API reports enabled after configuration, or the exact entitlement/permission limitation is reported without weakening the CI gate.
- Existing typecheck, test, diff, smoke, and workflow-lint checks remain green.

## Operational documentation

Update `README.md` or `docs/security.md` with:

- Where the Gitleaks workflow runs and what it scans.
- Where GitHub-native alerts appear.
- The required response: revoke/rotate exposed credentials, remove them from current code, and consider history rewriting when appropriate.
- The fact that push protection is not enabled by this change.

## Acceptance criteria

1. A dedicated Gitleaks workflow runs on pull requests, pushes to `main`, and manual dispatch.
2. The workflow scans the pull-request tree and complete Git history from a full checkout.
3. Gitleaks is pinned to an immutable release commit and fails on detected secrets.
4. Workflow permissions remain least privilege and secret values are not logged.
5. GitHub-native Secret Scanning is enabled for `dzlab/kestrel`, or a documented GitHub entitlement/permission blocker is returned.
6. Documentation explains detection, alert locations, remediation, and the push-protection boundary.
7. Existing repository checks remain passing.

## References

- [Gitleaks Action](https://github.com/gitleaks/gitleaks-action)
- [GitHub: Enabling secret scanning](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning)
