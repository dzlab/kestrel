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
  return new RegExp(`^${" ".repeat(indent)}${content}[ \\t]*(?:#.*)?$`, "m");
}

function yamlKey(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${escapedName}|'${escapedName}'|"${escapedName}")`;
}

function declaredKeys(source: string, name: string): WorkflowBlock[] {
  const declaration = new RegExp(`^([ ]*)${yamlKey(name)}:`);

  return source.split("\n").flatMap((line) => {
    const match = declaration.exec(line);
    return match === null
      ? []
      : [{ indent: match[1].length, text: line }];
  });
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
  const header = new RegExp(
    `^([ ]*)${yamlKey(name)}:[ \\t]*(?:#.*)?$`,
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

function directChildIndent(parent: WorkflowBlock): number {
  const indents = meaningfulLines(parent.text)
    .map((line) => indentOf(line))
    .filter((indent) => indent > parent.indent);
  if (indents.length === 0) {
    throw new Error("Expected a child mapping");
  }

  return Math.min(...indents);
}

function directChildKeys(parent: WorkflowBlock): string[] {
  const childIndent = directChildIndent(parent);
  const keyPattern = new RegExp(
    `^${" ".repeat(childIndent)}((?:[A-Za-z0-9_-]+|'[^']*'|"[^"]*")):[^\\n]*$`,
  );

  return meaningfulLines(parent.text).flatMap((line) => {
    const match = keyPattern.exec(line);
    if (match === null) {
      return [];
    }

    const key = match[1];
    return [key.startsWith("'") || key.startsWith('"') ? key.slice(1, -1) : key];
  });
}

function namedChildMapping(step: WorkflowBlock, name: string): WorkflowBlock {
  const childIndent = directChildIndent(step);
  const mappings = blockAtIndent(step.text, name, childIndent);
  if (mappings.length !== 1) {
    throw new Error(
      `Expected exactly one ${name} mapping in named step; found ${mappings.length}`,
    );
  }

  return mappings[0];
}

function namedStep(jobBlock: WorkflowBlock, name: string): WorkflowBlock {
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

  return {
    indent: stepIndent,
    text: lines.slice(start, end === -1 ? lines.length : end).join("\n"),
  };
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

  const concurrencyBlocks = topLevelBlocks(source, "concurrency");
  expect(concurrencyBlocks).toHaveLength(1);
  if (concurrencyBlocks.length !== 1) {
    return;
  }

  const concurrencyBlock = concurrencyBlocks[0];
  const concurrencyChildIndent = directChildIndent(concurrencyBlock);
  expect(directChildKeys(concurrencyBlock)).toEqual([
    "group",
    "cancel-in-progress",
  ]);
  expect(concurrencyBlock.text).toMatch(
    lineAt(concurrencyChildIndent, `group:[ \\t]+.+`),
  );
  expect(concurrencyBlock.text).toMatch(
    lineAt(
      concurrencyChildIndent,
      `cancel-in-progress:[ \\t]*(?:true|"true"|'true')`,
    ),
  );
});

