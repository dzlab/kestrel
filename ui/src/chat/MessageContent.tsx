import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";
import { WorkspaceImage } from "./WorkspaceImage";

function safeLink(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? value : "";
  } catch {
    return "";
  }
}

function safeImagePath(value: string): string {
  if (value.length === 0 || value.startsWith("/") || value.startsWith("\\")) return "";
  if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return "";
  return value;
}

const safeUrlTransform: UrlTransform = (url, key) => key === "src" ? safeImagePath(url) : safeLink(url);

function MarkdownPre({ children }: Readonly<{ children?: ReactNode }>) {
  const items = Children.toArray(children);
  const child = items.length === 1 ? items[0] : null;
  if (isValidElement(child) && child.type === "code") {
    const element = child as ReactElement<{ className?: string; children?: ReactNode }>;
    const match = /(?:^|\s)language-([^\s]+)/u.exec(element.props.className ?? "");
    const code = String(element.props.children ?? "").replace(/\n$/u, "");
    return <CodeBlock code={code} language={match?.[1]} />;
  }
  return <pre>{children}</pre>;
}

export function MessageContent({ content }: Readonly<{ content: string }>) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
        components={{
          pre: ({ node: _node, ...props }) => <MarkdownPre {...props} />,
          code: ({ node: _node, ...props }) => <code {...props} />,
          a: ({ node: _node, href, children, ...props }) => {
            const safeHref = href === undefined ? "" : safeLink(href);
            if (safeHref.length === 0) return <span className="unsafe-link">{children}</span>;
            const parsed = new URL(safeHref);
            const external = parsed.protocol === "mailto:" || parsed.origin !== window.location.origin;
            return <a {...props} href={safeHref} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{children}</a>;
          },
          img: ({ node: _node, src, alt, title }) => <WorkspaceImage path={src ?? ""} alt={alt ?? undefined} title={title ?? undefined} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
