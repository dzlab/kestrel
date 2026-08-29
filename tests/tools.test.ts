import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dlopen, FFIType } from "bun:ffi";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../src/errors";
import { ApprovalManager } from "../src/policy/approvals";
import { createFilesystemTools, resolveWorkspacePath } from "../src/tools/filesystem";
import { ToolRegistry, createToolRegistry } from "../src/tools/registry";
import { MAX_READ_BYTES, MAX_TOOL_OUTPUT_BYTES, boundToolResult } from "../src/tools/types";
import type { ToolContext } from "../src/tools/types";
import { validateNativeDirentHeader, validateNativeReaddirResult } from "../src/tools/secure-fs";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  mkfifo: { args: [FFIType.cstring, FFIType.u16], returns: FFIType.i32 },
});

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

test("registry rejects malformed tool schemas instead of silently accepting arguments", () => {
  const tool = {
    definition: {
      name: "broken",
      description: "broken schema",
      capability: "filesystem",
      inputSchema: {
        type: "object",
        properties: { value: { type: "unsupported" } },
        required: ["missing"],
        additionalProperties: false,
      },
    },
    async execute() {
      return { ok: true, content: "executed" };
    },
  };

  expect(() => new ToolRegistry([tool])).toThrow(ValidationError);
});

test("registry gates custom shell implementations and consumes a matching approval once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-policy-tools-"));
  let executions = 0;
  const shell = {
    definition: {
      name: "shell.exec",
      description: "test shell",
      capability: "shell",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    },
    async execute() {
      executions += 1;
      return { ok: true, content: "executed" };
    },
  };
  const approvals = new ApprovalManager({ now: () => 10_000 });
  const context = { workspace, runId: "run-shell", repository: {} } as ToolContext;
  const registry = new ToolRegistry([shell], {
    approvals,
    policyContext: () => ({ workspace, runId: context.runId, now: 10_001 }),
  });
  const call = { id: "shell-call", name: "shell.exec", arguments: { command: "printf safe" } };

  try {
    await expect(registry.execute(call, context)).resolves.toMatchObject({ ok: false });
    expect(executions).toBe(0);
    approvals.request({
      callId: call.id,
      runId: context.runId,
      tool: call.name,
      capability: "shell",
      risk: "high",
      summary: "Run shell",
      arguments: call.arguments,
      createdAt: 10_000,
      expiresAt: 20_000,
    });
    approvals.approve(call.id, 10_001);
    await expect(registry.execute(call, context)).resolves.toMatchObject({ ok: true, content: "executed" });
    await expect(registry.execute(call, context)).resolves.toMatchObject({ ok: false });
    expect(executions).toBe(1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("registry denies a registered tool that has no known policy rule", async () => {
  let executions = 0;
  const unknown = {
    definition: {
      name: "custom.unknown",
      description: "unknown policy tool",
      capability: "shell",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      executions += 1;
      return { ok: true, content: "bypassed" };
    },
  };

  await expect(new ToolRegistry([unknown]).execute(
    { id: "unknown-call", name: "custom.unknown", arguments: {} },
    { workspace: "/tmp", runId: "run-unknown", repository: {} } as ToolContext,
  )).rejects.toThrow(/policy|unknown/i);
  expect(executions).toBe(0);
});

test("registry rejects tool schemas whose root is not an object", () => {
  const tool = {
    definition: {
      name: "scalar-input",
      description: "scalar input",
      capability: "filesystem",
      inputSchema: { type: "string" },
    },
    async execute() {
      return { ok: true, content: "executed" };
    },
  };

  expect(() => new ToolRegistry([tool])).toThrow(ValidationError);
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

test("patch treats a deleted line beginning with -- as hunk content", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "markers.txt"), "-- old\nkeep\n");
    const result = await createToolRegistry().execute(
      {
        id: "ambiguous-deletion",
        name: "fs.patch",
        arguments: {
          patch: "--- a/markers.txt\n+++ b/markers.txt\n@@ -1,2 +1,2 @@\n--- old\n+-- new\n keep\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "markers.txt"), "utf8")).toBe("-- new\nkeep\n");
  });
});

test("patch validates the new hunk range and supports zero-count insertion offsets", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "range.txt"), "a\nb\n");
    const invalid = await createToolRegistry().execute(
      {
        id: "bad-new-range",
        name: "fs.patch",
        arguments: {
          patch: "--- a/range.txt\n+++ b/range.txt\n@@ -1,1 +3,1 @@\n-a\n+x\n",
        },
      },
      context,
    );
    expect(invalid.ok).toBe(false);
    expect(readFileSync(join(workspace, "range.txt"), "utf8")).toBe("a\nb\n");

    const inserted = await createToolRegistry().execute(
      {
        id: "insert-at-start",
        name: "fs.patch",
        arguments: {
          patch: "--- a/range.txt\n+++ b/range.txt\n@@ -0,0 +1,1 @@\n+x\n",
        },
      },
      context,
    );
    expect(inserted.ok).toBe(true);
    expect(readFileSync(join(workspace, "range.txt"), "utf8")).toBe("x\na\nb\n");
  });
});

