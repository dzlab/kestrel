import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ApprovalRequiredError, ToolExecutionError, ValidationError } from "../errors";
import { hashToolCall } from "../policy/rules";
import { runProcess, MAX_PROCESS_TIMEOUT_MS } from "../runtime/process";
import { createFilesystemTools } from "../tools/filesystem";
import {
  closeSecureFile,
  closeSecureParent,
  openPatchTarget,
  openSecureParent,
  readSecureFileText,
  revalidateSecureParent,
  unlinkAt,
  writeWorkspaceText,
} from "../tools/secure-fs";
import type { ToolContext } from "../tools/types";
import { truncateUtf8 } from "../tools/types";
import type {
  SelfUpgradeOptions,
  UpgradeApplyInput,
  UpgradeApplyResult,
  UpgradeProposal,
  UpgradeProposeInput,
  UpgradeRunner,
  UpgradeRunnerResult,
} from "./types";
import {
  MAX_UPGRADE_PATCH_BYTES,
  MAX_UPGRADE_TARGETS,
  MAX_UPGRADE_VERIFICATION_MS,
  SYNTHETIC_UPGRADE_APPROVAL_STATE,
  syntheticUpgradeApprovalCallId,
} from "./types";

const MAX_FILE_BYTES = 64 * 1024;
const SAFE_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const defaultSelfPath = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function within(root: string, candidate: string): boolean {
  const rest = relative(root, candidate);
  return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bounded(value: string, limit: number, label: string): string {
  if (Buffer.byteLength(value, "utf8") > limit) throw new ValidationError(`${label} exceeds the bounded limit`);
  return value;
}

function normalizePatchPath(value: string): string {
  const token = value.trim().split("\t", 1)[0]!;
  if (token === "/dev/null") return token;
  const path = token.replace(/^[ab]\//u, "");
  if (path.length === 0 || path.includes("\0") || path.split(/[\\/]+/u).includes("..")) {
    throw new ValidationError("upgrade patch contains an unsafe target path");
  }
  return path;
}

function targetFilesFromPatch(patch: string): string[] {
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  const paths = new Set<string>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index]!.startsWith("--- ") || !lines[index + 1]!.startsWith("+++ ")) continue;
    const oldPath = normalizePatchPath(lines[index]!.slice(4));
    const newPath = normalizePatchPath(lines[index + 1]!.slice(4));
    const target = newPath === "/dev/null" ? oldPath : newPath;
    if (target === "/dev/null") throw new ValidationError("upgrade patch must target a file");
    paths.add(target);
    index += 1;
  }
  if (paths.size === 0) throw new ValidationError("upgrade patch contains no file headers");
  if (paths.size > MAX_UPGRADE_TARGETS) throw new ValidationError(`upgrade patch targets more than ${MAX_UPGRADE_TARGETS} files`);
  return [...paths].sort();
}

function defaultRunner(): UpgradeRunner {
  return {
    async run(argv, cwd, timeoutMs = 30_000, signal): Promise<UpgradeRunnerResult> {
      return runProcess({ argv, cwd, timeoutMs, env: { PATH: SAFE_PATH, PWD: cwd }, signal });
    },
  };
}

function executableName(value: string): string {
  return basename(value.replaceAll("\\", "/")).toLowerCase();
}

