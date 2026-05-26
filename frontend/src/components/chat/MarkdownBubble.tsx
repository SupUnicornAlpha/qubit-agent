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
  /**
   * 表格采用"卡片化"外壳：圆角 + 边框 + 内部横向滚动；样式 via className 实现：
   * - thead 粘顶
   * - 偶数行斑马纹
   * - 行 hover 高亮
   * - 单元格内联代码不再溢出
   * 具体规则见底部 <style> 注入。
   */
  table: ({ children }) => (
    <div className="qb-md-table-wrap">
      <table className="qb-md-table">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="qb-md-thead">{children}</thead>,
  tbody: ({ children }) => <tbody className="qb-md-tbody">{children}</tbody>,
  tr: ({ children }) => <tr className="qb-md-tr">{children}</tr>,
  th: ({ children }) => <th className="qb-md-th">{children}</th>,
  td: ({ children }) => <td className="qb-md-td">{children}</td>,
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

/**
 * 仅注入一次的全局样式。用 className 而不是 inline style 是因为：
 * - tr:hover、tbody tr:nth-child(even) 这种伪类用 inline style 写不了；
 * - thead position:sticky 这种依赖 layout 的属性 inline 也不便；
 * - 复用同一份规则避免每张表格都重复 inline，DOM 更轻。
 */
const QB_MD_TABLE_STYLE_ID = "qb-md-table-style";
const QB_MD_TABLE_CSS = `
.qb-md-bubble > :first-child { margin-top: 0 !important; }
.qb-md-bubble > :last-child { margin-bottom: 0 !important; }
.qb-md-table-wrap {
  overflow: auto;
  max-width: 100%;
  width: 100%;
  margin: 0.6em 0;
  border-radius: 8px;
  border: 1px solid var(--qb-md-table-border, #3f3f46);
  background: var(--qb-md-table-wrap-bg, rgba(24,24,27,0.4));
  box-shadow: 0 1px 0 rgba(0,0,0,0.18) inset;
}
.qb-md-table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
  width: 100%;
  max-width: 100%;
  table-layout: auto;
  color: var(--qb-md-prose-fg, #e4e4e7);
}
.qb-md-table .qb-md-thead {
  position: sticky;
  top: 0;
  z-index: 1;
}
.qb-md-table .qb-md-th {
  padding: 7px 12px;
  background: var(--qb-md-th-bg, #27272a);
  color: var(--qb-md-prose-fg, #e4e4e7);
  font-weight: 600;
  text-align: left;
  border-bottom: 1px solid var(--qb-md-table-border, #3f3f46);
  white-space: nowrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  letter-spacing: 0.2px;
}
.qb-md-table .qb-md-th + .qb-md-th,
.qb-md-table .qb-md-td + .qb-md-td {
  border-left: 1px solid var(--qb-md-table-border-soft, rgba(63,63,70,0.55));
}
.qb-md-table .qb-md-td {
  padding: 6px 12px;
  color: var(--qb-md-prose-fg, #e4e4e7);
  vertical-align: top;
  overflow-wrap: anywhere;
  word-break: break-word;
  border-bottom: 1px solid var(--qb-md-table-border-soft, rgba(63,63,70,0.45));
}
.qb-md-table .qb-md-tbody .qb-md-tr:last-child .qb-md-td {
  border-bottom: none;
}
.qb-md-table .qb-md-tbody .qb-md-tr:nth-child(even) .qb-md-td {
  background: var(--qb-md-tr-zebra-bg, rgba(255,255,255,0.025));
}
.qb-md-table .qb-md-tbody .qb-md-tr:hover .qb-md-td {
  background: var(--qb-md-tr-hover-bg, rgba(96,165,250,0.08));
}
.qb-md-table .qb-md-td code,
.qb-md-table .qb-md-th code {
  white-space: pre-wrap;
}
/* 浅色主题（feishu / clean）配色覆盖 */
[data-qb-theme*="feishu"] .qb-md-table-wrap,
[data-qb-theme*="clean"] .qb-md-table-wrap,
[data-qb-theme*="light"] .qb-md-table-wrap {
  --qb-md-table-wrap-bg: rgba(248,250,252,0.85);
  --qb-md-tr-zebra-bg: rgba(15,23,42,0.035);
  --qb-md-tr-hover-bg: rgba(37,99,235,0.08);
  --qb-md-table-border-soft: rgba(148,163,184,0.35);
}
`;

function ensureMdTableStyleInjected(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(QB_MD_TABLE_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = QB_MD_TABLE_STYLE_ID;
  el.textContent = QB_MD_TABLE_CSS;
  document.head.appendChild(el);
}

export const MarkdownBubble: FC<{ text: string }> = ({ text }) => {
  ensureMdTableStyleInjected();
  if (!text.trim()) {
    return <span style={{ color: "var(--qb-main-meta, #71717a)" }}>(空)</span>;
  }
  return (
    <div
      className="qb-md-bubble"
      style={{ ...mdBase, maxWidth: "100%", minWidth: 0, overflow: "hidden" }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
};
