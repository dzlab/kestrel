import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../.github/workflows/secret-scanning.yml");

function workflow(): string {
  return readFileSync(workflowPath, "utf8").replace(/\r\n?/g, "\n");
}

function stepBlock(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^      - name:[ \\t]+${escapedName}[ \\t]*$`);
  const lines = source.split("\n");
  const start = lines.findIndex((line) => header.test(line));

  if (start === -1) {
    throw new Error(`Missing named workflow step: ${name}`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && line !== "" && !/^ {8}/.test(line),
  );

  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function topLevelBlocks(source: string, name: string): string[] {
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) =>
    line.startsWith(`${name}:`) ? [index] : [],
  );

  return starts.map((start) => {
    const end = lines.findIndex(
      (line, index) =>
        index > start && /^[^ \t#\r\n][^:]*:/.test(line),
    );

    return lines
      .slice(start, end === -1 ? lines.length : end)
      .join("\n")
      .replace(/(?:\n[ \t]*)+$/, "");
  });
}

test("secret scanning runs on pull requests, main pushes, and manual dispatch", () => {
  const source = workflow();

  expect(source).toMatch(/^  pull_request:[ \t]*$/m);
  expect(source).toMatch(/^  push:[ \t]*\n    branches:[ \t]*\n      - main[ \t]*$/m);
  expect(source).toMatch(/^  workflow_dispatch:[ \t]*$/m);
});

test("secret scanning checks complete history with a pinned Gitleaks action", () => {
  const source = workflow();
  const checkoutStep = stepBlock(source, "Check out repository history");
  const scanStep = stepBlock(source, "Scan repository and Git history");

  expect(checkoutStep).toMatch(
    /^[ \t]+uses:[ \t]+actions\/checkout@[^\s#]+[ \t]*$/m,
  );
  expect(checkoutStep).toMatch(/^[ \t]+fetch-depth:[ \t]*0[ \t]*$/m);
  expect(checkoutStep).toMatch(
    /^[ \t]+persist-credentials:[ \t]*false[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+uses:[ \t]+gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e[ \t]+# v3\.0\.0[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITHUB_TOKEN:[ \t]*\$\{\{[ \t]*secrets\.GITHUB_TOKEN[ \t]*\}\}[ \t]*$/m,
  );
});

test("secret scanning uses least privilege and does not publish findings", () => {
  const source = workflow();
  const scanStep = stepBlock(source, "Scan repository and Git history");
  const permissionsBlocks = topLevelBlocks(source, "permissions");

  expect(permissionsBlocks).toHaveLength(1);
  expect(permissionsBlocks[0]).toBe("permissions:\n  contents: read");
  expect(source).not.toMatch(/^[ \t]*(?:#[ \t]*)?pull-requests:[ \t]+write[ \t]*$/m);
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_COMMENTS:[ \t]*(?:false|"false"|'false')[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_UPLOAD_ARTIFACT:[ \t]*(?:false|"false"|'false')[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_SUMMARY:[ \t]*(?:true|"true"|'true')[ \t]*$/m,
  );
});