test("patch applies a zero-old-count hunk at the standard EOF offset", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "eof.txt"), "a\nb\n");
    const result = await createToolRegistry().execute(
      {
        id: "insert-at-eof",
        name: "fs.patch",
        arguments: {
          patch: "--- a/eof.txt\n+++ b/eof.txt\n@@ -2,0 +3,1 @@\n+x\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "eof.txt"), "utf8")).toBe("a\nb\nx\n");
  });
});

test("patch applies a zero-new-count deletion at the offset after newStart", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "delete-middle.txt"), "a\nb\nc\n");
    const result = await createToolRegistry().execute(
      {
        id: "delete-middle",
        name: "fs.patch",
        arguments: {
          patch: "--- a/delete-middle.txt\n+++ b/delete-middle.txt\n@@ -2 +1,0 @@\n-b\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "delete-middle.txt"), "utf8")).toBe("a\nc\n");
  });
});

test("patch accepts standard Git diff and index metadata between file sections", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "one.txt"), "one\n");
    writeFileSync(join(workspace, "two.txt"), "two\n");
    const result = await createToolRegistry().execute(
      {
        id: "git-metadata",
        name: "fs.patch",
        arguments: {
          patch:
            "diff --git a/one.txt b/one.txt\nindex 1111111..2222222 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+ONE\ndiff --git a/two.txt b/two.txt\nindex 3333333..4444444 100644\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-two\n+TWO\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "one.txt"), "utf8")).toBe("ONE\n");
    expect(readFileSync(join(workspace, "two.txt"), "utf8")).toBe("TWO\n");
  });
});

test("patch rejects malformed Git metadata instead of skipping it", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const result = await createToolRegistry().execute(
      {
        id: "bad-git-metadata",
        name: "fs.patch",
        arguments: {
          patch: "diff --git a/target.txt\n--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before\n");
  });
});

test("patch rejects a single-hash Git index line", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const result = await createToolRegistry().execute(
      {
        id: "single-hash-index",
        name: "fs.patch",
        arguments: {
          patch:
            "diff --git a/target.txt b/target.txt\nindex 1111111\n--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before\n");
  });
});

test("patch rejects Git metadata after the file headers", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const result = await createToolRegistry().execute(
      {
        id: "misplaced-index",
        name: "fs.patch",
        arguments: {
          patch:
            "diff --git a/target.txt b/target.txt\n--- a/target.txt\n+++ b/target.txt\nindex 1111111..2222222 100644\n@@ -1 +1 @@\n-before\n+after\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before\n");
  });
});

test("patch rejects trailing incomplete Git metadata groups", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const result = await createToolRegistry().execute(
      {
        id: "trailing-git-metadata",
        name: "fs.patch",
        arguments: {
          patch:
            "diff --git a/target.txt b/target.txt\nindex 1111111..2222222 100644\n--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\ndiff --git a/missing.txt b/missing.txt\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before\n");
  });
});

