import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../src/errors";
import { ToolRegistry, createToolRegistry } from "../src/tools/registry";
import { resolveWorkspacePath } from "../src/tools/filesystem";
import { MAX_READ_BYTES, MAX_TOOL_OUTPUT_BYTES } from "../src/tools/types";
import type { ToolContext } from "../src/tools/types";

function withWorkspace<T>(callback: (workspace: string, context: ToolContext) => T | Promise<T>): T | Promise<T> {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-tools-"));
  const context = { workspace, runId: "run-tools", repository: {} } as ToolContext;
  try {
    const result = callback(workspace, context);
    if (result !== null && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).finally(() => rmSync(workspace, { recursive: true, force: true }));
    }
    rmSync(workspace, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

test("registry rejects malformed, unknown, and schema-invalid tool calls", async () => {
  const registry = createToolRegistry();
  const context = { workspace: "/tmp", runId: "run-schema", repository: {} } as ToolContext;

  await expect(registry.execute({ id: "call-1", name: "missing", arguments: {} }, context)).rejects.toThrow(
    ValidationError,
  );
  await expect(registry.execute({ id: "call-2", name: "fs.read", arguments: { path: 42 } }, context)).rejects.toThrow(
    ValidationError,
  );
  await expect(registry.execute({ name: "fs.read", arguments: { path: "x" } }, context)).rejects.toThrow(
    ValidationError,
  );
});

test("lists and reads workspace files with a bounded read", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "small.txt"), "hello");
    writeFileSync(join(workspace, "large.txt"), "x".repeat(MAX_READ_BYTES + 100));
    const registry = createToolRegistry();

    const listing = await registry.execute(
      { id: "list", name: "fs.list", arguments: { path: "." } },
      context,
    );
    expect(listing.ok).toBe(true);
    expect(listing.data).toEqual([
      { name: "large.txt", type: "file" },
      { name: "small.txt", type: "file" },
    ]);

    const read = await registry.execute(
      { id: "read", name: "fs.read", arguments: { path: "large.txt" } },
      context,
    );
    expect(read.ok).toBe(true);
    expect(new TextEncoder().encode(read.content).byteLength).toBe(MAX_READ_BYTES);
    expect(read.data).toEqual({ path: "large.txt", truncated: true });
  });
});

test("writes a file and applies a unified patch without a shell", async () => {
  await withWorkspace(async (workspace, context) => {
    const registry = createToolRegistry();
    const write = await registry.execute(
      { id: "write", name: "fs.write", arguments: { path: "notes.txt", content: "one\ntwo\n" } },
      context,
    );
    expect(write.ok).toBe(true);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("one\ntwo\n");

    const patch = await registry.execute(
      {
        id: "patch",
        name: "fs.patch",
        arguments: {
          patch: "--- a/notes.txt\n+++ b/notes.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        },
      },
      context,
    );
    expect(patch.ok).toBe(true);
    expect(readFileSync(join(workspace, "notes.txt"), "utf8")).toBe("one\nthree\n");
  });
});

test("rejects traversal and symlink escapes", async () => {
  await withWorkspace(async (workspace, context) => {
    const outside = mkdtempSync(join(tmpdir(), "kestrel-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(workspace, "linked"));
      expect(() => resolveWorkspacePath(workspace, "../secret.txt")).toThrow(ValidationError);
      expect(() => resolveWorkspacePath(workspace, "linked/secret.txt")).toThrow(ValidationError);

      const result = await createToolRegistry().execute(
        { id: "escape", name: "fs.read", arguments: { path: "linked/secret.txt" } },
        context,
      );
      expect(result.ok).toBe(false);
      expect(result.content).toContain("workspace");

      const search = await createToolRegistry().execute(
        { id: "search-escape", name: "search.text", arguments: { query: "secret" } },
        context,
      );
      expect(search.ok).toBe(true);
      expect((search.data as { path: string }[]).some((match) => match.path.startsWith("linked/"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("searches text files, skips explicit ignored directories, and caps matches", async () => {
  await withWorkspace(async (workspace, context) => {
    mkdirSync(join(workspace, ".git"));
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, ".git", "ignored.txt"), "needle\n");
    writeFileSync(join(workspace, "node_modules", "ignored.txt"), "needle\n");
    writeFileSync(join(workspace, "00-visible.txt"), "needle here\nother\nneedle again\n");
    for (let index = 0; index < 120; index += 1) {
      writeFileSync(join(workspace, `match-${index}.txt`), "needle\n");
    }

    const result = await createToolRegistry().execute(
      { id: "search", name: "search.text", arguments: { query: "needle" } },
      context,
    );
    expect(result.ok).toBe(true);
    const matches = (result.data as { path: string; line: number; content: string }[]);
    expect(matches).toHaveLength(100);
    expect(matches.some((match) => match.path.startsWith(".git/") || match.path.startsWith("node_modules/"))).toBe(
      false,
    );
    expect(matches.some((match) => match.path === "00-visible.txt" && match.line === 1)).toBe(true);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  });
});

test("caps oversized tool output", async () => {
  await withWorkspace(async (workspace, context) => {
    for (let index = 0; index < 1_000; index += 1) {
      writeFileSync(join(workspace, `entry-${String(index).padStart(4, "0")}-${"x".repeat(200)}.txt`), "x");
    }
    const result = await createToolRegistry().execute(
      { id: "list-big", name: "fs.list", arguments: { path: "." } },
      context,
    );
    expect(result.ok).toBe(true);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  });
});

test("patch validates every target before changing any file", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "safe\n");
    const result = await createToolRegistry().execute(
      {
        id: "bad-patch",
        name: "fs.patch",
        arguments: {
          patch:
            "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-safe\n+changed\n--- a/other.txt\n+++ ../../outside.txt\n@@ -0,0 +1 @@\n+bad\n",
        },
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "safe.txt"), "utf8")).toBe("safe\n");
  });
});
