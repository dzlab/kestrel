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

function lineAt(indent: number, content: string): RegExp {
  return new RegExp(`^${" ".repeat(indent)}${content}[ \\t]*(?:#.*)?$`);
}

type WorkflowBlock = {
  indent: number;
  text: string;
};

function blockAtIndent(
  source: string,
  name: string,
  indent?: number,
): WorkflowBlock[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(
    `^([ ]*)${escapedName}:[ \\t]*(?:#.*)?$`,
  );
  const lines = source.split("\n");
  const starts = lines.flatMap((line, index) => {
    const match = header.exec(line);
    if (match === null || (indent !== undefined && match[1].length !== indent)) {
      return [];
    }

    return [{ index, indent: match[1].length }];
  });

  return starts.map(({ index: start, indent: blockIndent }) => {
    const end = lines.findIndex((line, index) => {
      if (index <= start || isIgnorableLine(line)) {
        return false;
      }

      return indentOf(line) <= blockIndent;
    });

    return {
      indent: blockIndent,
      text: lines
        .slice(start, end === -1 ? lines.length : end)
        .join("\n")
        .replace(/(?:\n[ \t]*)+$/, ""),
    };
  });
}

function rootIndent(source: string): number {
  const firstMeaningfulLine = source.split("\n").find((line) => !isIgnorableLine(line));
  if (firstMeaningfulLine === undefined) {
    throw new Error("Workflow is empty");
  }

  return indentOf(firstMeaningfulLine);
}

function topLevelBlocks(source: string, name: string): WorkflowBlock[] {
  return blockAtIndent(source, name, rootIndent(source));
}

function childBlocks(parent: WorkflowBlock, name: string): WorkflowBlock[] {
  const candidates = blockAtIndent(parent.text, name).filter(
    (block) => block.indent > parent.indent,
  );
  if (candidates.length === 0) {
    return [];
  }

  const childIndent = Math.min(...candidates.map((block) => block.indent));
  return candidates.filter((block) => block.indent === childIndent);
}

function namedStep(jobBlock: WorkflowBlock, name: string): string {
  const stepsBlocks = childBlocks(jobBlock, "steps");
  if (stepsBlocks.length !== 1) {
    throw new Error(
      `Expected exactly one steps block in gitleaks job; found ${stepsBlocks.length}`,
    );
  }

  const stepsBlock = stepsBlocks[0];
  const lines = stepsBlock.text.split("\n");
  const stepIndentCandidates = lines.flatMap((line) => {
    if (isIgnorableLine(line) || !/^ +-[ \t]+/.test(line)) {
      return [];
    }

    const indent = indentOf(line);
    return indent > stepsBlock.indent ? [indent] : [];
  });
  if (stepIndentCandidates.length === 0) {
    throw new Error("Expected named steps inside gitleaks steps block");
  }

  const stepIndent = Math.min(...stepIndentCandidates);
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

function gitleaksJob(source: string): WorkflowBlock {
  const jobsBlocks = topLevelBlocks(source, "jobs");
  if (jobsBlocks.length !== 1) {
    throw new Error(`Expected exactly one top-level jobs block; found ${jobsBlocks.length}`);
  }

  const gitleaksBlocks = childBlocks(jobsBlocks[0], "gitleaks");
  if (gitleaksBlocks.length !== 1) {
    throw new Error(
      `Expected exactly one gitleaks job; found ${gitleaksBlocks.length}`,
    );
  }

  return gitleaksBlocks[0];
}

test("secret scanning runs on pull requests, main pushes, and manual dispatch", () => {
  const source = workflow();
  const onBlocks = topLevelBlocks(source, "on");

  expect(onBlocks).toHaveLength(1);
  const onBlock = onBlocks[0];
  const pullRequestBlocks = childBlocks(onBlock, "pull_request");
  const pushBlocks = childBlocks(onBlock, "push");
  const workflowDispatchBlocks = childBlocks(onBlock, "workflow_dispatch");

  expect(pullRequestBlocks).toHaveLength(1);
  expect(pullRequestBlocks[0].text).toMatch(
    lineAt(pullRequestBlocks[0].indent, "pull_request:"),
  );
  expect(pushBlocks).toHaveLength(1);
  const pushBlock = pushBlocks[0];
  const branchesBlocks = childBlocks(pushBlock, "branches");
  expect(branchesBlocks).toHaveLength(1);
  const branchesBlock = branchesBlocks[0];
  const pushLines = meaningfulLines(pushBlock.text);
  expect(pushLines).toHaveLength(3);
  expect(pushLines[0]).toMatch(lineAt(pushBlock.indent, "push:"));
  expect(pushLines[1]).toMatch(lineAt(branchesBlock.indent, "branches:"));

  const branchesLines = meaningfulLines(branchesBlock.text);
  expect(branchesLines).toHaveLength(2);
  const listItemIndent = indentOf(branchesLines[1]);
  expect(branchesLines[1]).toMatch(
    lineAt(
      listItemIndent,
      `-[ \\t]+(?:main|"main"|'main')`,
    ),
  );
  expect(workflowDispatchBlocks).toHaveLength(1);
  expect(workflowDispatchBlocks[0].text).toMatch(
    lineAt(workflowDispatchBlocks[0].indent, "workflow_dispatch:"),
  );
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
  const permissionsBlocks = topLevelBlocks(source, "permissions");

  expect(permissionsBlocks).toHaveLength(1);
  const permissionsBlock = permissionsBlocks[0];
  const permissionLines = meaningfulLines(permissionsBlock.text);
  expect(permissionLines).toHaveLength(2);
  expect(permissionLines[0]).toMatch(lineAt(permissionsBlock.indent, "permissions:"));
  const permissionEntryIndent = indentOf(permissionLines[1]);
  expect(permissionEntryIndent).toBeGreaterThan(permissionsBlock.indent);
  expect(permissionLines[1]).toMatch(
    lineAt(
      permissionEntryIndent,
      `contents:[ \\t]*(?:read|"read"|'read')`,
    ),
  );
  const nestedPermissions = blockAtIndent(source, "permissions").filter(
    (block) => block.indent > permissionsBlock.indent,
  );
  expect(nestedPermissions).toHaveLength(0);
  expect(source).not.toMatch(
    /^[ \t]*(?:#[ \t]*)?[A-Za-z0-9_-]+:[ \t]*(?:write|"write"|'write')(?:[ \t]+#.*)?[ \t]*$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_COMMENTS:[ \t]*(?:false|"false"|'false')[ \t]*(?:#.*)?$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_UPLOAD_ARTIFACT:[ \t]*(?:false|"false"|'false')[ \t]*(?:#.*)?$/m,
  );
  expect(scanStep).toMatch(
    /^[ \t]+GITLEAKS_ENABLE_SUMMARY:[ \t]*(?:true|"true"|'true')[ \t]*(?:#.*)?$/m,
  );
});
