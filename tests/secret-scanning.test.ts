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
