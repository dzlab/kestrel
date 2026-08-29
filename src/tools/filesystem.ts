import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import {
  constants,
  lstatSync,
  realpathSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolExecutionError, ValidationError } from "../errors";
import type { Tool } from "./types";
import {
  MAX_READ_BYTES,
  boundToolResult,
  truncateUtf8,
} from "./types";
import type { ToolContext, ToolResult } from "./types";

const NO_FOLLOW = constants.O_NOFOLLOW;
const READ_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW;
const READ_FILE_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const WRITE_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW;
const CREATE_FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

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
  return boundToolResult({ ok: true, content, ...(data === undefined ? {} : { data }) });
}

async function withOpenFile<T>(path: string, callback: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
  // O_NOFOLLOW makes the final component fail closed if it is replaced by a
  // symlink. Node/Bun expose no openat-style parent directory traversal, so
  // callers also validate canonical components immediately before opening.
  const handle = await open(path, READ_FILE_FLAGS);
  try {
    return await callback(handle);
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceText(path: string): Promise<{ content: string; truncated: boolean }> {
  return withOpenFile(path, async (handle) => {
    const info = await handle.stat();
    if (!info.isFile()) throw new ToolExecutionError("path is not a regular file");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { content: truncateUtf8(content, MAX_READ_BYTES), truncated: bytesRead > MAX_READ_BYTES };
  });
}

export async function workspacePathInfo(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
  return withOpenFile(path, async (handle) => handle.stat());
}

async function readWorkspaceTextForPatch(path: string): Promise<string> {
  const read = await readWorkspaceText(path);
  if (read.truncated) throw new ToolExecutionError("patch target exceeds the bounded read limit");
  return read.content;
}

async function assertSafeDirectory(directory: string): Promise<void> {
  const handle = await open(directory, READ_DIRECTORY_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new ToolExecutionError("path is not a directory");
  } finally {
    await handle.close();
  }
}

async function ensureSafeDirectory(workspace: string, directory: string): Promise<string[]> {
  const workspaceRealpath = realpathSync(workspace);
  const remainder = relative(workspaceRealpath, directory);
  if (!isWithin(workspaceRealpath, directory)) {
    throw new ValidationError("path resolves outside workspace");
  }
  if (remainder.length === 0) {
    await assertSafeDirectory(workspaceRealpath);
    return [];
  }

  const created: string[] = [];
  let current = workspaceRealpath;
  await assertSafeDirectory(current);
  for (const component of remainder.split(sep)) {
    current = join(current, component);
    let made = false;
    try {
      await mkdir(current);
      made = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    await assertSafeDirectory(current);
    if (made) created.push(current);
  }
  return created;
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function safeDirectoryEntries(path: string): Promise<Dirent[]> {
  const handle = await open(path, READ_DIRECTORY_FLAGS);
  try {
    // Node/Bun do not expose readdir/openat relative to an already-open directory
    // handle. Keep the no-follow handle open while revalidating and listing the
    // canonical path; this narrows the final-component race, but a hostile
    // process can still replace a parent component between these pathname calls.
    await handle.stat();
    const checked = lstatSync(path);
    if (checked.isSymbolicLink() || !checked.isDirectory()) {
      throw new ValidationError("workspace path is not a safe directory");
    }
    const entries = await readdir(path, { encoding: "utf8", withFileTypes: true });
    return entries;
  } finally {
    await handle.close();
  }
}

async function writeWorkspaceText(workspace: string, path: string, content: string): Promise<void> {
  await ensureSafeDirectory(workspace, dirname(path));
  const handle = await open(path, WRITE_FILE_FLAGS, 0o666);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ToolExecutionError("path is not a regular file");
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeTaskFile(path: string): Promise<void> {
  // unlinkat(dirfd, ...) is not exposed by Node/Bun. Restrict this fallback to
  // exact, generated regular-file paths; an external parent replacement remains
  // an unavoidable TOCTOU limitation of the available APIs.
  const entry = safeLstat(path);
  if (entry === null || entry.isSymbolicLink() || !entry.isFile()) return;
  await unlink(path);
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
    const entries = (await safeDirectoryEntries(path))
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
    const read = await readWorkspaceText(path);
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
    await ensureSafeDirectory(context.workspace, dirname(path));
    const finalPath = resolveWorkspacePath(context.workspace, requested);
    await writeWorkspaceText(context.workspace, finalPath, content);
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
  return hadTrailingNewline && patched.length > 0 ? `${patched}\n` : patched;
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
      const entry = safeLstat(path);
      const existed = entry !== null;
      if (entry !== null && (entry.isSymbolicLink() || !entry.isFile())) {
        throw new ToolExecutionError("patch target is not a regular file");
      }
      if ((file.oldPath === null) === existed) {
        throw new ValidationError(isDelete ? "cannot delete a missing file" : "patch target already exists or is missing");
      }

      const original = existed ? await readWorkspaceTextForPatch(path) : "";
      const patched = applyHunks(original, file.hunks);
      if (isDelete && patched !== "") {
        throw new ValidationError("deletion patch must match and remove the entire file");
      }
      changes.push({ file, path, isDelete, existed, content: isDelete ? null : patched });
    }

    const staged: Array<{ change: (typeof changes)[number]; tempPath: string | null; backupPath: string | null; backupMade: boolean; installed: boolean }> = [];
    const createdDirectories: string[] = [];
    try {
      for (const change of changes) {
        const directory = dirname(change.path);
        createdDirectories.push(...await ensureSafeDirectory(context.workspace, directory));
        let tempPath: string | null = null;
        if (!change.isDelete) {
          tempPath = join(directory, `.kestrel-patch-${randomUUID()}.tmp`);
          try {
            const handle = await open(tempPath, CREATE_FILE_FLAGS, 0o600);
            try {
              await handle.writeFile(change.content ?? "", "utf8");
              await handle.sync();
            } finally {
              await handle.close();
            }
          } catch (error) {
            try {
              await removeTaskFile(tempPath);
            } catch {
              // Cleanup is limited to this generated temporary path.
            }
            throw error;
          }
        }
        staged.push({ change, tempPath, backupPath: null, backupMade: false, installed: false });
      }

      for (const item of staged) {
        const { change } = item;
        // The public Node/Bun APIs have no descriptor-relative rename/unlink
        // operation. Revalidate every component and use same-directory renames;
        // O_NOFOLLOW protects opened files, while a hostile parent replacement
        // between these calls remains an OS/API limitation documented here.
        checkNoSymlinkComponents(realpathSync(context.workspace), change.path);
        const current = safeLstat(change.path);
        if (change.existed && (current === null || current.isSymbolicLink() || !current.isFile())) {
          throw new ToolExecutionError("patch target changed during staging");
        }
        if (!change.existed && current !== null) {
          throw new ToolExecutionError("patch target appeared during staging");
        }

        if (change.existed) {
          item.backupPath = join(dirname(change.path), `.kestrel-patch-${randomUUID()}.bak`);
          await rename(change.path, item.backupPath);
          item.backupMade = true;
        }
        if (item.tempPath !== null) {
          await rename(item.tempPath, change.path);
          item.installed = true;
        }
      }

    } catch (error) {
      for (const item of [...staged].reverse()) {
        try {
          if (item.installed) await removeTaskFile(item.change.path);
          if (item.backupMade && item.backupPath !== null) await rename(item.backupPath, item.change.path);
        } catch {
          // Best-effort rollback cannot solve an external concurrent rename;
          // never broaden cleanup to an untracked path.
        }
      }
      throw error;
    } finally {
      for (const item of staged) {
        if (item.tempPath !== null) {
          try {
            await removeTaskFile(item.tempPath);
          } catch {
            // Cleanup is limited to this generated temporary path.
          }
        }
        if (item.backupPath !== null) {
          try {
            await removeTaskFile(item.backupPath);
          } catch {
            // Cleanup is limited to this generated backup path.
          }
        }
      }
      for (const directory of [...createdDirectories].reverse()) {
        try {
          await rmdir(directory);
        } catch {
          // Only directories created by this patch are considered for cleanup.
        }
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
