import type { FC } from "react";
import { useCallback, useEffect, useState } from "react";
import { getMarketNewsBrief } from "../../api/backend";
import type { MarketNewsBriefItem, MarketNewsBriefPayload } from "../../api/types";
import { normalizeExternalHref, openExternalUrl } from "../../lib/openExternalUrl";

function newsItemHasExpandableBody(it: MarketNewsBriefItem): boolean {
  return Boolean((it.url && it.url.trim()) || (it.content && it.content.trim()));
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    flex: "1 1 42%",
    minHeight: 180,
    display: "flex",
    flexDirection: "column",
    borderTop: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-news-wrap-bg, #0c0c0e)",
    minWidth: 0,
  },
  head: {
    flexShrink: 0,
    padding: "8px 16px 6px",
    fontSize: 11,
    color: "var(--qb-main-meta, #71717a)",
    letterSpacing: "0.04em",
  },
  grid: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
    gap: 0,
    overflow: "hidden",
  },
  col: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    padding: "0 0 10px",
  },
  colTitle: {
    flexShrink: 0,
    padding: "10px 16px 6px",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--qb-news-col-title-fg, #e4e4e7)",
    borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-news-col-title-bg, #111114)",
  },
  sub: { fontSize: 11, fontWeight: 400, color: "var(--qb-main-meta, #71717a)", marginTop: 4 },
  list: {
    flex: 1,
    overflow: "auto",
    padding: "8px 12px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  item: {
    padding: "8px 10px",
    borderRadius: 6,
    background: "var(--qb-news-item-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
  },
  itemTitle: { fontSize: 13, color: "var(--qb-body-fg, #e4e4e7)", lineHeight: 1.45, margin: 0 },
  meta: { marginTop: 6, fontSize: 11, color: "var(--qb-main-meta, #71717a)", display: "flex", flexWrap: "wrap", gap: 8 },
  linkBtn: {
    color: "var(--qb-blue, #60a5fa)",
    textDecoration: "underline",
    textUnderlineOffset: 2,
    fontSize: 12,
    background: "none",
    border: "none",
    padding: 0,
    cursor: "pointer",
    font: "inherit",
  },
  expandPanel: {
    marginTop: 10,
    padding: "10px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-news-expand-bg, #0a0a0c)",
    fontSize: 12,
    wordBreak: "break-word",
    overflowWrap: "anywhere",
  },
  expandUrl: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 11,
    color: "var(--qb-main-meta, #a1a1aa)",
    lineHeight: 1.5,
    marginBottom: 10,
  },
  openBtn: {
    marginTop: 6,
    padding: "6px 12px",
    borderRadius: 6,
    border: "1px solid var(--qb-news-open-btn-border, var(--qb-blue, #3b82f6))",
    background: "var(--qb-news-open-btn-bg, rgba(59, 130, 246, 0.12))",
    color: "var(--qb-body-fg, #e4e4e7)",
    fontSize: 12,
    cursor: "pointer",
  },
  err: { padding: "12px 16px", color: "#fca5a5", fontSize: 13 },
  empty: { padding: "16px", color: "var(--qb-main-meta, #71717a)", fontSize: 13 },
};

function NewsItemCard({ it }: { it: MarketNewsBriefItem }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = newsItemHasExpandableBody(it);
  const urlTrim = it.url?.trim() ?? "";

  return (
    <article style={styles.item} data-qb-news-item>
      <h3 style={styles.itemTitle}>{it.title}</h3>
      <div style={styles.meta}>
        <span>{it.publishedAt}</span>
        <span>{it.source}</span>
        {expandable ? (
          <button
            type="button"
            style={styles.linkBtn}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "收起" : urlTrim ? "原文" : "展开"}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div style={styles.expandPanel} data-qb-news-expand>
          {urlTrim ? (
            <>
              <div style={styles.expandUrl}>{normalizeExternalHref(urlTrim)}</div>
              <button
                type="button"
                style={styles.openBtn}
                data-qb-news-open-btn
                onClick={() => void openExternalUrl(urlTrim)}
              >
                在浏览器中打开
              </button>
            </>
          ) : null}
          {it.content?.trim() ? (
            <p style={{ ...styles.meta, marginTop: urlTrim ? 12 : 0, color: "var(--qb-main-meta, #a1a1aa)", lineHeight: 1.55 }}>
              {it.content.trim()}
            </p>
          ) : null}
          {!urlTrim && !it.content?.trim() ? (
            <span style={{ color: "var(--qb-main-meta, #71717a)" }}>暂无链接或摘要。</span>
          ) : null}
        </div>
      ) : it.content?.trim() && !urlTrim ? (
        <p style={{ ...styles.meta, marginTop: 8, color: "var(--qb-main-meta, #a1a1aa)" }}>{it.content.trim()}</p>
      ) : null}
    </article>
  );
}

function NewsCol(props: {
  title: string;
  subtitle?: string | null;
  items: MarketNewsBriefItem[];
  emptyHint: string;
  showDivider?: boolean;
}) {
  return (
    <div style={{ ...styles.col, borderRight: props.showDivider ? "1px solid var(--qb-main-input-border, #27272a)" : undefined }}>
      <div style={styles.colTitle} data-qb-news-col-title>
        {props.title}
        {props.subtitle ? <div style={styles.sub}>{props.subtitle}</div> : null}
      </div>
      <div style={styles.list}>
        {props.items.length === 0 ? (
          <div style={styles.empty}>{props.emptyHint}</div>
        ) : (
          props.items.map((it) => <NewsItemCard key={it.id} it={it} />)
        )}
      </div>
    </div>
  );
}

export const NewsBriefSection: FC<{
  symbol: string;
  exchange: string;
  reloadNonce: number;
}> = ({ symbol, exchange, reloadNonce }) => {
  const [data, setData] = useState<MarketNewsBriefPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sym = symbol.trim();
    if (!sym) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await getMarketNewsBrief({
        symbol: sym,
        exchange: exchange.trim() || undefined,
        limit: 14,
      });
      if (!res.ok || !res.data) {
        setError(res.error ?? "加载失败");
        setData(null);
        return;
      }
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, exchange]);

  useEffect(() => {
    const t = setTimeout(() => {
      void load();
    }, 380);
    return () => clearTimeout(t);
  }, [load, reloadNonce]);

  return (
    <section style={styles.wrap} data-qb-news-section aria-label="资讯列表">
      <div style={styles.head}>
        {loading
          ? "资讯加载中…"
          : "资讯来源：个股为 Yahoo 财经 RSS + 可选 qubit-news；板块侧为 Yahoo 行业/板块对应 sector ETF 的 RSS（无行业时退化为大盘 SPY）。"}
      </div>
      {error ? <div style={styles.err}>{error}</div> : null}
      {data ? (
        <div style={styles.grid}>
          <NewsCol
            title="个股相关"
            subtitle={`${symbol.trim()} · ${exchange.trim() || "默认"}`}
            items={data.symbolNews}
            emptyHint="暂无个股资讯（可检查网络或稍后在配置中心接入 qubit-news）。"
            showDivider
          />
          <NewsCol
            title="板块 / 同行业"
            subtitle={
              data.sectorLabel
                ? `${data.sectorLabel} · 参考 ETF ${data.sectorHeadlineTicker ?? ""}`
                : `未解析到 Yahoo 行业 · 参考 ETF ${data.sectorHeadlineTicker ?? "SPY"}`
            }
            items={data.sectorNews}
            emptyHint="暂无板块资讯。"
          />
        </div>
      ) : !loading && !error ? (
        <div style={styles.empty}>请输入代码后刷新。</div>
      ) : null}
    </section>
  );
};
