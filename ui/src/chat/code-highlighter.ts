import type { HighlighterCore, LanguageRegistration, TokensResult } from "shiki/core";

const LANGUAGE_LOADERS = {
  bash: () => import("shiki/langs/bash.mjs").then((module) => module.default),
  c: () => import("shiki/langs/c.mjs").then((module) => module.default),
  css: () => import("shiki/langs/css.mjs").then((module) => module.default),
  diff: () => import("shiki/langs/diff.mjs").then((module) => module.default),
  docker: () => import("shiki/langs/docker.mjs").then((module) => module.default),
  go: () => import("shiki/langs/go.mjs").then((module) => module.default),
  html: () => import("shiki/langs/html.mjs").then((module) => module.default),
  java: () => import("shiki/langs/java.mjs").then((module) => module.default),
  javascript: () => import("shiki/langs/javascript.mjs").then((module) => module.default),
  json: () => import("shiki/langs/json.mjs").then((module) => module.default),
  jsx: () => import("shiki/langs/jsx.mjs").then((module) => module.default),
  markdown: () => import("shiki/langs/markdown.mjs").then((module) => module.default),
  python: () => import("shiki/langs/python.mjs").then((module) => module.default),
  rust: () => import("shiki/langs/rust.mjs").then((module) => module.default),
  sql: () => import("shiki/langs/sql.mjs").then((module) => module.default),
  toml: () => import("shiki/langs/toml.mjs").then((module) => module.default),
  tsx: () => import("shiki/langs/tsx.mjs").then((module) => module.default),
  typescript: () => import("shiki/langs/typescript.mjs").then((module) => module.default),
  xml: () => import("shiki/langs/xml.mjs").then((module) => module.default),
  yaml: () => import("shiki/langs/yaml.mjs").then((module) => module.default),
} as const satisfies Record<string, () => Promise<LanguageRegistration[]>>;

export type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;

const LANGUAGE_ALIASES: Readonly<Record<string, SupportedLanguage>> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

let highlighterPromise: Promise<HighlighterCore> | undefined;
const languageLoads = new Map<SupportedLanguage, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, { default: githubDark }]) => (
    createHighlighterCore({
      engine: createJavaScriptRegexEngine(),
      langs: [],
      themes: [githubDark],
    })
  ));
  return highlighterPromise;
}

function loadLanguage(instance: HighlighterCore, language: SupportedLanguage): Promise<void> {
  const existing = languageLoads.get(language);
  if (existing !== undefined) return existing;

  const pending = LANGUAGE_LOADERS[language]().then((registration) => instance.loadLanguage(registration));
  languageLoads.set(language, pending);
  void pending.catch(() => languageLoads.delete(language));
  return pending;
}

export function normalizeLanguage(language: string | undefined): SupportedLanguage | null {
  if (language === undefined || language.trim().length === 0) return null;
  const requested = language.trim().toLowerCase();
  const normalized = LANGUAGE_ALIASES[requested] ?? requested;
  return normalized in LANGUAGE_LOADERS ? normalized as SupportedLanguage : null;
}

export async function highlightCode(code: string, language: SupportedLanguage): Promise<TokensResult> {
  const instance = await highlighter();
  await loadLanguage(instance, language);
  return instance.codeToTokens(code, { lang: language, theme: "github-dark" });
}
