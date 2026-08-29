import { basename } from "node:path";

const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key)|.*credentials(?:\..*)?)$/iu;
const SECRET_ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|authorization)\b\s*[:=]\s*)(["']?)([^\s"']{8,})(\2)/giu;
const BEARER = /\bBearer\s+[^\s,;]+/giu;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/gu;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu;
const OPENAI_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

export function isSensitivePath(path: string): boolean {
  return path.replaceAll("\\", "/").split("/").some((component) => SENSITIVE_FILE.test(component));
}

function applyPattern(value: string, pattern: string | RegExp): string {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    return value.replace(new RegExp(pattern.source, flags), "[REDACTED]");
  }
  return pattern.length === 0 ? value : value.split(pattern).join("[REDACTED]");
}

export function redactSecrets(value: string, patterns: readonly (string | RegExp)[] = []): string {
  let redacted = value
    .replace(SECRET_ASSIGNMENT, "$1$2[REDACTED]$2")
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(AWS_ACCESS_KEY, "[REDACTED]")
    .replace(GITHUB_TOKEN, "[REDACTED]")
    .replace(OPENAI_TOKEN, "[REDACTED]")
    .replace(JWT, "[REDACTED]");
  for (const pattern of patterns) redacted = applyPattern(redacted, pattern);
  return redacted;
}

export function redactUnknown(value: unknown, patterns: readonly (string | RegExp)[] = [], depth = 0): unknown {
  if (depth > 8) return "[REDACTED]";
  if (typeof value === "string") return redactSecrets(value, patterns);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, patterns, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactUnknown(entry, patterns, depth + 1)]));
  }
  return value;
}

export function relativeSensitivePath(path: string): string {
  return basename(path.replaceAll("\\", "/"));
}
