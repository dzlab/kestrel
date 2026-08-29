import {
  lstatSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolExecutionError, ValidationError } from "../errors";
import type { Tool } from "./types";
import { MAX_TOOL_OUTPUT_BYTES } from "./types";
import type { ToolContext, ToolResult } from "./types";
import {
  closeSecureFile,
  closeSecureParent,
  createPatchTemp,
  openPatchTarget,
  openSecureParent,
  readWorkspaceText,
  renameAt,
  safeDirectoryEntries,
  unlinkAt,
  workspacePathInfo,
  writeWorkspaceText,
} from "./secure-fs";

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") {
    throw new ValidationError(`${name} must be a string`);
  }
  return value;
}

function isWithin(workspace: string, candidate: string): boolean {
  const remainder = relative(workspace, candidate);
  return remainder.length === 0 || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
}

function hasTraversalSegment(requested: string): boolean {
  return requested.split(/[\\/]+/u).some((segment) => segment === "..");
}

function nearestExistingRealpath(candidate: string): { path: string; missing: string[] } {
  const missing: string[] = [];
  let current = candidate;
  while (true) {
    try {
      return { path: realpathSync(current), missing };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      try {
        const entry = lstatSync(current);
        if (entry.isSymbolicLink()) {
          throw new ValidationError("path contains a dangling symlink");
        }
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
          throw lstatError;
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new ValidationError("workspace path has no existing ancestor");
      }
      missing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

function checkNoSymlinkComponents(workspace: string, candidate: string): void {
  const remainder = relative(workspace, candidate);
  if (remainder.length === 0) return;
  if (remainder.startsWith(`..${sep}`) || remainder === ".." || isAbsolute(remainder)) {
    throw new ValidationError("path resolves outside workspace");
  }

  let current = workspace;
  for (const component of remainder.split(sep)) {
    current = join(current, component);
    try {
      const entry = lstatSync(current);
      if (entry.isSymbolicLink()) throw new ValidationError("workspace path contains a symlink");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (error instanceof ValidationError || (code !== "ENOENT" && code !== "ENOTDIR")) throw error;
      break;
    }
  }
}

export function resolveWorkspacePath(workspace: string, requested: string): string {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new ValidationError("workspace must be a non-empty path");
  }
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    throw new ValidationError("requested path must be a non-empty string");
  }
  if (hasTraversalSegment(requested)) {
    throw new ValidationError("path traversal is not allowed");
  }

  let workspaceRealpath: string;
  try {
    workspaceRealpath = realpathSync(workspace);
  } catch (error) {
    throw new ValidationError("workspace does not exist", { cause: error });
  }

  const lexical = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRealpath, requested);
  checkNoSymlinkComponents(workspaceRealpath, lexical);
  let canonical: string;
  try {
    const existing = nearestExistingRealpath(lexical);
    canonical = resolve(existing.path, ...existing.missing);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError("could not resolve workspace path", { cause: error });
  }
  if (!isWithin(workspaceRealpath, canonical)) {
    throw new ValidationError("path resolves outside workspace");
  }
  checkNoSymlinkComponents(workspaceRealpath, canonical);
  return canonical;
}

function relativePath(workspace: string, filePath: string): string {
  return relative(realpathSync(workspace), filePath).split(sep).join("/") || ".";
}

function result(content: string, data?: unknown): ToolResult {
  return { ok: true, content, ...(data === undefined ? {} : { data }) };
}

async function readWorkspaceTextForPatch(workspace: string, path: string): Promise<string> {
  const read = readWorkspaceText(workspace, path);
  if (read.truncated) throw new ToolExecutionError("patch target exceeds the bounded read limit");
  return read.content;
}

function fileDefinition(name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool["definition"] {
  return {
    name,
    description,
    capability: "filesystem",
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

const listTool: Tool = {
  definition: fileDefinition("fs.list", "List entries in a workspace directory.", { path: { type: "string" } }, ["path"]),
  async execute(args, context) {
    const path = resolveWorkspacePath(context.workspace, stringArgument(args, "path"));
    const entries = safeDirectoryEntries(context.workspace, path)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.type,
      }));
    const bounded: typeof entries = [];
    const serializedItems: string[] = [];
    let serializedBytes = 2;
    for (const entry of entries) {
      const serialized = JSON.stringify(entry);
      const nextBytes = serializedBytes + (serializedItems.length === 0 ? 0 : 1) + Buffer.byteLength(serialized, "utf8");
      if (nextBytes > MAX_TOOL_OUTPUT_BYTES) break;
      bounded.push(entry);
      serializedItems.push(serialized);
      serializedBytes = nextBytes;
    }
    return result(`[${serializedItems.join(",")}]`, bounded);
  },
};

