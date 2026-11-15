import { expect, test } from "bun:test";
import { highlightCode, normalizeLanguage } from "../ui/src/chat/code-highlighter";

test("normalizes the existing aliases for supported languages", () => {
  const aliases = {
    " JS ": "javascript",
    cjs: "javascript",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
  } as const;

  for (const [alias, language] of Object.entries(aliases)) {
    expect(normalizeLanguage(alias)).toBe(language);
  }
});

test("uses plain text for empty or unsupported language names", () => {
  expect(normalizeLanguage(undefined)).toBeNull();
  expect(normalizeLanguage("   ")).toBeNull();
  expect(normalizeLanguage("emacs-lisp")).toBeNull();
  expect(normalizeLanguage("cpp")).toBeNull();
  expect(normalizeLanguage("rb")).toBeNull();
  expect(normalizeLanguage("ruby")).toBeNull();
});

test("highlights a supported language with github-dark", async () => {
  const highlighted = await highlightCode("const answer = 42;", "javascript");

  expect(highlighted.bg).toBe("#24292e");
  expect(highlighted.tokens.flat().some((token) => token.color !== undefined)).toBeTrue();
});
