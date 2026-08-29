import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApprovalManager } from "../src/policy/approvals";
import { openDatabase } from "../src/store/database";
import { StoreRepository } from "../src/store/repository";
import { SelfUpgrade, type UpgradeRunner } from "../src/upgrade";
import { createToolRegistry } from "../src/tools/registry";
import { PolicyEngine } from "../src/policy/rules";

const patch = `--- a/target.txt
+++ b/target.txt
@@ -1 +1 @@
-old
+new
`;

function fixture(verificationExitCode = 0): {
  workspace: string;
  repository: StoreRepository;
  approvals: ApprovalManager;
  runner: UpgradeRunner;
  runId: string;
  setRepoState: (state: string) => void;
  close: () => void;
} {
  const workspace = mkdtempSync(join(tmpdir(), "kestrel-upgrade-"));
  writeFileSync(join(workspace, "target.txt"), "old\n");
  const database = openDatabase(":memory:");
  const repository = new StoreRepository(database);
  const task = repository.createTask({ title: "upgrade", prompt: "upgrade", workspace, maxSteps: 1 });
  const run = repository.startRun(task.id, "upgrade-run");
  const approvals = new ApprovalManager(repository);
  let repoState = "\n";
  const runner: UpgradeRunner = {
    async run(argv) {
      if (argv[0] === "git" && argv[1] === "rev-parse") return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      if (argv[0] === "git" && argv[1] === "status") return { exitCode: 0, stdout: repoState, stderr: "" };
      if (argv[0] === "git" && argv[1] === "diff") return { exitCode: 0, stdout: "\n", stderr: "" };
      return { exitCode: verificationExitCode, stdout: verificationExitCode === 0 ? "ok\n" : "failed\n", stderr: "" };
    },
  };
  return { workspace, repository, approvals, runner, runId: run.id, setRepoState: (state) => { repoState = state; }, close: () => { database.close(); rmSync(workspace, { recursive: true, force: true }); } };
}

async function proposed(fixtureValue: ReturnType<typeof fixture>) {
  const upgrade = new SelfUpgrade({ repository: fixtureValue.repository, approvals: fixtureValue.approvals, runner: fixtureValue.runner });
  return upgrade.propose({ workspace: fixtureValue.workspace, runId: fixtureValue.runId, patch, verification: ["bun", "test"] });
}

test("proposes a bounded patch without mutating source and persists its base state", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    expect(readFileSync(join(value.workspace, "target.txt"), "utf8")).toBe("old\n");
    expect(proposal).toMatchObject({
      baseRevision: "abc123",
      targetFiles: ["target.txt"],
      status: "proposed",
      approval: { status: "pending" },
    });
    expect(proposal.id).toBeString();
    expect(proposal.patchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(value.repository.getEvents(value.runId).some((event) => event.type === "upgrade.proposed")).toBe(true);
  } finally {
    value.close();
  }
});

test("requires and consumes the exact durable approval once", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).rejects.toThrow(/approval/i);
    value.approvals.approve(proposal.approval.id);
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).resolves.toMatchObject({ status: "applied" });
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).rejects.toThrow(/applied|one-shot|approval/i);
  } finally {
    value.close();
  }
});

test("direct self-upgrade input cannot forge policy approval", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.apply({
      workspace: value.workspace,
      runId: value.runId,
      proposalId: proposal.id,
      approvedByPolicy: true,
    } as never)).rejects.toThrow(/approval/i);
  } finally {
    value.close();
  }
});

test("rejects a proposal when a target hash is stale", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    writeFileSync(join(value.workspace, "target.txt"), "changed\n");
    value.approvals.approve(proposal.approval.id);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).rejects.toThrow(/stale|changed/i);
    expect(readFileSync(join(value.workspace, "target.txt"), "utf8")).toBe("changed\n");
  } finally {
    value.close();
  }
});

test("rejects a proposal when the repository changes concurrently", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    value.setRepoState(" M another.txt\n");
    value.approvals.approve(proposal.approval.id);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).rejects.toThrow(/stale|changed/i);
    expect(readFileSync(join(value.workspace, "target.txt"), "utf8")).toBe("old\n");
  } finally {
    value.close();
  }
});

test("detects a proposal targeting configured Kestrel self paths", async () => {
  const value = fixture();
  try {
    const upgrade = new SelfUpgrade({
      repository: value.repository,
      approvals: value.approvals,
      runner: value.runner,
      selfPaths: [join(value.workspace, "target.txt")],
    });
    const proposal = await upgrade.propose({ workspace: value.workspace, runId: value.runId, patch, verification: ["bun", "test"] });
    expect(proposal.selfTarget).toBe(true);
  } finally {
    value.close();
  }
});

test("rolls back source when bounded verification fails", async () => {
  const value = fixture(1);
  try {
    const proposal = await proposed(value);
    value.approvals.approve(proposal.approval.id);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id })).rejects.toThrow(/verification/i);
    expect(readFileSync(join(value.workspace, "target.txt"), "utf8")).toBe("old\n");
    expect(upgrade.status(value.runId, proposal.id)?.status).toBe("failed");
  } finally {
    value.close();
  }
});

test("records before and after hashes and verification output on success", async () => {
  const value = fixture();
  try {
    const proposal = await proposed(value);
    value.approvals.approve(proposal.approval.id);
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    const result = await upgrade.apply({ workspace: value.workspace, runId: value.runId, proposalId: proposal.id });
    expect(result).toMatchObject({ status: "applied", verificationResult: { stdout: "ok\n", exitCode: 0 } });
    expect(result.beforeHash).not.toBe(result.afterHash);
    expect(readFileSync(join(value.workspace, "target.txt"), "utf8")).toBe("new\n");
  } finally {
    value.close();
  }
});

test("registers the exact self tools with status low risk and mutations high risk", () => {
  const registry = createToolRegistry();
  expect(registry.definitions().map(({ name }) => name)).toEqual(expect.arrayContaining(["self.upgrade", "self.apply", "self.status"]));
  const engine = new PolicyEngine();
  const context = { workspace: process.cwd(), runId: "run-policy", now: Date.now() };
  expect(engine.evaluate(registry.get("self.status")!, {}, context)).toMatchObject({ allowed: true, risk: "low", requiresApproval: false });
  expect(engine.evaluate(registry.get("self.upgrade")!, { patch, verification: ["bun", "test"] }, context)).toMatchObject({ risk: "high", requiresApproval: true });
  expect(engine.evaluate(registry.get("self.apply")!, { proposalId: "upgrade-1" }, context)).toMatchObject({ risk: "high", requiresApproval: true });
});

test("does not accept network or package installation as automatic verification", async () => {
  const value = fixture();
  try {
    const upgrade = new SelfUpgrade({ repository: value.repository, approvals: value.approvals, runner: value.runner });
    await expect(upgrade.propose({ workspace: value.workspace, runId: value.runId, patch, verification: ["npx", "dangerous-test"] })).rejects.toThrow(/network|package/i);
  } finally {
    value.close();
  }
});
