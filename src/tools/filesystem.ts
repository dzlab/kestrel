import {
  mkdir,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolExecutionError, ValidationError } from "../errors";
import type { Tool } from "./types";
import {
  MAX_READ_BYTES,
  boundToolResult,
  truncateUtf8,
} from "./types";
import type { ToolContext, ToolResult } from "./types";

function fail(error: unknown): never {
  if (error instanceof ValidationError || error instanceof ToolExecutionError) {
    throw error;
  }
  throw new ToolExecutionError(error instanceof Error ? error.message : String(error), { cause: error });
}

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

  const lexical = resolve(workspace, requested);
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
  return canonical;
}

function relativePath(workspace: string, filePath: string): string {
  return relative(realpathSync(workspace), filePath).split(sep).join("/") || ".";
}

function result(content: string, data?: unknown): ToolResult {
  return boundToolResult({ ok: true, content, ...(data === undefined ? {} : { data }) });
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
    const entries = (await readdir(path, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      }));
    return result(JSON.stringify(entries), entries);
  },
};

const readTool: Tool = {
  definition: fileDefinition("fs.read", "Read bounded UTF-8 text from a workspace file.", { path: { type: "string" } }, ["path"]),
  async execute(args, context) {
    const path = resolveWorkspacePath(context.workspace, stringArgument(args, "path"));
    const info = await stat(path);
    if (!info.isFile()) {
      throw new ToolExecutionError("path is not a regular file");
    }
    const content = await Bun.file(path).slice(0, MAX_READ_BYTES + 1).text();
    const truncated = Buffer.byteLength(content, "utf8") > MAX_READ_BYTES;
    const bounded = truncateUtf8(content, MAX_READ_BYTES);
    return result(bounded, { path: relativePath(context.workspace, path), truncated });
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
    await mkdir(dirname(path), { recursive: true });
    const finalPath = resolveWorkspacePath(context.workspace, requested);
    await writeFile(finalPath, content, "utf8");
    return result(`wrote ${relativePath(context.workspace, finalPath)}`, {
      path: relativePath(context.workspace, finalPath),
      bytes: Buffer.byteLength(content, "utf8"),
    });
  },
};

type Hunk = { oldStart: number; oldCount: number; newCount: number; lines: string[] };
type FilePatch = { oldPath: string | null; newPath: string | null; hunks: Hunk[] };

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

function parsePatch(patch: string): FilePatch[] {
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index += 1;
      continue;
    }
    const oldPath = patchPath(lines[index]);
    index += 1;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new ValidationError("unified patch is missing its target header");
    }
    const newPath = patchPath(lines[index]);
    index += 1;
    const hunks: Hunk[] = [];
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const header = lines[index];
      if (!header.startsWith("@@ ")) {
        index += 1;
        continue;
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
      if (match === null) {
        throw new ValidationError("invalid unified patch hunk header");
      }
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      index += 1;
      const hunkLines: string[] = [];
      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- ")) {
        const line = lines[index];
        if (line === "" && index === lines.length - 1) {
          index += 1;
          break;
        }
        if (line !== "\\ No newline at end of file" && !line.startsWith(" ") && !line.startsWith("+") && !line.startsWith("-")) {
          throw new ValidationError("invalid unified patch line");
        }
        hunkLines.push(line);
        index += 1;
      }
      let consumedOld = 0;
      let producedNew = 0;
      for (const line of hunkLines) {
        if (line === "\\ No newline at end of file") continue;
        if (line.startsWith("+")) producedNew += 1;
        else {
          consumedOld += 1;
          if (line.startsWith(" ")) producedNew += 1;
        }
      }
      if (consumedOld !== oldCount || producedNew !== newCount) {
        throw new ValidationError("unified patch hunk line counts do not match");
      }
      hunks.push({ oldStart, oldCount, newCount, lines: hunkLines });
    }
    if (oldPath === null && newPath === null) {
      throw new ValidationError("patch must target a file");
    }
    if (hunks.length === 0 && oldPath !== null && newPath !== null) {
      throw new ValidationError("patch file has no hunks");
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
  const oldLines = original.length === 0 ? [] : original.split("\n");
  if (hadTrailingNewline) oldLines.pop();
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > oldLines.length) throw new ValidationError("patch hunk is out of order");
    output.push(...oldLines.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line === "\\ No newline at end of file") continue;
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (oldLines[cursor] !== text) throw new ValidationError("patch context does not match file");
        output.push(text);
        cursor += 1;
      } else if (marker === "-") {
        if (oldLines[cursor] !== text) throw new ValidationError("patch deletion does not match file");
        cursor += 1;
      } else {
        output.push(text);
      }
    }
  }
  output.push(...oldLines.slice(cursor));
  const patched = output.join("\n");
  return hadTrailingNewline ? `${patched}\n` : patched;
}

const patchTool: Tool = {
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

    const changes = resolved.map(({ file, path }) => {
      if (path === null) throw new ValidationError("patch target is missing");
      const isDelete = file.newPath === null;
      const original = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (Buffer.byteLength(original, "utf8") > MAX_READ_BYTES) {
        throw new ToolExecutionError("patch target exceeds the bounded read limit");
      }
      return { file, path, isDelete, content: isDelete ? null : applyHunks(original, file.hunks) };
    });

    for (const change of changes) {
      if (change.isDelete) {
        if (existsSync(change.path)) unlinkSync(change.path);
      } else {
        await mkdir(dirname(change.path), { recursive: true });
        const finalPath = resolveWorkspacePath(context.workspace, change.file.newPath ?? change.file.oldPath ?? "");
        writeFileSync(finalPath, change.content ?? "", "utf8");
      }
    }
    const paths = changes.map((change) => relativePath(context.workspace, change.path));
    return result(`patched ${paths.length} file(s)`, paths);
  },
};

export function createFilesystemTools(): Tool[] {
  return [listTool, readTool, writeTool, patchTool];
}

export { listTool, readTool, writeTool, patchTool };
