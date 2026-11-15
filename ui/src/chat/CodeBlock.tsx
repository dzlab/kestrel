import { useEffect, useMemo, useState } from "react";
import { Check, Copy, WrapText } from "lucide-react";
import { bundledLanguages, createHighlighter, type BundledLanguage } from "shiki";

type HighlightedCode = ReturnType<Awaited<ReturnType<typeof createHighlighter>>["codeToTokens"]>;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};

let highlighterPromise: ReturnType<typeof createHighlighter> | undefined;

function highlighter() {
  highlighterPromise ??= createHighlighter({ themes: ["github-dark"], langs: [] });
  return highlighterPromise;
}

function normalizedLanguage(language: string | undefined): BundledLanguage | null {
  if (language === undefined || language.trim().length === 0) return null;
  const requested = language.trim().toLowerCase();
  const normalized = LANGUAGE_ALIASES[requested] ?? requested;
  return normalized in bundledLanguages ? normalized as BundledLanguage : null;
}

export function CodeBlock({ code, language }: Readonly<{ code: string; language?: string }>) {
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const normalized = useMemo(() => normalizedLanguage(language), [language]);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    if (normalized === null) return () => { active = false; };
    void (async () => {
      try {
        const instance = await highlighter();
        await instance.loadLanguage(normalized);
        const tokens = instance.codeToTokens(code, { lang: normalized, theme: "github-dark" });
        if (active) setHighlighted(tokens);
      } catch {
        // A readable plain-text block remains visible when a grammar cannot load.
      }
    })();
    return () => { active = false; };
  }, [code, normalized]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language?.trim() || "plain text"}</span>
        <div>
          <button type="button" className={wrap ? "active" : ""} onClick={() => setWrap((value) => !value)} aria-pressed={wrap}>
            <WrapText size={13} aria-hidden="true" /> {wrap ? "Wrapped" : "Wrap"}
          </button>
          <button type="button" onClick={() => void copy()}>
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className={wrap ? "code-wrap" : undefined} style={{ backgroundColor: highlighted?.bg, color: highlighted?.fg }}>
        <code>
          {highlighted === null
            ? code
            : highlighted.tokens.map((line, lineIndex) => (
                <span className="code-line" key={lineIndex}>
                  {line.map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: token.color }}>{token.content}</span>
                  ))}
                  {lineIndex < highlighted.tokens.length - 1 ? "\n" : null}
                </span>
              ))}
        </code>
      </pre>
    </div>
  );
}
