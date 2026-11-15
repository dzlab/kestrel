import { createHash } from "node:crypto";

export function approvalHandle(conversationId: string, runId: string, callId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([conversationId, runId, callId]))
    .digest("hex");
}

export function isApprovalHandle(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}