test("patch rejects an incomplete Git metadata group before a new group", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "one.txt"), "one\n");
    writeFileSync(join(workspace, "three.txt"), "three\n");
    const result = await createToolRegistry().execute(
      {
        id: "incomplete-git-group",
        name: "fs.patch",
        arguments: {
          patch:
            "diff --git a/one.txt b/one.txt\nindex 1111111..2222222 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+ONE\ndiff --git a/two.txt b/two.txt\nindex 3333333..4444444 100644\ndiff --git a/three.txt b/three.txt\nindex 5555555..6666666 100644\n--- a/three.txt\n+++ b/three.txt\n@@ -1 +1 @@\n-three\n+THREE\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "one.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(workspace, "three.txt"), "utf8")).toBe("three\n");
  });
});

test("patch validates new ranges across multiple hunks with unchanged gaps", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "multi.txt"), "a\nb\nc\nd\n");
    const result = await createToolRegistry().execute(
      {
        id: "multi-hunk-range",
        name: "fs.patch",
        arguments: {
          patch:
            "--- a/multi.txt\n+++ b/multi.txt\n@@ -1,1 +1,1 @@\n a\n@@ -4,1 +4,1 @@\n-d\n+D\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "multi.txt"), "utf8")).toBe("a\nb\nc\nD\n");
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

test("patch-created files preserve the patch newline semantics", async () => {
  await withWorkspace(async (workspace, context) => {
    const result = await createToolRegistry().execute(
      {
        id: "create-newline",
        name: "fs.patch",
        arguments: {
          patch: "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("created\n");

    const noNewline = await createToolRegistry().execute(
      {
        id: "create-no-newline",
        name: "fs.patch",
        arguments: {
          patch: "--- /dev/null\n+++ b/no-newline.txt\n@@ -0,0 +1 @@\n+created\n\\ No newline at end of file\n",
        },
      },
      context,
    );

    expect(noNewline.ok).toBe(true);
    expect(readFileSync(join(workspace, "no-newline.txt"), "utf8")).toBe("created");
  });
});

test("patch validates newline markers and source newline semantics", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "source.txt"), "old");
    const missingSourceMarker = await createToolRegistry().execute(
      {
        id: "missing-source-marker",
        name: "fs.patch",
        arguments: {
          patch: "--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-old\n+new\n",
        },
      },
      context,
    );
    expect(missingSourceMarker.ok).toBe(false);
    expect(readFileSync(join(workspace, "source.txt"), "utf8")).toBe("old");

    const markerAtStart = await createToolRegistry().execute(
      {
        id: "marker-at-start",
        name: "fs.patch",
        arguments: {
          patch: "--- a/source.txt\n+++ b/source.txt\n@@ -0,0 +0,0 @@\n\\ No newline at end of file\n",
        },
      },
      context,
    );
    expect(markerAtStart.ok).toBe(false);

    const valid = await createToolRegistry().execute(
      {
        id: "preserve-no-newline",
        name: "fs.patch",
        arguments: {
          patch:
            "--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n",
        },
      },
      context,
    );
    expect(valid.ok).toBe(true);
    expect(readFileSync(join(workspace, "source.txt"), "utf8")).toBe("new");
  });
});

test("patch rejects non-empty lines between headers and hunks", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "target.txt"), "before\n");
    const result = await createToolRegistry().execute(
      {
        id: "malformed-patch",
        name: "fs.patch",
        arguments: {
          patch: "--- a/target.txt\n+++ b/target.txt\nunexpected\n@@ -1 +1 @@\n-before\n+after\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "target.txt"), "utf8")).toBe("before\n");
  });
});

