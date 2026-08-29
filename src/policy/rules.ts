import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ValidationError } from "../errors";
import type { ToolDefinition } from "../protocol/types";
import { resolveWorkspacePath } from "../tools/filesystem";
import type {
  Decision,
  PolicyContext,
  PolicyTool,
  Risk,
} from "./types";

type Rule = { capability: string; risk: Risk };

const knownRules: Readonly<Record<string, Rule>> = {
  "fs.list": { capability: "filesystem", risk: "low" },
  "fs.read": { capability: "filesystem", risk: "low" },
  "search.text": { capability: "filesystem", risk: "low" },
  "fs.write": { capability: "filesystem", risk: "standard" },
  "fs.patch": { capability: "filesystem", risk: "standard" },
  "shell.exec": { capability: "shell", risk: "high" },
  "bun.run": { capability: "process", risk: "high" },
  "network.request": { capability: "network", risk: "high" },
  "network.fetch": { capability: "network", risk: "high" },
  "credentials.read": { capability: "credentials", risk: "high" },
  "credentials.use": { capability: "credentials", risk: "high" },
  "fs.delete": { capability: "destructive", risk: "high" },
  "package.install": { capability: "package-management", risk: "high" },
  "daemon.change": { capability: "service-management", risk: "high" },
  "self.modify": { capability: "self-modification", risk: "high" },
  "self.upgrade": { capability: "self-modification", risk: "high" },
  "self.apply": { capability: "self-modification", risk: "high" },
  "memory.search": { capability: "memory", risk: "low" },
  "memory.save": { capability: "memory", risk: "standard" },
  "schedule.list": { capability: "scheduler", risk: "low" },
  "schedule.create": { capability: "scheduler", risk: "high" },
  "schedule.cancel": { capability: "scheduler", risk: "high" },
};

const pathKeys = new Set([
  "path",
  "paths",
  "file",
  "files",
  "directory",
  "cwd",
  "workingdirectory",
  "targetpath",
  "sourcepath",
  "destinationpath",
  "workspacepath",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function definitionOf(tool: PolicyTool): ToolDefinition | null {
  if (!isRecord(tool)) return null;
  const candidate = Object.hasOwn(tool, "definition") ? (tool as Record<string, unknown>)["definition"] : tool;
  return isRecord(candidate) ? (candidate as ToolDefinition) : null;
}

function validJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJsonValue);
  if (isRecord(value)) return Object.values(value).every(validJsonValue);
  return false;
}

function validateSchemaDefinition(schema: unknown): boolean {
  if (!isRecord(schema) || typeof schema.type !== "string") return false;
  if (!["object", "string", "number", "boolean", "array"].includes(schema.type)) return false;
  if (schema.type === "object") {
    if (schema.properties !== undefined && !isRecord(schema.properties)) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")) return false;
      if (schema.required.some((name) => !Object.hasOwn(properties, name))) return false;
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
    return Object.values(properties).every(validateSchemaDefinition);
  }
  return schema.type !== "array" || validateSchemaDefinition(schema.items);
}

function validateSchema(value: unknown, schema: Record<string, unknown>): string | null {
  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) return "arguments must be an object";
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const name of required) {
      if (typeof name !== "string" || !Object.hasOwn(value, name)) return `missing required argument: ${String(name)}`;
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) return `unknown argument: ${name}`;
      }
    }
    for (const [name, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && isRecord(childSchema)) {
        const error = validateSchema(value[name], childSchema);
        if (error !== null) return `${name}: ${error}`;
      }
    }
    return null;
  }
  if (type === "string" && typeof value !== "string") return "must be a string";
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return "must be a finite number";
  if (type === "boolean" && typeof value !== "boolean") return "must be a boolean";
  if (type === "array" && (!Array.isArray(value) || !isRecord(schema.items))) return "must be an array";
  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    for (const item of value) {
      const error = validateSchema(item, schema.items);
      if (error !== null) return `array item: ${error}`;
    }
  }
  return null;
}

