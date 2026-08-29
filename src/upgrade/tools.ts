import { ApprovalManager } from "../policy/approvals";
import { markTrustedBuiltIn } from "../tools/trust";
import type { Tool, ToolContext, ToolResult } from "../tools/types";
import { SelfUpgrade } from "./workflow";

function failure(error: unknown): ToolResult {
  return { ok: false, content: error instanceof Error ? error.message : String(error) };
}

export function createUpgradeTools(approvals?: ApprovalManager): Tool[] {
  const upgradeTool: Tool = markTrustedBuiltIn({
    definition: {
      name: "self.upgrade",
      description: "Propose a bounded, verified Kestrel source patch without applying it.",
      capability: "self-modification",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string" },
          verification: { type: "array", items: { type: "string" } },
          verificationTimeoutMs: { type: "number" },
        },
        required: ["patch", "verification"],
        additionalProperties: false,
      },
    },
    async execute(args, context) {
      try {
        const verification = args.verification;
        if (!Array.isArray(verification) || verification.some((value) => typeof value !== "string")) {
          return failure(new Error("verification must be an argv array"));
        }
        const proposal = await new SelfUpgrade({
          repository: context.repository,
          approvals: approvals ?? new ApprovalManager(),
        }).propose({
          workspace: context.workspace,
          runId: context.runId,
          patch: String(args.patch),
          verification,
          verificationTimeoutMs: typeof args.verificationTimeoutMs === "number" ? args.verificationTimeoutMs : undefined,
        });
        return { ok: true, content: `proposed ${proposal.id}`, data: proposal };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const applyTool: Tool = markTrustedBuiltIn({
    definition: {
      name: "self.apply",
      description: "Apply one approved Kestrel upgrade proposal and verify it.",
      capability: "self-modification",
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        required: ["proposalId"],
        additionalProperties: false,
      },
    },
    async execute(args, context) {
      try {
        const result = await new SelfUpgrade({
          repository: context.repository,
          approvals: approvals ?? new ApprovalManager(),
        }).apply({
          workspace: context.workspace,
          runId: context.runId,
          proposalId: String(args.proposalId),
        });
        return { ok: true, content: `applied ${result.id}`, data: result };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const statusTool: Tool = markTrustedBuiltIn({
    definition: {
      name: "self.status",
      description: "Read the durable status of a Kestrel upgrade proposal.",
      capability: "self-inspection",
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        additionalProperties: false,
      },
    },
    async execute(args, context) {
      try {
        const proposal = new SelfUpgrade({
          repository: context.repository,
          approvals: approvals ?? new ApprovalManager(),
        }).status(context.runId, typeof args.proposalId === "string" ? args.proposalId : undefined);
        return { ok: proposal !== null, content: proposal === null ? "upgrade proposal not found" : proposal.status, data: proposal };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const inspectTool: Tool = markTrustedBuiltIn({
    definition: {
      name: "self.inspect",
      description: "Inspect the bounded durable status of a Kestrel upgrade proposal.",
      capability: "self-inspection",
      inputSchema: {
        type: "object",
        properties: { proposalId: { type: "string" } },
        additionalProperties: false,
      },
    },
    async execute(args, context) {
      try {
        const proposal = new SelfUpgrade({
          repository: context.repository,
          approvals: approvals ?? new ApprovalManager(),
        }).status(context.runId, typeof args.proposalId === "string" ? args.proposalId : undefined);
        return { ok: proposal !== null, content: proposal === null ? "upgrade proposal not found" : proposal.status, data: proposal };
      } catch (error) {
        return failure(error);
      }
    },
  });

  return [upgradeTool, applyTool, statusTool, inspectTool];
}
