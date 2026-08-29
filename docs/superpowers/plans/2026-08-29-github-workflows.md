# GitHub Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add secure GitHub Actions workflows that validate Kestrel with Bun, lint workflow syntax, run CodeQL, and review dependency changes.

**Architecture:** Use three focused workflows under \`.github/workflows/\`. CI owns project checks and actionlint, CodeQL owns static analysis with its required upload permission, and dependency review owns pull-request dependency diffs. CI installs from the committed \`package-lock.json\` with \`npm ci --ignore-scripts\` and executes the project with Bun \`1.4.0\` and \`latest\`.

**Tech Stack:** GitHub Actions, Bun, npm, TypeScript, \`oven-sh/setup-bun@v2\`, \`github/codeql-action@v3\`, \`actions/dependency-review-action@v4\`, and actionlint.

---

### Task 1: Add CI and workflow linting

**Files:** Create \`.github/workflows/ci.yml\`.

- [ ] **Step 1: Add the CI workflow**

Create \`.github/workflows/ci.yml\`:

\`\`\`yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  checks:
    name: Checks (Bun \${{ matrix.bun-version }})
    runs-on: ubuntu-latest
    timeout-minutes: 10
    strategy:
      fail-fast: false
      matrix:
        bun-version: ['1.4.0', latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: \${{ matrix.bun-version }}
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci --ignore-scripts
      - run: bun run check
      - run: bun run smoke

  actionlint:
    name: Lint GitHub Actions workflows
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: docker://rhysd/actionlint:1.7.7
\`\`\`

- [ ] **Step 2: Validate the workflow and project checks**

Run:

\`\`\`sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml")'
npm ci --ignore-scripts
bun run check
bun run smoke
\`\`\`

Expected: YAML parsing, install, typecheck, tests, diff check, and smoke check all exit \`0\`. If Ruby interprets GitHub’s \`on\` key as a YAML 1.1 boolean, use a YAML 1.2 parser for structural validation without changing the workflow.

- [ ] **Step 3: Review and commit**

Confirm only \`contents: read\` is granted, no secrets are used, and no repository script runs before dependency installation. Run \`git diff --check\`, then commit with:

\`\`\`sh
git add .github/workflows/ci.yml
git commit -m "ci: add Bun checks and workflow linting"
\`\`\`

### Task 2: Add scheduled CodeQL analysis

**Files:** Create \`.github/workflows/codeql.yml\`.

- [ ] **Step 1: Add the CodeQL workflow**

Create \`.github/workflows/codeql.yml\`:

\`\`\`yaml
name: CodeQL

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '17 3 * * 1'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  analyze:
    name: Analyze TypeScript
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          build-mode: none
          queries: security-and-quality
      - uses: github/codeql-action/analyze@v3
        with:
          category: /language:javascript-typescript
\`\`\`

- [ ] **Step 2: Validate and commit**

Run:

\`\`\`sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/codeql.yml")'
rg -n "security-events: write|contents: read|actions: read|javascript-typescript|build-mode: none|security-and-quality" .github/workflows/codeql.yml
git diff --check
git add .github/workflows/codeql.yml
git commit -m "ci: add CodeQL analysis"
\`\`\`

Expected: YAML parses, the required CodeQL settings are present, and only the CodeQL job has \`security-events: write\`.

### Task 3: Add dependency review

**Files:** Create \`.github/workflows/dependency-review.yml\`.

- [ ] **Step 1: Add the dependency review workflow**

Create \`.github/workflows/dependency-review.yml\`:

\`\`\`yaml
name: Dependency Review

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  dependency-review:
    name: Review dependency changes
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: moderate
          base-ref: \${{ github.event.pull_request.base.sha || github.event.repository.default_branch }}
          head-ref: \${{ github.event.pull_request.head.sha || github.sha }}
\`\`\`

- [ ] **Step 2: Validate and commit**

Run:

\`\`\`sh
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/dependency-review.yml")'
rg -n "pull_request|workflow_dispatch|contents: read|fail-on-severity: moderate|base-ref|head-ref" .github/workflows/dependency-review.yml
git diff --check
git add .github/workflows/dependency-review.yml
git commit -m "ci: add dependency review"
\`\`\`

Expected: YAML parses, the moderate threshold and ref inputs are present, and the workflow has no write permissions.

### Task 4: Document and verify the workflow contract

**Files:** Modify \`README.md\` in the \`Development\` section.

- [ ] **Step 1: Document the automated checks**

Add this paragraph after the existing development commands:

\`\`\`markdown
GitHub Actions runs the same \`check\` and \`smoke\` commands on pull requests and pushes to \`main\` under Bun 1.4.0 and the latest Bun release. The repository also runs actionlint, scheduled CodeQL analysis, and pull-request dependency review. CI installs the committed npm lockfile with \`npm ci --ignore-scripts\`; local Bun development remains supported through \`bun install\`.
\`\`\`

- [ ] **Step 2: Run complete verification**

Run:

\`\`\`sh
for workflow in .github/workflows/*.yml; do ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$workflow"; done
npm ci --ignore-scripts
bun run check
bun run smoke
git diff --check
rg --files .github/workflows
rg -n "contents: read|security-events: write|bun-version|actionlint|CodeQL|fail-on-severity" .github/workflows
\`\`\`

Expected: all commands exit \`0\`; all three workflow files exist; only CodeQL grants \`security-events: write\`; CI covers Bun \`1.4.0\` and \`latest\`; and the expected security checks are visible.

- [ ] **Step 3: Commit documentation and inspect the final change set**

Run:

\`\`\`sh
git add README.md
git commit -m "docs: document GitHub Actions checks"
git status --short
git log -n 4 --oneline
\`\`\`

Expected: the documentation commit contains only \`README.md\`, the worktree is clean, and the four implementation commits are visible. If verification required a correction, rerun the affected check and create a focused follow-up commit.

