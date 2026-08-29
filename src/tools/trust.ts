import type { Tool } from "./types";

const trustedBuiltInTools = new WeakSet<object>();

/** Internal-only branding used by the built-in factories. */
export function markTrustedBuiltIn<T extends Tool>(tool: T): T {
  trustedBuiltInTools.add(tool);
  return tool;
}

export function isTrustedBuiltInTool(tool: object): boolean {
  return trustedBuiltInTools.has(tool);
}