function validateVerification(argv: readonly string[], timeoutMs: number): string[] {
  if (argv.length === 0 || argv.length > 32 || argv.some((argument) => typeof argument !== "string" || argument.length === 0)) {
    throw new ValidationError("verification must be a bounded non-empty argv");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_UPGRADE_VERIFICATION_MS || timeoutMs > MAX_PROCESS_TIMEOUT_MS) {
    throw new ValidationError(`verification timeout must be between 1 and ${MAX_UPGRADE_VERIFICATION_MS}ms`);
  }
  const joined = argv.join(" ");
  if (["sh", "bash", "zsh", "dash", "fish", "pwsh", "powershell", "cmd", "cmd.exe"].includes(executableName(argv[0]!))) {
    throw new ValidationError("verification cannot invoke a shell launcher");
  }
  if (argv.some((argument) => ["-c", "-Command", "&&", "||", ";", "|", ">", "<"].includes(argument))) {
    throw new ValidationError("verification argv contains a shell operator");
  }
  if (/(^|\s)(curl|wget|nc|netcat|ssh|scp|npx)\b/iu.test(joined)) throw new ValidationError("verification cannot access the network");
  const executable = executableName(argv[0]!);
  const operation = argv[1]?.toLowerCase();
  if (
    (executable === "git" && ["fetch", "pull", "push", "clone"].includes(operation ?? "")) ||
    (["npm", "pnpm", "yarn", "pip", "brew"].includes(executable) && ["install", "add", "exec", "x", "dlx", "update", "upgrade", "remove"].includes(operation ?? "")) ||
    (executable === "bun" && ["install", "add", "x", "create", "update", "remove"].includes(operation ?? ""))
  ) {
    throw new ValidationError("verification cannot fetch or install packages");
  }
  return [...argv];
}

type Snapshot = Map<string, string | null>;

function snapshot(workspace: string, targetFiles: readonly string[]): Snapshot {
  const result: Snapshot = new Map();
  for (const file of targetFiles) {
    const path = resolve(workspace, file);
    let parent: ReturnType<typeof openSecureParent> | null = null;
    let target: number | null = null;
    try {
      parent = openSecureParent(workspace, path, false);
      target = openPatchTarget(parent);
      if (target === null) {
        result.set(file, null);
        continue;
      }
      const read = readSecureFileText(target);
      if (read.truncated || Buffer.byteLength(read.content, "utf8") > MAX_FILE_BYTES) {
        throw new ValidationError(`upgrade target is too large: ${file}`);
      }
      result.set(file, read.content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") result.set(file, null);
      else throw error;
    } finally {
      if (target !== null) closeSecureFile(target);
      if (parent !== null) closeSecureParent(parent);
    }
  }
  return result;
}

function snapshotHash(snapshotValue: Snapshot): string {
  const hash = createHash("sha256");
  for (const [path, content] of [...snapshotValue.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(path).update("\0").update(content === null ? "<missing>" : content).update("\0");
  }
  return hash.digest("hex");
}

function snapshotForWorkspace(workspace: string, targetFiles: readonly string[]): Snapshot {
  return snapshot(workspace, targetFiles);
}

function payloadProposal(value: unknown): UpgradeProposal | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.status !== "string") return null;
  return value as unknown as UpgradeProposal;
}

function resultError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundRunnerResult(result: UpgradeRunnerResult): UpgradeRunnerResult {
  return {
    ...result,
    stdout: truncateUtf8(result.stdout, 64 * 1024),
    stderr: truncateUtf8(result.stderr, 64 * 1024),
  };
}

export class SelfUpgrade {
  private readonly repository: SelfUpgradeOptions["repository"];
  private readonly approvals: SelfUpgradeOptions["approvals"];
  private readonly runner: UpgradeRunner;
  private readonly now: () => number;
  private readonly selfPaths: readonly string[];

  constructor(options: SelfUpgradeOptions) {
    this.repository = options.repository;
    this.approvals = options.approvals;
    this.runner = options.runner ?? defaultRunner();
    this.now = options.now ?? (() => Date.now());
    this.selfPaths = options.selfPaths ?? [defaultSelfPath];
  }

