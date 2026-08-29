# GitHub Workflows Design

**Date:** 2026-08-29

## Goal

Add maintainable GitHub Actions automation for Kestrel so every pull request and push to `main` receives deterministic build/test validation, workflow syntax validation, static security analysis, and dependency-diff review.

## Scope

This change adds three focused workflows under `.github/workflows/`:

- `ci.yml` for Bun installation, TypeScript checks, tests, smoke checks, repository checks, and workflow linting.
- `codeql.yml` for scheduled and change-triggered CodeQL analysis of TypeScript.
- `dependency-review.yml` for pull-request dependency vulnerability review.

Release publishing, deployment, automated dependency update configuration, and external notifications are out of scope.

## Architecture

The workflows are intentionally separated by purpose and permission set. CI runs the project’s existing `check` script and smoke command, while CodeQL and dependency review produce independent security signals. All workflows use explicit read-oriented permissions by default; only CodeQL receives `security-events: write`, which is required to upload analysis results.

The CI workflow tests Bun `1.4.0` and `latest`. The pinned version matches the repository’s declared minimum and `latest` provides forward-compatibility coverage. Dependency installation must be reproducible from the repository’s committed lockfile and must not write dependency changes back to the checkout.

## Workflow behavior

### CI

`ci.yml` triggers on `pull_request`, pushes to `main`, and manual dispatch. It uses a concurrency group keyed by workflow, ref, and event so superseded pull-request runs are cancelled. The matrix runs on `ubuntu-latest` for Bun `1.4.0` and `latest` with these steps:

1. Check out the repository.
2. Install the selected Bun version.
3. Install dependencies using the committed lockfile without modifying it.
4. Run `bun run check`.
5. Run `bun run smoke`.

Workflow syntax is checked in a separate CI job with `actionlint`, so malformed workflow changes fail independently of the Bun matrix.

### CodeQL

`codeql.yml` triggers on pull requests, pushes to `main`, a weekly scheduled run, and manual dispatch. It initializes the `javascript-typescript` extractor, runs the repository’s available TypeScript build/check preparation as needed, and uploads results with the default security-and-quality query suite. Its job permissions are limited to `contents: read`, `actions: read`, and `security-events: write`.

### Dependency review

`dependency-review.yml` triggers only on pull requests and manual dispatch. It compares dependency changes introduced by the pull request and fails for newly introduced moderate-or-higher vulnerabilities. It does not grant write permissions or post comments automatically.

## Security boundaries

- Every workflow sets `permissions: contents: read` unless a narrower or additional permission is required.
- CI and dependency review do not receive repository secrets.
- Third-party actions use explicit major versions; no workflow executes repository-controlled scripts before dependency installation and the normal CI checks.
- Pull-request workflows do not run with write permissions, preventing untrusted fork code from receiving mutation privileges.

## Validation

Before completion, validate the workflow YAML structure and run the exact local equivalents of the CI commands:

```sh
bun install --frozen-lockfile
bun run check
bun run smoke
```

The final verification must also confirm that the worktree is clean except for the intended workflow and documentation changes and that all workflow files are present at the documented paths.