const readTool: Tool = {
  definition: fileDefinition("fs.read", "Read bounded UTF-8 text from a workspace file.", { path: { type: "string" } }, ["path"]),
  async execute(args, context) {
    const path = resolveWorkspacePath(context.workspace, stringArgument(args, "path"));
    const read = readWorkspaceText(context.workspace, path);
    return result(read.content, { path: relativePath(context.workspace, path), truncated: read.truncated });
  },
};

const writeTool: Tool = {
  definition: fileDefinition(
    "fs.write",
    "Write UTF-8 text to a workspace file.",
    { path: { type: "string" }, content: { type: "string" } },
    ["path", "content"],
  ),
  async execute(args, context) {
    const requested = stringArgument(args, "path");
    const content = stringArgument(args, "content");
    const path = resolveWorkspacePath(context.workspace, requested);
    writeWorkspaceText(context.workspace, path, content);
    const finalPath = path;
    return result(`wrote ${relativePath(context.workspace, finalPath)}`, {
      path: relativePath(context.workspace, finalPath),
      bytes: Buffer.byteLength(content, "utf8"),
    });
  },
};

type HunkLine = { marker: " " | "+" | "-"; text: string; noNewline: boolean };
type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: HunkLine[] };
type FilePatch = { oldPath: string | null; newPath: string | null; hunks: Hunk[] };
type DirectoryOpenFailure = Error & { created?: string[] };

function patchPath(value: string): string | null {
  const token = value.slice(4).split("\t", 1)[0];
  if (token === "/dev/null") {
    return null;
  }
  if (token.startsWith("a/" ) || token.startsWith("b/")) {
    return token.slice(2);
  }
  return token;
}

function isFileHeaderAt(lines: string[], index: number): boolean {
  return lines[index]?.startsWith("--- ") === true && lines[index + 1]?.startsWith("+++ ") === true;
}

function parsePatch(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index += 1;
      continue;
    }
    if (!isFileHeaderAt(lines, index)) {
      throw new ValidationError("unified patch is missing its target header");
    }
    const oldPath = patchPath(lines[index]);
    index += 1;
    const newPath = patchPath(lines[index]);
    index += 1;
    const hunks: Hunk[] = [];
    while (index < lines.length && !isFileHeaderAt(lines, index)) {
      if (lines[index] === "") {
        index += 1;
        continue;
      }
      const header = lines[index];
      if (!header.startsWith("@@ ")) throw new ValidationError("unexpected unified patch line");
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
      if (match === null) {
        throw new ValidationError("invalid unified patch hunk header");
      }
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const newStart = Number(match[3]);
      if (
        !Number.isSafeInteger(oldStart) ||
        !Number.isSafeInteger(oldCount) ||
        !Number.isSafeInteger(newStart) ||
        !Number.isSafeInteger(newCount) ||
        (oldStart === 0 && oldCount !== 0) ||
        (newStart === 0 && newCount !== 0)
      ) {
        throw new ValidationError("unified patch hunk range is invalid");
      }
      index += 1;
      const hunkLines: HunkLine[] = [];
      let consumedOld = 0;
      let producedNew = 0;
      while (consumedOld < oldCount || producedNew < newCount) {
        if (index >= lines.length) throw new ValidationError("unified patch hunk line counts do not match");
        const line = lines[index];
        if (line === "\\ No newline at end of file") {
          const previous = hunkLines.at(-1);
          if (previous === undefined || previous.noNewline) {
            throw new ValidationError("invalid unified patch newline marker");
          }
          previous.noNewline = true;
          index += 1;
          continue;
        }
        const marker = line[0];
        if (marker !== " " && marker !== "+" && marker !== "-") {
          throw new ValidationError("invalid unified patch line");
        }
        hunkLines.push({ marker, text: line.slice(1), noNewline: false });
        if (marker === "+") producedNew += 1;
        else {
          consumedOld += 1;
          if (marker === " ") producedNew += 1;
        }
        index += 1;
      }
      if (lines[index] === "\\ No newline at end of file") {
        const previous = hunkLines.at(-1);
        if (previous === undefined || previous.noNewline) {
          throw new ValidationError("invalid unified patch newline marker");
        }
        previous.noNewline = true;
        index += 1;
      }
      if (consumedOld !== oldCount || producedNew !== newCount) {
        throw new ValidationError("unified patch hunk line counts do not match");
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
    }
    if (oldPath === null && newPath === null) {
      throw new ValidationError("patch must target a file");
    }
    if (hunks.length === 0 && oldPath !== null && newPath !== null) {
      throw new ValidationError("patch file has no hunks");
    }
    if (hunks.length === 0 && newPath === null) {
      throw new ValidationError("deletion patch has no hunks");
    }
    files.push({ oldPath, newPath, hunks });
  }
  if (files.length === 0) {
    throw new ValidationError("patch contains no file headers");
  }
  return files;
}