test("secret scanning checks complete history with a pinned Gitleaks action", () => {
  const source = workflow();
  const jobsBlocks = topLevelBlocks(source, "jobs");
  expect(jobsBlocks).toHaveLength(1);
  if (jobsBlocks.length !== 1) {
    return;
  }

  expect(directChildKeys(jobsBlocks[0])).toEqual(["gitleaks"]);
  const job = gitleaksJob(source);
  const checkoutStep = namedStep(job, "Check out repository history");
  const scanStep = namedStep(job, "Scan repository and Git history");
  const checkoutWith = namedChildMapping(checkoutStep, "with");
  const scanEnv = namedChildMapping(scanStep, "env");
  const checkoutChildIndent = directChildIndent(checkoutStep);
  const checkoutWithChildIndent = directChildIndent(checkoutWith);
  const scanChildIndent = directChildIndent(scanStep);
  const scanEnvChildIndent = directChildIndent(scanEnv);

  expect(job.text).toMatch(
    lineAt(
      directChildIndent(job),
      `runs-on:[ \\t]*(?:ubuntu-latest|"ubuntu-latest"|'ubuntu-latest')`,
    ),
  );
  expect(checkoutStep.text).toMatch(
    lineAt(checkoutChildIndent, `uses:[ \\t]+actions\\/checkout@[^\\s#]+`),
  );
  expect(checkoutWith.text).toMatch(
    lineAt(
      checkoutWithChildIndent,
      `fetch-depth:[ \\t]*(?:0|"0"|'0')`,
    ),
  );
  expect(checkoutWith.text).toMatch(
    lineAt(
      checkoutWithChildIndent,
      `persist-credentials:[ \\t]*(?:false|"false"|'false')`,
    ),
  );
  expect(scanStep.text).toMatch(
    lineAt(
      scanChildIndent,
      `uses:[ \\t]+gitleaks\\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e[ \\t]+# v3\\.0\\.0`,
    ),
  );
  expect(scanEnv.text).toMatch(
    lineAt(
      scanEnvChildIndent,
      `GITHUB_TOKEN:[ \\t]*\\$\\{\\{[ \\t]*secrets\\.GITHUB_TOKEN[ \\t]*\\}\\}`,
    ),
  );
  expect(declaredKeys(scanStep.text, "with")).toHaveLength(0);
  for (const key of [
    "GITLEAKS_CONFIG",
    "GITLEAKS_VERSION",
    "GITLEAKS_LICENSE",
  ]) {
    expect(declaredKeys(scanStep.text, key)).toHaveLength(0);
  }
  const onBlock = topLevelBlocks(source, "on")[0];
  const workflowDispatchBlock = childBlocks(onBlock, "workflow_dispatch")[0];
  expect(declaredKeys(workflowDispatchBlock.text, "inputs")).toHaveLength(0);
});

test("secret scanning uses least privilege and does not publish findings", () => {
  const source = workflow();
  const scanStep = namedStep(gitleaksJob(source), "Scan repository and Git history");
  const scanEnv = namedChildMapping(scanStep, "env");
  const scanEnvChildIndent = directChildIndent(scanEnv);
  const permissionsBlocks = topLevelBlocks(source, "permissions");

  expect(permissionsBlocks).toHaveLength(1);
  if (permissionsBlocks.length !== 1) {
    return;
  }

  const permissionsBlock = permissionsBlocks[0];
  const permissionLines = meaningfulLines(permissionsBlock.text);
  const permissionDeclarations = declaredKeys(source, "permissions");
  const topLevelPermissionDeclarations = permissionDeclarations.filter(
    (declaration) => declaration.indent === permissionsBlock.indent,
  );
  expect(permissionLines).toHaveLength(2);
  expect(topLevelPermissionDeclarations).toHaveLength(1);
  expect(permissionLines[0]).toMatch(
    lineAt(permissionsBlock.indent, `${yamlKey("permissions")}:`),
  );
  const permissionEntryIndent = indentOf(permissionLines[1]);
  expect(permissionEntryIndent).toBeGreaterThan(permissionsBlock.indent);
  expect(permissionLines[1]).toMatch(
    lineAt(
      permissionEntryIndent,
      `contents:[ \\t]*(?:read|"read"|'read')`,
    ),
  );
  const nestedPermissions = permissionDeclarations.filter(
    (block) => block.indent > permissionsBlock.indent,
  );
  expect(nestedPermissions).toHaveLength(0);
  expect(source).not.toMatch(
    /^[ \t]*(?:#[ \t]*)?(?:permissions|'permissions'|"permissions"):[^\n]*\bwrite\b[^\n]*$/m,
  );
  expect(source).not.toMatch(
    /^[ \t]*(?:#[ \t]*)?[A-Za-z0-9_-]+:[ \t]*(?:write|"write"|'write')(?:[ \t]+#.*)?[ \t]*$/m,
  );
  expect(scanEnv.text).toMatch(
    lineAt(
      scanEnvChildIndent,
      `GITLEAKS_ENABLE_COMMENTS:[ \\t]*(?:false|"false"|'false')`,
    ),
  );
  expect(scanEnv.text).toMatch(
    lineAt(
      scanEnvChildIndent,
      `GITLEAKS_ENABLE_UPLOAD_ARTIFACT:[ \\t]*(?:false|"false"|'false')`,
    ),
  );
  expect(scanEnv.text).toMatch(
    lineAt(
      scanEnvChildIndent,
      `GITLEAKS_ENABLE_SUMMARY:[ \\t]*(?:true|"true"|'true')`,
    ),
  );
});