test("read rejects a FIFO without blocking", async () => {
  await withWorkspace(async (workspace, context) => {
    const fifo = join(workspace, "pipe");
    expect(libc.symbols.mkfifo(fifo, 0o600)).toBe(0);

    const result = await Promise.race([
      createToolRegistry().execute(
        { id: "read-fifo", name: "fs.read", arguments: { path: "pipe" } },
        context,
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO read blocked")), 250)),
    ]);

    expect(result.ok).toBe(false);
    expect(result.content).toContain("regular file");
  });
});

test("patch retains the only backup when restoration fails", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("safe.txt")) {
            unlinkSync(path);
            mkdirSync(path);
            throw new Error("force rollback");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "failed-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(workspace, backups[0]!), "utf8")).toBe("original\n");
    expect(result.content).toContain("backup");
  });
});

test("patch rollback does not unlink a replacement installed after the transaction", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("safe.txt")) {
            unlinkSync(path);
            writeFileSync(path, "replacement\n");
            throw new Error("force rollback");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "replacement-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "safe.txt"), "utf8")).toBe("replacement\n");
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(workspace, backups[0]!), "utf8")).toBe("original\n");
    expect(result.content).toContain("recovery backup retained");
  });
});

test("patch rollback retains the original when afterInstall replaces the recovery artifact", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("safe.txt")) {
            const backup = readdirSync(workspace).find((name) => name.endsWith(".bak"));
            if (backup === undefined) throw new Error("recovery backup was not created");
            unlinkSync(join(workspace, backup));
            writeFileSync(join(workspace, backup), "replacement backup\n");
            throw new Error("force rollback");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "backup-replacement-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "safe.txt"), "utf8")).toBe("original\n");
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(workspace, backups[0]!), "utf8")).toBe("replacement backup\n");
  });
});

test("patch rollback does not unlink a replacement made during cleanup verification", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("safe.txt")) throw new Error("force rollback");
        },
        beforeCleanup(path) {
          if (path.endsWith("safe.txt")) {
            unlinkSync(path);
            writeFileSync(path, "replacement during cleanup\n");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "cleanup-replacement-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "safe.txt"), "utf8")).toBe("replacement during cleanup\n");
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(workspace, backups[0]!), "utf8")).toBe("original\n");
    expect(result.content).toContain("recovery backup retained");
  });
});

test("patch fails closed when a target parent directory is replaced after install", async () => {
  await withWorkspace(async (workspace, context) => {
    const parent = join(workspace, "nested");
    const originalParent = join(workspace, "nested-original");
    mkdirSync(parent);
    writeFileSync(join(parent, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("nested/safe.txt")) {
            renameSync(parent, originalParent);
            mkdirSync(parent);
            writeFileSync(join(parent, "safe.txt"), "replacement\n");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "parent-replacement",
        name: "fs.patch",
        arguments: {
          patch: "--- a/nested/safe.txt\n+++ b/nested/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(parent, "safe.txt"), "utf8")).toBe("replacement\n");
    const backups = readdirSync(originalParent).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(originalParent, backups[0]!), "utf8")).toBe("original\n");
    expect(result.content).toContain("held original patch parent");
    expect(result.content).not.toContain(`nested/${backups[0]}`);
  });
});

test("patch-created files retain a recovery artifact when cleanup sees a replacement", async () => {
  await withWorkspace(async (workspace, context) => {
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("created.txt")) {
            unlinkSync(path);
            writeFileSync(path, "replacement\n");
            throw new Error("force rollback");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "created-replacement-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("replacement\n");
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(workspace, backups[0]!), "utf8")).toBe("created\n");
    expect(result.content).toContain("recovery backup retained");
  });
});