function applyHunks(original: string, hunks: Hunk[]): string {
  const hadTrailingNewline = original.endsWith("\n");
  const oldTextLines = original.length === 0 ? [] : original.split("\n");
  if (hadTrailingNewline) oldTextLines.pop();
  const oldLines = oldTextLines.map((text, index) => ({
    text,
    newline: index < oldTextLines.length - 1 || hadTrailingNewline,
  }));
  const output: Array<{ text: string; newline: boolean }> = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    const newStart = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    if (start < cursor || start > oldLines.length) {
      throw new ValidationError("patch hunk is out of order");
    }
    output.push(...oldLines.slice(cursor, start));
    if (newStart !== output.length) throw new ValidationError("patch hunk is out of order");
    cursor = start;
    for (const line of hunk.lines) {
      if (line.marker === " ") {
        const source = oldLines[cursor];
        if (source?.text !== line.text) throw new ValidationError("patch context does not match file");
        if (source.newline !== !line.noNewline) {
          throw new ValidationError("patch source newline marker does not match file");
        }
        output.push({ text: source.text, newline: source.newline });
        cursor += 1;
      } else if (line.marker === "-") {
        const source = oldLines[cursor];
        if (source?.text !== line.text) throw new ValidationError("patch deletion does not match file");
        if (source.newline !== !line.noNewline) {
          throw new ValidationError("patch source newline marker does not match file");
        }
        cursor += 1;
      } else {
        output.push({ text: line.text, newline: !line.noNewline });
      }
    }
  }
  output.push(...oldLines.slice(cursor));
  if (output.some((line, index) => index < output.length - 1 && !line.newline)) {
    throw new ValidationError("patch output has an invalid newline marker");
  }
  const patched = output.map((line) => line.text).join("\n");
  return output.at(-1)?.newline === true && patched.length > 0 ? `${patched}\n` : patched;
}

export type PatchHooks = {
  afterInstall?: (path: string) => void | Promise<void>;
};

function removeCreatedDirectory(workspace: string, path: string): void {
  try {
    const parent = openSecureParent(workspace, path, false);
    try {
      unlinkAt(parent, parent.name, true);
    } finally {
      closeSecureParent(parent);
    }
  } catch {
    // A directory is removed only when the secure parent handle proves it is empty.
  }
}

