import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../.github/workflows/secret-scanning.yml");

function workflow(): string {
  return readFileSync(workflowPath, "utf8");
}

test("secret scanning runs on pull requests, main pushes, and manual dispatch", () => {
  const source = workflow();

  expect(source).toMatch(/^  pull_request:[ \t]*$/m);
  expect(source).toMatch(/^  push:[ \t]*\n    branches:[ \t]*\n      - main[ \t]*$/m);
  expect(source).toMatch(/^  workflow_dispatch:[ \t]*$/m);
});

test("secret scanning checks complete history with a pinned Gitleaks action", () => {
  const source = workflow();

  expect(source).toMatch(/^[ \t]+fetch-depth:[ \t]*0[ \t]*$/m);
  expect(source).toMatch(
    /^[ \t]*-[ \t]+uses:[ \t]+gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e[ \t]+# v3\.0\.0[ \t]*$/m,
  );
  expect(source).toMatch(
    /^[ \t]+GITHUB_TOKEN:[ \t]*\$\{\{[ \t]*secrets\.GITHUB_TOKEN[ \t]*\}\}[ \t]*$/m,
  );
});

test("secret scanning uses least privilege and does not publish findings", () => {
  const source = workflow();

  expect(source).toMatch(
    /^permissions:[ \t]*\n  contents:[ \t]*read[ \t]*(?:\n(?:[ \t]*\n)*(?=[^ \t#\r\n])|(?![\s\S]))/m,
  );
  expect(source).not.toMatch(/^[ \t]*pull-requests:[ \t]+write[ \t]*$/m);
  expect(source).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_COMMENTS:[ \t]*(?:false|"false"|'false')[ \t]*$/m,
  );
  expect(source).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_UPLOAD_ARTIFACT:[ \t]*(?:false|"false"|'false')[ \t]*$/m,
  );
  expect(source).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_SUMMARY:[ \t]*(?:true|"true"|'true')[ \t]*$/m,
  );
});
