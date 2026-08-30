import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflowPath = join(import.meta.dir, "../.github/workflows/secret-scanning.yml");

function workflow(): string {
  return readFileSync(workflowPath, "utf8").replace(/\r\n?/g, "\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function meaningfulLines(block: string): string[] {
  return block.split("\n").filter((line) => !isIgnorableLine(line));
}

function blockAtIndent(source: string, name: string, indent: number): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `^${" ".repeat(indent)}${escapedName}:[ \\t]*(?:#.*)?$`,
  );
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) =>
    header.test(line) ? [index] : [],
  );

  return starts.map((start) => {
    const end = lines.findIndex((line, index) => {
      if (index <= start || isIgnorableLine(line)) {
        return false;
      }

      return indentOf(line) <= indent;
    });

    return lines
      .slice(start, end === -1 ? lines.length : end)
      .join("\n")
      .replace(/(?:\n[ \t]*)+$/, "");
  });
}

function namedStep(jobBlock: string, name: string): string {
  const lines = jobBlock.split("\n");
  const stepsHeaders = lines.flatMap((line, index) =>
    /^([ ]+)steps:[ \t]*(?:#.*)?$/.test(line) ? [index] : [],
  );

  if (stepsHeaders.length !== 1) {
    throw new Error(
      `Expected exactly one steps block in gitleaks job; found ${stepsHeaders.length}`,
    );
  }

  const stepIndent = indentOf(lines[stepsHeaders[0]]) + 2;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `^${" ".repeat(stepIndent)}- name:[ \\t]+${escapedName}[ \\t]*(?:#.*)?$`,
  );
  const starts = lines.flatMap((line, index) =>
    header.test(line) ? [index] : [],
  );

  if (starts.length !== 1) {
    throw new Error(
      `Expected exactly one named workflow step: ${name}; found ${starts.length}`,
    );
  }

  const start = starts[0];
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      !isIgnorableLine(line) &&
      indentOf(line) <= stepIndent,
  );

  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function gitleaksJob(source: string): string {
  const jobsBlocks = blockAtIndent(source, "jobs", 0);
  if (jobsBlocks.length !== 1) {
    throw new Error(`Expected exactly one top-level jobs block; found ${jobsBlocks.length}`);
  }

  const gitleaksBlocks = blockAtIndent(jobsBlocks[0], "gitleaks", 2);
  if (gitleaksBlocks.length !== 1) {
    throw new Error(
      `Expected exactly one gitleaks job; found ${gitleaksBlocks.length}`,
    );
  }

  return gitleaksBlocks[0];
}

test("secret scanning runs on pull requests, main pushes, and manual dispatch", () => {
  const source = workflow();
  const onBlocks = blockAtIndent(source, "on", 0);

  expect(onBlocks).toHaveLength(1);
  const onBlock = onBlocks[0];
  const pushBlocks = blockAtIndent(onBlock, "push", 2);

  expect(onBlock).toMatch(/^  pull_request:[ \t]*(?:#.*)?$/m);
  expect(pushBlocks).toHaveLength(1);
  const pushLines = meaningfulLines(pushBlocks[0]);
  expect(pushLines).toHaveLength(3);
  expect(pushLines[0]).toMatch(/^  push:[ \t]*(?:#.*)?$/);
  expect(pushLines[1]).toMatch(/^    branches:[ \t]*(?:#.*)?$/);
  expect(pushLines[2]).toMatch(/^      - (?:main|"main"|'main')[ \t]*(?:#.*)?$/);
  expect(onBlock).toMatch(/^  workflow_dispatch:[ \t]*(?:#.*)?$/m);
});

test("secret scanning checks complete history with a pinned Gitleaks action", () => {
  const source = workflow();
  const job = gitleaksJob(source);
  const checkoutStep = namedStep(job, "Check out repository history");
  const scanStep = namedStep(job, "Scan repository and Git history");

  expect(checkoutStep).toMatch(
    /^[ \t]+uses:[ \t]+actions\/checkout@[^\s#]+[ \t]*(?:#.*)?$/m,
  );
  expect(checkoutStep).toMatch(
    /^[ \t]+fetch-depth:[ \t]*(?:0|"0"|'0')[ \t]*(?:#.*)?$/m,
  );
  expect(checkoutStep).toMatch(
    /^[ \t]+persist-credentials:[ \t]*(?:false|"false"|'false')[ \t]*(?:#.*)?$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+uses:[ \t]+gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e[ \t]+# v3\.0\.0[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITHUB_TOKEN:[ \t]*\$\{\{[ \t]*secrets\.GITHUB_TOKEN[ \t]*\}\}[ \t]*(?:#.*)?$/m,
  );
});

test("secret scanning uses least privilege and does not publish findings", () => {
  const source = workflow();
  const scanStep = namedStep(gitleaksJob(source), "Scan repository and Git history");
  const permissionsBlocks = blockAtIndent(source, "permissions", 0);

  expect(permissionsBlocks).toHaveLength(1);
  const permissionLines = meaningfulLines(permissionsBlocks[0]);
  expect(permissionLines).toHaveLength(2);
  expect(permissionLines[0]).toMatch(/^permissions:[ \t]*(?:#.*)?$/);
  expect(permissionLines[1]).toMatch(
    /^  contents:[ \t]*(?:read|"read"|'read')[ \t]*(?:#.*)?$/,
  );
  expect(source).not.toMatch(/^[ \t]+permissions:[^\n]*$/m);
  expect(source).not.toMatch(
    /^[ \t]*(?:#[ \t]*)?[A-Za-z0-9_-]+:[ \t]*(?:write|"write"|'write')(?:[ \t]+#.*)?[ \t]*$/m,
  );
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
