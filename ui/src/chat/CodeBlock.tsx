import { useEffect, useMemo, useState } from "react";
import { Check, Copy, WrapText } from "lucide-react";
import { highlightCode, normalizeLanguage } from "./code-highlighter";

type HighlightedCode = Awaited<ReturnType<typeof highlightCode>>;

export function CodeBlock({ code, language }: Readonly<{ code: string; language?: string }>) {
  const [highlighted, setHighlighted] = useState<HighlightedCode | null>(null);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const normalized = useMemo(() => normalizeLanguage(language), [language]);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    if (normalized === null) return () => { active = false; };
    void (async () => {
      try {
        const tokens = await highlightCode(code, normalized);
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