test("patch-created files retain recovery content when afterInstall replaces the artifact", async () => {
  await withWorkspace(async (workspace, context) => {
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("created.txt")) {
            const backup = readdirSync(workspace).find((name) => name.endsWith(".bak"));
            if (backup === undefined) throw new Error("recovery backup was not created");
            unlinkSync(join(workspace, backup));
            writeFileSync(join(workspace, backup), "replacement backup\n");
            throw new Error("force rollback");
          }
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "created-backup-replacement-rollback",
        name: "fs.patch",
        arguments: {
          patch: "--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(workspace, "created.txt"))).toBe(false);
    const backups = readdirSync(workspace).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(2);
    expect(backups.map((name) => readFileSync(join(workspace, name), "utf8"))).toEqual(
      expect.arrayContaining(["replacement backup\n", "created\n"]),
    );
    expect(result.content).toContain("recovery backup retained");
  });
});

test("patch rolls back earlier files when a later commit operation fails", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const result = await createToolRegistry().execute(
      {
        id: "late-failure",
        name: "fs.patch",
        arguments: {
          patch:
            "--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n--- /dev/null\n+++ b/newdir/child.txt\n@@ -0,0 +1 @@\n+child\n--- /dev/null\n+++ b/newdir\n@@ -0,0 +1 @@\n+file\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "safe.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(workspace, "newdir"))).toBe(false);
  });
});

test("patch rollback preserves pre-existing directories", async () => {
  await withWorkspace(async (workspace, context) => {
    mkdirSync(join(workspace, "pre-existing"));
    writeFileSync(join(workspace, "safe.txt"), "original\n");
    const registry = new ToolRegistry(
      createFilesystemTools({
        afterInstall(path) {
          if (path.endsWith("safe.txt")) throw new Error("force rollback");
        },
      }),
    );

    const result = await registry.execute(
      {
        id: "preserve-directory",
        name: "fs.patch",
        arguments: {
          patch:
            "--- /dev/null\n+++ b/pre-existing/child.txt\n@@ -0,0 +1 @@\n+child\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1 +1 @@\n-original\n+changed\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(workspace, "pre-existing"))).toBe(true);
    expect(existsSync(join(workspace, "pre-existing", "child.txt"))).toBe(false);
  });
});

test("patch validates deletion contents before unlinking", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "keep.txt"), "actual\n");
    const result = await createToolRegistry().execute(
      {
        id: "bad-delete",
        name: "fs.patch",
        arguments: {
          patch: "--- a/keep.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-wrong\n",
        },
      },
      context,
    );

    expect(result.ok).toBe(false);
    expect(readFileSync(join(workspace, "keep.txt"), "utf8")).toBe("actual\n");
  });
});

test("patch deletes a file only after a matching full-file deletion hunk", async () => {
  await withWorkspace(async (workspace, context) => {
    writeFileSync(join(workspace, "remove.txt"), "remove me\n");
    const call = {
      id: "delete",
      name: "fs.patch",
      arguments: { patch: "--- a/remove.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-remove me\n" },
    };
    const approvals = new ApprovalManager({ now: () => 10_000 });
    approvals.request({
      callId: call.id,
      runId: context.runId,
      tool: call.name,
      capability: "destructive",
      risk: "high",
      summary: "Delete a file",
      arguments: call.arguments,
      createdAt: 10_000,
      expiresAt: 20_000,
    });
    approvals.approve(call.id, 10_001);
    const result = await new ToolRegistry(createFilesystemTools(), {
      approvals,
      policyContext: () => ({ workspace, runId: context.runId, now: 10_001 }),
    }).execute(call, context);

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, "remove.txt"))).toBe(false);
  });
});

test("bounds structured tool data as well as content", async () => {
  await withWorkspace(async (workspace, context) => {
    for (let index = 0; index < 1_000; index += 1) {
      writeFileSync(join(workspace, `data-${String(index).padStart(4, "0")}-${"x".repeat(200)}.txt`), "x");
    }
    const result = await createToolRegistry().execute(
      { id: "list-data-big", name: "fs.list", arguments: { path: "." } },
      context,
    );

    expect(result.ok).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result.data)).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    expect(result.data).not.toHaveLength(1_000);
  });
});