  async propose(input: UpgradeProposeInput): Promise<UpgradeProposal> {
    const workspace = this.workspaceRoot(input.workspace);
    const patch = bounded(input.patch, MAX_UPGRADE_PATCH_BYTES, "upgrade patch");
    const targetFiles = targetFilesFromPatch(patch);
    const verificationTimeoutMs = input.verificationTimeoutMs ?? 30_000;
    const verification = validateVerification(input.verification, verificationTimeoutMs);
    const targets = this.resolveTargets(workspace, targetFiles);
    const before = snapshotForWorkspace(workspace, targetFiles);
    const baseRevision = (await this.gitText(["git", "rev-parse", "HEAD"], workspace, "git revision")).trim();
    const repoStateHash = await this.repoStateHash(workspace);
    const id = `upgrade-${randomUUID()}`;
    const patchHash = sha256(patch);
    const approvalArguments = { proposalId: id };
    const approvalId = syntheticUpgradeApprovalCallId(id);
    this.repository.recordToolCall(input.runId, { id: approvalId, name: "self.apply", arguments: approvalArguments }, SYNTHETIC_UPGRADE_APPROVAL_STATE);
    const approval = this.approvals.request({
      id: approvalId,
      runId: input.runId,
      tool: "self.apply",
      capability: "self-modification",
      risk: "high",
      summary: `Apply self-upgrade proposal ${id}`,
      arguments: approvalArguments,
      createdAt: this.now(),
    });
    const proposal: UpgradeProposal = {
      id,
      workspace,
      runId: input.runId,
      baseRevision,
      baseHash: snapshotHash(before),
      repoStateHash,
      targetFiles: targets,
      patch,
      patchHash,
      verification,
      verificationTimeoutMs,
      selfTarget: this.isSelfTarget(workspace, targets),
      status: "proposed",
      createdAt: this.now(),
      approval: { id: approval.id, argumentsHash: approval.argumentsHash, status: approval.status },
    };
    this.repository.appendEvent(input.runId, "upgrade.proposed", proposal);
    return proposal;
  }

  status(runId: string, proposalId?: string): UpgradeProposal | null {
    const events = this.repository.getEvents(runId);
    let latest: UpgradeProposal | null = null;
    for (const event of events) {
      if (event.type !== "upgrade.proposed" && event.type !== "upgrade.status") continue;
      const candidate = payloadProposal(event.payload);
      if (candidate !== null && (proposalId === undefined || candidate.id === proposalId)) latest = candidate;
    }
    if (latest === null) return null;
    if (latest.status !== "proposed") return latest;
    const approval = this.approvals.get(latest.approval.id);
    return approval === null
      ? latest
      : { ...latest, approval: { ...latest.approval, status: approval.status } };
  }

