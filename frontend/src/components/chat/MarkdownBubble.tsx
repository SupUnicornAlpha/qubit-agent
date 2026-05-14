import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FC, ReactNode } from "react";

const mdBase: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: "#e4e4e7",
  wordBreak: "break-word",
};

const mdComponents: Components = {
  p: ({ children }) => <p style={{ margin: "0.4em 0", ...mdBase }}>{children}</p>,
  h1: ({ children }) => <h1 style={{ fontSize: "1.35em", margin: "0.5em 0 0.25em", fontWeight: 700 }}>{children}</h1>,
  h2: ({ children }) => <h2 style={{ fontSize: "1.2em", margin: "0.5em 0 0.25em", fontWeight: 700 }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: "1.08em", margin: "0.45em 0 0.2em", fontWeight: 600 }}>{children}</h3>,
  ul: ({ children }) => <ul style={{ margin: "0.35em 0", paddingLeft: "1.25em" }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "0.35em 0", paddingLeft: "1.25em" }}>{children}</ol>,
  li: ({ children }) => <li style={{ margin: "0.15em 0" }}>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote
      style={{
        margin: "0.5em 0",
        padding: "0.35em 0 0.35em 0.75em",
        borderLeft: "3px solid #52525b",
        color: "#a1a1aa",
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: "#60a5fa", textDecoration: "underline" }}>
      {children}
    </a>
  ),
  hr: () => <hr style={{ border: "none", borderTop: "1px solid #3f3f46", margin: "0.75em 0" }} />,
  table: ({ children }) => (
    <div style={{ overflow: "auto", maxWidth: "100%", margin: "0.5em 0" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 13 }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: "1px solid #3f3f46", padding: "6px 10px", background: "#27272a", textAlign: "left" }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td style={{ border: "1px solid #3f3f46", padding: "6px 10px" }}>{children}</td>,
  code: ({ className, children }) => {
    const isBlock = Boolean(className?.includes("language-"));
    if (isBlock) {
      return (
        <code
          className={className}
          style={{
            display: "block",
            padding: "10px 12px",
            margin: "0.5em 0",
            borderRadius: 8,
            background: "#09090b",
            border: "1px solid #27272a",
            fontSize: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        style={{
          padding: "2px 6px",
          borderRadius: 4,
          background: "#27272a",
          fontSize: "0.92em",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
        }}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre style={{ margin: "0.5em 0", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{children as ReactNode}</pre>
  ),
  strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
  em: ({ children }) => <em style={{ fontStyle: "italic", color: "#d4d4d8" }}>{children}</em>,
};

export const MarkdownBubble: FC<{ text: string }> = ({ text }) => {
  if (!text.trim()) {
    return <span style={{ color: "#71717a" }}>(空)</span>;
  }
  return (
    <div style={mdBase}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
};
