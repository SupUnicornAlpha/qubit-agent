import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CSSProperties, FC, ReactNode } from "react";
import { TokyoCodeView } from "../code/TokyoCodeEditor";
import { inferTokyoLanguage } from "../../lib/tokyoSyntaxHighlight";

const mdBase: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: "var(--qb-md-prose-fg, #e4e4e7)",
  wordBreak: "break-word",
};

const headingColor: CSSProperties = { color: "var(--qb-md-prose-fg, #e4e4e7)" };

const mdComponents: Components = {
  p: ({ children }) => <p style={{ margin: "0.4em 0", ...mdBase }}>{children}</p>,
  h1: ({ children }) => (
    <h1 style={{ fontSize: "1.35em", margin: "0.5em 0 0.25em", fontWeight: 700, ...headingColor }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: "1.2em", margin: "0.5em 0 0.25em", fontWeight: 700, ...headingColor }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: "1.08em", margin: "0.45em 0 0.2em", fontWeight: 600, ...headingColor }}>{children}</h3>
  ),
  ul: ({ children }) => <ul style={{ margin: "0.35em 0", paddingLeft: "1.25em" }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "0.35em 0", paddingLeft: "1.25em" }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: "0.15em 0" }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0.5em 0",
        padding: "0.35em 0 0.35em 0.75em",
        borderLeft: "3px solid var(--qb-md-blockquote-border, #52525b)",
        color: "var(--qb-md-blockquote-fg, #a1a1aa)",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: "var(--qb-md-link, #60a5fa)", textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid var(--qb-md-hr, #3f3f46)", margin: "0.75em 0" }} />,
  table: ({ children }) => (
    <div style={{ overflow: "auto", maxWidth: "100%", width: "100%", margin: "0.5em 0" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%", maxWidth: "100%", tableLayout: "fixed" }}>
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th
      style={{
        border: "1px solid var(--qb-md-table-border, #3f3f46)",
        padding: "6px 10px",
        background: "var(--qb-md-th-bg, #27272a)",
        color: "var(--qb-md-prose-fg, #e4e4e7)",
        textAlign: "left",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td
      style={{
        border: "1px solid var(--qb-md-table-border, #3f3f46)",
        padding: "6px 10px",
        color: "var(--qb-md-prose-fg, #e4e4e7)",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      {children}
    </td>
  ),
  code: ({ className, children }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      const text = String(children).replace(/\n$/, "");
      const lang = className?.match(/language-(\w+)/)?.[1];
      return (
        <div style={{ margin: "0.5em 0" }}>
          <TokyoCodeView
            code={text}
            language={inferTokyoLanguage(lang)}
            filename={lang ? `snippet.${lang === "python" ? "py" : lang}` : "snippet.txt"}
            minHeight={48}
            maxHeight={360}
          />
        </div>
      );
    }
    return (
      <code
        style={{
          padding: "2px 6px",
          borderRadius: 4,
          background: "var(--qb-md-code-inline-bg, #27272a)",
          color: "var(--qb-md-prose-fg, #e4e4e7)",
          fontSize: "0.92em",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <div style={{ margin: "0.5em 0" }}>{children as ReactNode}</div>,
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: "italic", color: "var(--qb-md-em-fg, #d4d4d8)" }}>{children}</em>,
};

export const MarkdownBubble: FC<{ text: string }> = ({ text }) => {
  if (!text.trim()) {
    return <span style={{ color: "var(--qb-main-meta, #71717a)" }}>(空)</span>;
  }
  return (
    <div style={{ ...mdBase, maxWidth: "100%", minWidth: 0, overflow: "hidden" }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
};