test("enforces one aggregate serialized ToolResult budget", async () => {
  const tool = {
    definition: {
      name: "oversized-result",
      description: "returns oversized result fields",
      capability: "filesystem",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async execute() {
      return {
        ok: true,
        content: "c".repeat(MAX_TOOL_OUTPUT_BYTES),
        data: "d".repeat(MAX_TOOL_OUTPUT_BYTES),
        redactions: ["r".repeat(MAX_TOOL_OUTPUT_BYTES)],
      };
    },
  };

  const registry = new ToolRegistry([tool], {
    policyEngine: { evaluate: () => ({ allowed: true, requiresApproval: false, capability: "filesystem", risk: "low", reason: "test" }) } as never,
  });
  const result = await registry.execute(
    { id: "aggregate-budget", name: "oversized-result", arguments: {} },
    { workspace: "/tmp", runId: "run-budget", repository: {} } as ToolContext,
  );
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  expect(result.data).not.toBe("d".repeat(MAX_TOOL_OUTPUT_BYTES));
});

test("bounds redactions within the complete serialized ToolResult envelope", () => {
  const result = boundToolResult({
    ok: false,
    content: "useful output",
    data: { kind: "summary" },
    redactions: ["r".repeat(MAX_TOOL_OUTPUT_BYTES)],
  });

  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  expect(result.content).toBe("useful output");
  expect(result.data).toEqual({ kind: "summary" });
  expect(result.redactions).toHaveLength(1);
  expect(result.redactions?.[0]).not.toBe("r".repeat(MAX_TOOL_OUTPUT_BYTES));
});

test("rejects a native dirent record length above the bounded Darwin record size", () => {
  const header = new Uint8Array(21);
  const view = new DataView(header.buffer);
  view.setUint16(16, 1025, true);
  view.setUint16(18, 1, true);

  expect(() => validateNativeDirentHeader(header)).toThrow("invalid entry");
});

test("native directory reads distinguish an error from EOF", () => {
  expect(() => validateNativeReaddirResult("workspace", null, 5)).toThrow("EIO");
  expect(validateNativeReaddirResult("workspace", null, 0)).toBe(true);
  expect(validateNativeReaddirResult("workspace", {}, 5)).toBe(false);
});

test("direct search honors ignored directories and rejects special files", async () => {
  await withWorkspace(async (workspace, context) => {
    mkdirSync(join(workspace, ".git"));
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, ".git", "ignored.txt"), "needle\n");
    writeFileSync(join(workspace, "node_modules", "ignored.txt"), "needle\n");
    const fifo = join(workspace, "pipe");
    expect(libc.symbols.mkfifo(fifo, 0o600)).toBe(0);
    const registry = createToolRegistry();

    for (const path of [".git", "node_modules", ".git/ignored.txt", "node_modules/ignored.txt"]) {
      const ignored = await registry.execute(
        { id: `ignored-${path}`, name: "search.text", arguments: { query: "needle", path } },
        context,
      );
      expect(ignored.ok).toBe(true);
      expect(ignored.data).toEqual([]);
    }

    const special = await registry.execute(
      { id: "special-search", name: "search.text", arguments: { query: "needle", path: "pipe" } },
      context,
    );
    expect(special.ok).toBe(false);
    expect(special.content).toContain("regular file");
  });
});

test("rejects workspace symlinks even when they point back inside the workspace", async () => {
  await withWorkspace(async (workspace, context) => {
    mkdirSync(join(workspace, "real"));
    writeFileSync(join(workspace, "real", "inside.txt"), "inside\n");
    symlinkSync(join(workspace, "real"), join(workspace, "alias"));

    const registry = createToolRegistry();
    const read = await registry.execute(
      { id: "internal-link-read", name: "fs.read", arguments: { path: "alias/inside.txt" } },
      context,
    );
    const list = await registry.execute(
      { id: "internal-link-list", name: "fs.list", arguments: { path: "alias" } },
      context,
    );

    expect(read.ok).toBe(false);
    expect(list.ok).toBe(false);
    expect(read.content).toContain("symlink");
    expect(list.content).toContain("symlink");
  });
});
