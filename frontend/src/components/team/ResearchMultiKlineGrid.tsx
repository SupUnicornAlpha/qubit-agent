/**
 * 研究画布多标的 K 线网格：每个标的一张独立蜡烛图。
 */
import type { CSSProperties, FC } from "react";
import type { ResearchMarketSymbol } from "../../lib/researchMarketSymbols";
import { MiniKlineCard } from "../chart/MiniKlineCard";

const SOURCE_LABEL: Record<ResearchMarketSymbol["source"], string> = {
  focus: "焦点",
  scope: "研究范围",
  tool: "工具联动",
};

export const ResearchMultiKlineGrid: FC<{
  symbols: ResearchMarketSymbol[];
  timeframe: string;
  limit: number;
  reloadNonce: number;
  focusKey: string | null;
  onFocus: (row: ResearchMarketSymbol) => void;
}> = ({ symbols, timeframe, limit, reloadNonce, focusKey, onFocus }) => {
  if (symbols.length === 0) {
    return (
      <div style={styles.empty}>
        还没有可展示的标的。请在左侧填写研究范围，或等待 Orchestrator 调用行情工具后自动联动。
      </div>
    );
  }

  const cols =
    symbols.length === 1 ? 1 : symbols.length === 2 ? 2 : symbols.length <= 4 ? 2 : 3;

  return (
    <div style={styles.root} data-qb-research-multi-kline>
      <div style={styles.hint}>
        共 {symbols.length} 个标的 · 点击卡片设为焦点（新闻 / 单标联动跟随焦点）
      </div>
      <div
        style={{
          ...styles.grid,
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        }}
      >
        {symbols.map((row) => {
          const key = `${row.symbol}@@${row.exchange}`;
          return (
            <MiniKlineCard
              key={key}
              symbol={row.symbol}
              exchange={row.exchange}
              timeframe={timeframe}
              limit={limit}
              reloadNonce={reloadNonce}
              active={focusKey === key}
              sourceLabel={SOURCE_LABEL[row.source]}
              height={symbols.length === 1 ? 420 : 240}
              onSelect={() => onFocus(row)}
            />
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 0,
    flex: 1,
    overflow: "auto",
  },
  hint: {
    fontSize: 11,
    color: "#71717a",
    flexShrink: 0,
  },
  grid: {
    display: "grid",
    gap: 10,
    alignContent: "start",
  },
  empty: {
    padding: "28px 16px",
    color: "var(--qb-team-meta, #a1a1aa)",
    fontSize: 12,
    lineHeight: 1.55,
    border: "1px dashed var(--qb-team-live-feed-border, #3f3f46)",
    borderRadius: 8,
  },
};