function patchTool(hooks: PatchHooks = {}): Tool {
  return {
  definition: fileDefinition("fs.patch", "Apply a unified patch to workspace files.", { patch: { type: "string" } }, ["patch"]),
  async execute(args, context) {
    const patches = parsePatch(stringArgument(args, "patch"));
    const resolved = patches.map((file) => {
      const oldPath = file.oldPath === null ? null : resolveWorkspacePath(context.workspace, file.oldPath);
      const newPath = file.newPath === null ? null : resolveWorkspacePath(context.workspace, file.newPath);
      if (oldPath !== null && newPath !== null && oldPath !== newPath) {
        throw new ValidationError("renaming files in patches is not supported");
      }
      return { file, path: newPath ?? oldPath };
    });

    const seen = new Set<string>();
    const changes = [] as Array<{
      file: FilePatch;
      path: string;
      isDelete: boolean;
      existed: boolean;
      content: string | null;
    }>;
    for (const { file, path } of resolved) {
      if (path === null) throw new ValidationError("patch target is missing");
      if (seen.has(path)) throw new ValidationError("patch contains duplicate file targets");
      seen.add(path);

      const isDelete = file.newPath === null;
      let existed = false;
      try {
        const parent = openSecureParent(context.workspace, path, false);
        try {
          const target = openPatchTarget(parent);
          existed = target !== null;
          if (target !== null) closeSecureFile(target);
        } finally {
          closeSecureParent(parent);
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      if ((file.oldPath === null) === existed) {
        throw new ValidationError(isDelete ? "cannot delete a missing file" : "patch target already exists or is missing");
      }

      const original = existed ? await readWorkspaceTextForPatch(context.workspace, path) : "";
      const patched = applyHunks(original, file.hunks);
      if (isDelete && patched !== "") {
        throw new ValidationError("deletion patch must match and remove the entire file");
      }
      changes.push({ file, path, isDelete, existed, content: isDelete ? null : patched });
    }

    const staged: Array<{
      change: (typeof changes)[number];
      parent: ReturnType<typeof openSecureParent>;
      tempName: string | null;
      backupName: string | null;
      backupMade: boolean;
      installed: boolean;
      backupRetained: boolean;
    }> = [];
    const createdDirectories = new Set<string>();
    let transactionCommitted = false;
    try {
      for (const change of changes) {
        let parent: ReturnType<typeof openSecureParent>;
        try {
          parent = openSecureParent(context.workspace, change.path, true);
        } catch (error) {
          for (const directory of (error as DirectoryOpenFailure).created ?? []) createdDirectories.add(directory);
          throw error;
        }
        for (const directory of parent.created) createdDirectories.add(directory);
        let tempName: string | null = null;
        try {
          if (!change.isDelete) {
            tempName = `.kestrel-patch-${randomUUID()}.tmp`;
            createPatchTemp(parent, tempName, change.content ?? "");
          }
          staged.push({ change, parent, tempName, backupName: null, backupMade: false, installed: false, backupRetained: false });
        } catch (error) {
          closeSecureParent(parent);
          throw error;
        }
      }

      for (const item of staged) {
        const { change } = item;
        const current = openPatchTarget(item.parent);
        if (current !== null) closeSecureFile(current);
        if (change.existed !== (current !== null)) {
          throw new ToolExecutionError("patch target changed during staging");
        }

        if (change.existed) {
          item.backupName = `.kestrel-patch-${randomUUID()}.bak`;
          renameAt(item.parent, item.parent.name, item.backupName);
          item.backupMade = true;
        }
        if (item.tempName !== null) {
          renameAt(item.parent, item.tempName, item.parent.name);
          item.installed = true;
          await hooks.afterInstall?.(change.path);
        }
      }
      transactionCommitted = true;
      for (const item of staged) {
        if (item.backupMade && item.backupName !== null) {
          try {
            unlinkAt(item.parent, item.backupName);
            item.backupMade = false;
          } catch (error) {
            item.backupRetained = true;
            throw new ToolExecutionError(
              `patch applied but backup cleanup failed; recovery backup retained at ${relativePath(context.workspace, join(dirname(item.change.path), item.backupName))}`,
              { cause: error },
            );
          }
        }
      }
    } catch (error) {
      if (transactionCommitted) throw error;
      const rollbackFailures: string[] = [];
      for (const item of [...staged].reverse()) {
        if (item.installed) {
          try {
            unlinkAt(item.parent, item.parent.name);
          } catch (rollbackError) {
            rollbackFailures.push(`${relativePath(context.workspace, item.change.path)}: ${String(rollbackError)}`);
          }
        }
        if (item.backupMade && item.backupName !== null) {
          try {
            renameAt(item.parent, item.backupName, item.parent.name);
            item.backupMade = false;
          } catch (rollbackError) {
            item.backupRetained = true;
            rollbackFailures.push(
              `${relativePath(context.workspace, item.change.path)} backup: ${String(rollbackError)}`,
            );
          }
        }
      }
      if (rollbackFailures.length > 0) {
        const retained = staged
          .filter((item) => item.backupRetained && item.backupName !== null)
          .map((item) => relativePath(context.workspace, join(dirname(item.change.path), item.backupName!)));
        throw new ToolExecutionError(
          `patch failed and rollback was incomplete: ${rollbackFailures.join("; ")}; recovery backup retained at ${retained.join(", ") || "the original patch directory"}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      for (const item of staged) {
        if (item.tempName !== null) {
          try {
            unlinkAt(item.parent, item.tempName);
          } catch {
            // The temporary file was already installed or was never created.
          }
        }
        closeSecureParent(item.parent);
      }
      for (const directory of [...createdDirectories].reverse()) removeCreatedDirectory(context.workspace, directory);
    }

    const paths = changes.map((change) => relativePath(context.workspace, change.path));
    return result(`patched ${paths.length} file(s)`, paths);
    },
  };
}

export function createFilesystemTools(hooks?: PatchHooks): Tool[] {
  return [listTool, readTool, writeTool, patchTool(hooks)];
}

export { readWorkspaceText, safeDirectoryEntries, workspacePathInfo } from "./secure-fs";
export { listTool, readTool, writeTool };
