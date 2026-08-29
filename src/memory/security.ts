import { ValidationError } from "../errors";

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|credential|token)\s*[:=]\s*\S+/iu,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/u,
];

const injectionPatterns: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|earlier)\s+instructions\b/iu,
  /\b(?:reveal|print|exfiltrate|disclose|leak)\b[^\n]{0,100}\b(?:system|developer)\s+prompt\b/iu,
  /\b(?:system|developer)\s+prompt\b[^\n]{0,100}\b(?:reveal|print|ignore|follow)\b/iu,
  /\b(?:call|execute|run)\s+(?:a\s+)?tool\b[^\n]{0,100}\b(?:without|bypass|skip)\b/iu,
];

function valueContains(value: string, patterns: readonly (string | RegExp)[]): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return value.includes(pattern);
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function assertSafeMemory(content: string, tags: readonly string[], extraPatterns: readonly (string | RegExp)[] = []): void {
  const value = [content, ...tags].join("\n");
  if (value.includes("\0") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new ValidationError("memory contains unsupported control characters");
  }
  if (valueContains(value, [...secretPatterns, ...extraPatterns])) {
    throw new ValidationError("memory cannot contain secrets or credentials");
  }
  if (valueContains(value, injectionPatterns)) {
    throw new ValidationError("memory cannot contain sensitive prompt-injection instructions");
  }
}