function riskDecision(
  capability: string,
  risk: Risk,
  requiresApproval: boolean,
  reason: string,
  argumentsHash?: string,
): Decision {
  return {
    allowed: !requiresApproval,
    requiresApproval,
    capability,
    risk,
    reason,
    ...(argumentsHash === undefined ? {} : { argumentsHash }),
  };
}

function fail(reason: string, capability = "unknown", risk: Risk = "high"): Decision {
  return { allowed: false, requiresApproval: false, capability, risk, reason };
}

function isWithin(workspace: string, candidate: string): boolean {
  const remainder = relative(workspace, candidate);
  return remainder === "" || (!remainder.startsWith(`..${sep}`) && remainder !== ".." && !isAbsolute(remainder));
}

function pathValues(value: unknown, key = ""): string[] {
  if (typeof value === "string" && pathKeys.has(key.toLowerCase())) return [value];
  if (Array.isArray(value) && pathKeys.has(key.toLowerCase())) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([childKey, child]) => pathValues(child, childKey));
  }
  return [];
}

type PatchFacts = { paths: string[]; deletes: boolean; malformed: boolean };

function patchFacts(value: unknown): PatchFacts {
  if (typeof value !== "string") return { paths: [], deletes: false, malformed: true };
  const lines = value.replace(/\r\n/gu, "\n").split("\n");
  const paths: string[] = [];
  let deletes = false;
  let malformed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const oldHeader = lines[index];
    if (!oldHeader?.startsWith("--- ")) continue;
    const oldPath = oldHeader.slice(4).split("\t", 1)[0]!.trim();
    const newHeader = lines[index + 1];
    if (!newHeader?.startsWith("+++ ")) {
      continue;
    }
    const newPath = newHeader.slice(4).split("\t", 1)[0]!.trim();
    index += 1;
    if (oldPath.length === 0 || newPath.length === 0) {
      malformed = true;
      continue;
    }
    if (oldPath !== "/dev/null") paths.push(oldPath.replace(/^[ab]\//u, ""));
    if (newPath === "/dev/null") {
      deletes = true;
    } else {
      paths.push(newPath.replace(/^[ab]\//u, ""));
    }
  }
  if (paths.length === 0) malformed = true;
  return { paths, deletes, malformed };
}

function patchPathValues(value: unknown): string[] {
  return patchFacts(value).paths;
}

function hasExternalPath(args: Record<string, unknown>, workspace: string): boolean {
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(workspace);
    if (!statSync(workspaceRoot).isDirectory()) return true;
  } catch {
    return true;
  }

  for (const requested of [...pathValues(args), ...patchPathValues(args.patch)]) {
    if (requested.length === 0 || requested.includes("\0")) return true;
    const candidate = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
    if (!isWithin(workspaceRoot, candidate)) return true;
    try {
      // Existing tool paths must pass the same symlink-aware resolver used at execution.
      resolveWorkspacePath(workspaceRoot, candidate);
    } catch {
      return true;
    }
  }
  return false;
}

function selfModifying(definition: ToolDefinition, args: Record<string, unknown>, context: PolicyContext): boolean {
  const capability = definition.capability.toLowerCase().replace(/_/gu, "-");
  if (capability === "self-modification" || capability === "self") return true;
  if (definition.name.startsWith("self.")) return true;
  if (args.selfModifying === true || args.selfModification === true) return true;
  const operation = args.operation;
  if (typeof operation === "string" && /self[- ]?modif|upgrade|apply/iu.test(operation)) return true;
  if (context.selfPaths !== undefined) {
    const workspace = context.workspace;
    if (workspace !== undefined) {
      try {
        const root = realpathSync(workspace);
        const candidates = [...pathValues(args), ...patchPathValues(args.patch)];
        return context.selfPaths.some((path) => {
          const configured = isAbsolute(path) ? resolve(path) : resolve(root, path);
          return isWithin(root, configured) && candidates.some((candidate) => {
            const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
            return target === configured || isWithin(configured, target);
          });
        });
      } catch {
        return true;
      }
    }
  }
  return false;
}

function commandSignalsRisk(args: Record<string, unknown>): string | null {
  const argv = Array.isArray(args.argv) && args.argv.every((value) => typeof value === "string")
    ? args.argv.join(" ")
    : undefined;
  const command = [args.command, args.cmd, args.script, argv].find((value) => typeof value === "string");
  if (typeof command !== "string") return null;
  if (/(^|\s)(curl|wget|nc|netcat|ssh|scp)(\s|$)/iu.test(command)) return "network access";
  if (/(^|\s)(rm\s+-(?:[^\s]*r|[^\s]*f[^\s]*r)|find\b[^\n]*-delete)(\s|$)/iu.test(command)) return "destructive deletion";
  if (/(npm|pnpm|yarn|bun|pip|brew)\s+(install|add)(\s|$)/iu.test(command)) return "package installation";
  if (/(^|\s)(env|printenv|security|pass)(\s|$)/iu.test(command) || /\.(env|pem|key)(\b|$)/iu.test(command)) return "credential access";
  return null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new ValidationError("tool arguments must contain only JSON values");
}

export function hashToolCall(toolName: string, args: Record<string, unknown>): string {
  if (typeof toolName !== "string" || toolName.length === 0) throw new ValidationError("tool name must be non-empty");
  const payload = canonicalJson({ arguments: args, tool: toolName });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export class PolicyEngine {
  evaluate(tool: PolicyTool, args: Record<string, unknown>, context: PolicyContext): Decision {
    const definition = definitionOf(tool);
    if (definition === null) return fail("tool metadata is not an object");
    if (typeof definition.name !== "string" || definition.name.length === 0) return fail("tool name is invalid");
    if (typeof definition.capability !== "string" || definition.capability.length === 0) return fail("tool capability metadata is invalid");

    const rule = knownRules[definition.name];
    if (rule === undefined) return fail(`unknown tool is denied: ${definition.name}`, definition.capability);
    if (definition.capability !== rule.capability) {
      return fail(`tool capability metadata does not match ${definition.name}`, definition.capability);
    }
    if (!validateSchemaDefinition(definition.inputSchema)) return fail(`tool schema is invalid: ${definition.name}`, rule.capability);
    if (!isRecord(args) || !validJsonValue(args)) return fail("tool arguments are not valid JSON", rule.capability);
    const schemaError = validateSchema(args, definition.inputSchema);
    if (schemaError !== null) return fail(`tool arguments are invalid: ${schemaError}`, rule.capability);
    if (context.workspace === undefined || typeof context.workspace !== "string" || context.workspace.length === 0) {
      return fail("workspace context is required", rule.capability);
    }

    const argumentsHash = hashToolCall(definition.name, args);
    const patch = definition.name === "fs.patch" ? patchFacts(args.patch) : null;
    if (patch?.malformed) return fail("patch paths are malformed", rule.capability);
    if (patch?.deletes) {
      return riskDecision("destructive", "high", true, "patch deletion requires approval", argumentsHash);
    }
    if (hasExternalPath(args, context.workspace)) {
      return riskDecision(rule.capability, "high", true, "path is outside the workspace or contains an unsafe symlink", argumentsHash);
    }
    if (selfModifying(definition, args, context)) {
      return riskDecision("self-modification", "high", true, "self-modifying operation requires approval", argumentsHash);
    }
    const signal = commandSignalsRisk(args);
    if (signal !== null) {
      return riskDecision(rule.capability, "high", true, `${signal} requires approval`, argumentsHash);
    }
    if (rule.risk === "high") {
      return riskDecision(rule.capability, "high", true, `${definition.name} requires explicit approval`, argumentsHash);
    }
    if (rule.risk === "standard") {
      return riskDecision(rule.capability, "standard", false, "workspace-scoped write is automatic and logged", argumentsHash);
    }
    return riskDecision(rule.capability, "low", false, "bounded read/search is automatic and logged", argumentsHash);
  }
}

export function classifyTool(tool: PolicyTool, args: Record<string, unknown>, context: PolicyContext): Decision {
  return new PolicyEngine().evaluate(tool, args, context);
}

export const evaluateToolCall = classifyTool;