  async apply(input: UpgradeApplyInput): Promise<UpgradeApplyResult> {
    const proposal = this.status(input.runId, input.proposalId);
    if (proposal === null) throw new ValidationError(`upgrade proposal was not found: ${input.proposalId}`);
    if (proposal.workspace !== this.workspaceRoot(input.workspace)) throw new ValidationError("upgrade workspace does not match proposal");
    if (proposal.status !== "proposed") throw new ValidationError(`upgrade proposal is already ${proposal.status}`);
    const targets = this.resolveTargets(proposal.workspace, targetFilesFromPatch(proposal.patch));
    if (sha256(proposal.patch) !== proposal.patchHash || targets.join("\0") !== proposal.targetFiles.join("\0")) {
      throw new ValidationError("upgrade proposal is invalid or tampered");
    }
    if (proposal.selfTarget !== this.isSelfTarget(proposal.workspace, targets)) {
      throw new ValidationError("upgrade self-target metadata is invalid");
    }

    const current = await this.currentState(proposal);
    if (current.baseRevision !== proposal.baseRevision || current.repoStateHash !== proposal.repoStateHash || current.baseHash !== proposal.baseHash) {
      this.recordStatus({ ...proposal, status: "stale", error: "workspace or target changed since proposal" });
      throw new ValidationError("upgrade proposal is stale: workspace or target changed");
    }
    const approvalArguments = { proposalId: proposal.id };
    const approvalRecord = this.approvals.get(proposal.approval.id);
    if (proposal.approval.status === "cancelled" || approvalRecord?.status === "cancelled") {
      throw new ToolExecutionError(`approval was cancelled for upgrade ${proposal.id}`);
    }
    const callerApproval = this.callerApproval(input, approvalArguments);
    const approvalConsumedByCaller = callerApproval !== null;
    const syntheticCall = this.repository.getToolCall(proposal.approval.id);
    if (!approvalConsumedByCaller && approvalRecord?.status === "consumed" && syntheticCall?.state === "executing") {
      throw new ToolExecutionError("an unfinished self-upgrade cannot be replayed safely");
    }
    const approved = approvalConsumedByCaller || (approvalRecord?.status === "approved"
      ? this.approvals.consume({ id: proposal.approval.id, tool: "self.apply", arguments: approvalArguments }, undefined, this.now(), input.runId)
      : false);
    if (!approved) {
      throw new ApprovalRequiredError(`approval required for upgrade ${proposal.id}`);
    }

    if (input.signal?.aborted) throw new ToolExecutionError("upgrade application cancelled");
    if (!approvalConsumedByCaller) this.repository.updateToolCallState(proposal.runId, proposal.approval.id, "executing");

    this.recordStatus({ ...proposal, status: "applying", approval: { ...proposal.approval, status: "consumed" } });
    const before = snapshotForWorkspace(proposal.workspace, proposal.targetFiles);
    const beforeHash = snapshotHash(before);
    const patchTool = createFilesystemTools().find((tool) => tool.definition.name === "fs.patch");
    if (patchTool === undefined) throw new ToolExecutionError("atomic patch tool is unavailable");
    let patchApplied = false;
    let after: Snapshot | null = null;
    try {
      const toolContext: ToolContext = { workspace: proposal.workspace, runId: input.runId, repository: this.repository, signal: input.signal } as ToolContext;
      const patchResult = await patchTool.execute({ patch: proposal.patch }, toolContext);
      if (!patchResult.ok) throw new ToolExecutionError(`upgrade patch failed: ${patchResult.content}`);
      patchApplied = true;
      const verification = boundRunnerResult(await this.runner.run(proposal.verification, proposal.workspace, proposal.verificationTimeoutMs, input.signal));
      after = snapshotForWorkspace(proposal.workspace, proposal.targetFiles);
      const afterHash = snapshotHash(after);
      if (verification.exitCode !== 0 || verification.timedOut === true || verification.aborted === true) {
        await this.restore(proposal.workspace, before, after);
        const failed = { ...proposal, status: "failed" as const, beforeHash, afterHash, verificationResult: verification, approval: { ...proposal.approval, status: "consumed" as const }, error: "verification failed" };
        this.recordStatus(failed);
        throw new ToolExecutionError(`upgrade verification failed: ${verification.stderr || verification.stdout || `exit code ${String(verification.exitCode)}`}`);
      }
      const applied: UpgradeApplyResult = { ...proposal, status: "applied", beforeHash, afterHash, verificationResult: verification, approval: { ...proposal.approval, status: "consumed" } };
      this.recordStatus(applied);
      if (!approvalConsumedByCaller) this.repository.finishToolCall(proposal.runId, proposal.approval.id, applied, "completed");
      return applied;
    } catch (error) {
      if (error instanceof ToolExecutionError && /verification failed/u.test(error.message)) throw error;
      let rollbackError: string | undefined;
      if (patchApplied) {
        try {
          after ??= snapshotForWorkspace(proposal.workspace, proposal.targetFiles);
          await this.restore(proposal.workspace, before, after);
        } catch (rollbackFailure) {
          rollbackError = resultError(rollbackFailure);
        }
      }
      const failed = {
        ...proposal,
        status: "failed" as const,
        approval: { ...proposal.approval, status: "consumed" as const },
        error: rollbackError === undefined ? resultError(error) : `${resultError(error)}; rollback failed: ${rollbackError}`,
      };
      this.recordStatus(failed);
      if (!approvalConsumedByCaller) this.repository.finishToolCall(proposal.runId, proposal.approval.id, failed, "failed");
      throw error;
    }
  }

  private workspaceRoot(workspace: string): string {
    if (typeof workspace !== "string" || workspace.length === 0) throw new ValidationError("upgrade workspace is required");
    const root = resolve(workspace);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new ValidationError("upgrade workspace must be a directory");
    return realpathSync(root);
  }

