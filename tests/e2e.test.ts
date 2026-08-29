import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeModel,
  PolicyEngine,
  createKestrel,
  isTrustedBuiltInTool,
  loadConfig,
  resolveDatabasePath,
} from "../src";
import type { ModelResponse } from "../src";

const fixture = {
  responses: [
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "write-1", name: "fs.write", arguments: { path: "hello.txt", content: "hello from kestrel\n" } }],
      },
      finishReason: "tool_calls",
    },
    { message: { role: "assistant", content: "Created hello.txt." }, finishReason: "stop" },
  ] satisfies ModelResponse[],
};

test("public factory runs an end-to-end FakeModel task with every built-in tool wired", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-data-"));
  const model = new FakeModel(fixture.responses);
  const agent = createKestrel({ model, workspace, dataDir, modelName: "fixture" });

  try {
    const names = agent.registry.definitions().map(({ name }) => name);
    expect(names).toEqual([
      "fs.list",
      "fs.read",
      "fs.write",
      "fs.patch",
      "search.text",
      "shell.exec",
      "bun.run",
      "memory.save",
      "memory.search",
      "schedule.list",
      "schedule.create",
      "schedule.cancel",
      "self.upgrade",
      "self.apply",
      "self.status",
    ]);
    for (const name of names) expect(isTrustedBuiltInTool(agent.registry.get(name)!)).toBe(true);
    const result = await agent.kernel.run({ title: "create a file", prompt: "Create hello.txt", workspace });
    expect(result.status).toBe("completed");
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe("hello from kestrel\n");
    expect(model.remaining()).toBe(0);

    const policy = new PolicyEngine();
    for (const tool of agent.registry.definitions()) {
      const decision = policy.evaluate(tool, tool.name === "fs.write" ? { path: "hello.txt", content: "x" } : tool.name === "self.status" ? {} : {}, { workspace });
      expect(decision.reason).not.toMatch(/unknown tool/i);
    }
  } finally {
    agent.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("configured persistence uses a durable path under the data directory", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kestrel-config-"));
  try {
    const config = loadConfig({ KESTREL_DATA_DIR: dataDir, KESTREL_DB: "nested/kestrel.sqlite" }, "/tmp/workspace");
    expect(config.databasePath).toBe(join(dataDir, "nested", "kestrel.sqlite"));
    expect(config.databasePath).not.toBe(":memory:");
    expect(config.workspace).toBe("/tmp/workspace");
  } finally {
    expect(existsSync(dataDir)).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("database configuration rejects symlinked database parents", () => {
  const root = mkdtempSync(join(tmpdir(), "kestrel-path-"));
  const dataDir = join(root, "data");
  const target = join(root, "target");
  const link = join(root, "link");
  try {
    expect(() => loadConfig({ KESTREL_DATA_DIR: dataDir, KESTREL_DB: "kestrel.sqlite" }, "/tmp/workspace")).not.toThrow();
    symlinkSync(target, link, "dir");
    expect(() => loadConfig({ KESTREL_DATA_DIR: dataDir, KESTREL_DB: join(link, "kestrel.sqlite") }, "/tmp/workspace")).toThrow(/symlink/i);
    const dataLink = join(root, "data-link");
    symlinkSync(dataDir, dataLink, "dir");
    expect(() => resolveDatabasePath("kestrel.sqlite", dataLink)).toThrow(/symlink/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