  private callerApproval(input: UpgradeApplyInput, argumentsValue: Record<string, unknown>): { callId: string } | null {
    if (input.approvalConsumed !== true || input.approvalId === undefined) return null;
    const approval = this.approvals.get(input.approvalId);
    const call = this.repository.getToolCall(input.approvalId);
    if (
      approval?.status !== "consumed" ||
      approval.runId !== input.runId ||
      approval.tool !== "self.apply" ||
      approval.argumentsHash !== hashToolCall("self.apply", argumentsValue) ||
      call?.runId !== input.runId ||
      call.name !== "self.apply" ||
      call.state !== "executing" ||
      hashToolCall(call.name, call.arguments) !== approval.argumentsHash
    ) return null;
    return { callId: input.approvalId };
  }

  private resolveTargets(workspace: string, targetFiles: readonly string[]): string[] {
    for (const file of targetFiles) {
      const target = resolve(workspace, file);
      if (!within(workspace, target)) throw new ValidationError("upgrade target is outside the workspace");
      const dataDirectory = process.env.KESTREL_DATA_DIR;
      if (target.split(sep).includes(".kestrel") || (dataDirectory !== undefined && within(resolve(dataDirectory), target))) {
        throw new ValidationError("upgrade cannot modify the Kestrel data directory");
      }
    }
    return [...targetFiles];
  }

  private isSelfTarget(workspace: string, targetFiles: readonly string[]): boolean {
    return this.selfPaths.some((configured) => {
      const requested = isAbsolute(configured) ? resolve(configured) : resolve(workspace, configured);
      const path = existsSync(requested) ? realpathSync(requested) : requested;
      return targetFiles.some((file) => within(path, resolve(workspace, file)));
    });
  }

  private async gitText(argv: readonly string[], cwd: string, label: string, allowEmpty = false): Promise<string> {
    const result = await this.runner.run(argv, cwd, 30_000);
    if (result.exitCode !== 0 || result.timedOut === true || result.aborted === true) {
      throw new ValidationError(`${label} failed: ${result.stderr || result.stdout || `exit code ${String(result.exitCode)}`}`);
    }
    if (!allowEmpty && result.stdout.trim().length === 0) throw new ValidationError(`${label} returned no output`);
    return bounded(result.stdout, 64 * 1024, label);
  }

  private async currentState(proposal: UpgradeProposal): Promise<{ baseRevision: string; repoStateHash: string; baseHash: string }> {
    const baseRevision = (await this.gitText(["git", "rev-parse", "HEAD"], proposal.workspace, "git revision")).trim();
    const repoStateHash = await this.repoStateHash(proposal.workspace);
    const current = snapshotForWorkspace(proposal.workspace, proposal.targetFiles);
    return { baseRevision, repoStateHash, baseHash: snapshotHash(current) };
  }

  private async repoStateHash(workspace: string): Promise<string> {
    const status = await this.gitText(["git", "status", "--short", "--untracked-files=all"], workspace, "git status", true);
    const diff = await this.gitText(["git", "diff", "--no-ext-diff", "HEAD", "--"], workspace, "git diff", true);
    return sha256(`${status}\0${diff}`);
  }

  private async restore(workspace: string, before: Snapshot, after: Snapshot): Promise<void> {
    for (const [file, original] of before) {
      const current = after.get(file);
      if (current === original) continue;
      const path = resolve(workspace, file);
      const currentNow = snapshot(workspace, [file]).get(file);
      if (currentNow !== current) throw new ToolExecutionError(`rollback target changed: ${file}`);
      if (original !== null) {
        writeWorkspaceText(workspace, path, original);
        continue;
      }
      const parent = openSecureParent(workspace, path, false);
      try {
        revalidateSecureParent(workspace, parent);
        const target = openPatchTarget(parent);
        if (target === null) continue;
        try {
          const text = readSecureFileText(target);
          if (text.truncated || text.content !== current) throw new ToolExecutionError(`rollback target changed: ${file}`);
          unlinkAt(parent, parent.name);
        } finally {
          closeSecureFile(target);
        }
      } finally {
        closeSecureParent(parent);
      }
    }
  }

  private recordStatus(proposal: UpgradeProposal): void {
    this.repository.appendEvent(proposal.runId, "upgrade.status", proposal);
  }
}
