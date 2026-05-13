import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { useAppStore } from "../../store";

type OrderKind = "market" | "limit";

export const IdeQuickTradePanel: FC = () => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const [orderKind, setOrderKind] = useState<OrderKind>("market");
  const [amountPct, setAmountPct] = useState(25);
  const [leverage, setLeverage] = useState(3);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [exchangeVenue, setExchangeVenue] = useState("（模拟）");

  return (
    <aside style={styles.panel} aria-label="快捷交易">
      <h2 style={styles.title}>快捷交易</h2>
      <p style={styles.pair}>
        {chartSpec.symbol} / {chartSpec.exchange} · {chartSpec.timeframe}
      </p>
      <label style={styles.lab}>
        交易所
        <select style={styles.select} value={exchangeVenue} onChange={(e) => setExchangeVenue(e.target.value)}>
          <option value="（模拟）">（模拟）</option>
          <option value="Gate">Gate（占位）</option>
          <option value="Binance">Binance（占位）</option>
        </select>
      </label>
      <p style={styles.price}>行情价接入 REIA 前为示意；下单通道保持关闭。</p>
      <div style={styles.lr}>
        <button type="button" style={styles.long} disabled title="待执行安全策略与券商对接">
          做多
        </button>
        <button type="button" style={styles.short} disabled title="待执行安全策略与券商对接">
          做空
        </button>
      </div>
      <div style={styles.tabs}>
        <button
          type="button"
          style={{ ...styles.tab, ...(orderKind === "market" ? styles.tabOn : {}) }}
          onClick={() => setOrderKind("market")}
        >
          市价
        </button>
        <button
          type="button"
          style={{ ...styles.tab, ...(orderKind === "limit" ? styles.tabOn : {}) }}
          onClick={() => setOrderKind("limit")}
        >
          限价
        </button>
      </div>
      <label style={styles.lab}>
        名义金额（USDT 示意）
        <input style={styles.inp} type="number" min={0} placeholder="0" disabled />
      </label>
      <div style={styles.pctRow}>
        {[10, 25, 50, 75, 100].map((p) => (
          <button
            key={p}
            type="button"
            style={{ ...styles.pct, ...(amountPct === p ? styles.pctOn : {}) }}
            onClick={() => setAmountPct(p)}
          >
            {p}%
          </button>
        ))}
      </div>
      <label style={styles.lab}>
        杠杆 {leverage}x
        <input
          style={styles.range}
          type="range"
          min={1}
          max={20}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
        />
      </label>
      <div style={styles.seg}>
        <button
          type="button"
          style={{ ...styles.segBtn, ...(marginMode === "cross" ? styles.segOn : {}) }}
          onClick={() => setMarginMode("cross")}
        >
          全仓
        </button>
        <button
          type="button"
          style={{ ...styles.segBtn, ...(marginMode === "isolated" ? styles.segOn : {}) }}
          onClick={() => setMarginMode("isolated")}
        >
          逐仓
        </button>
      </div>
      <label style={styles.lab}>
        止盈价
        <input style={styles.inp} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="可选" disabled />
      </label>
      <label style={styles.lab}>
        止损价
        <input style={styles.inp} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="可选" disabled />
      </label>
      <p style={styles.note}>
        当前订单类型：<strong>{orderKind === "market" ? "市价" : "限价"}</strong>。与 QuantDinger
        一致先铺全交互；真实下单需项目侧执行模块、风控与白名单。
      </p>
    </aside>
  );
};

const styles: Record<string, CSSProperties> = {
  panel: {
    width: 300,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 12,
    background: "#111114",
    borderLeft: "1px solid #27272a",
    overflow: "auto",
  },
  title: { margin: 0, fontSize: 15, fontWeight: 700, color: "#e4e4e7" },
  pair: { margin: 0, fontSize: 12, color: "#a1a1aa" },
  price: { margin: 0, fontSize: 12, color: "#71717a" },
  lab: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#71717a" },
  select: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
  },
  inp: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 12,
    opacity: 0.7,
  },
  lr: { display: "flex", flexDirection: "row", gap: 8 },
  long: {
    flex: 1,
    padding: "10px 0",
    borderRadius: 6,
    border: "none",
    background: "#166534",
    color: "#dcfce7",
    fontSize: 14,
    fontWeight: 700,
    cursor: "not-allowed",
    opacity: 0.55,
  },
  short: {
    flex: 1,
    padding: "10px 0",
    borderRadius: 6,
    border: "none",
    background: "#991b1b",
    color: "#fee2e2",
    fontSize: 14,
    fontWeight: 700,
    cursor: "not-allowed",
    opacity: 0.55,
  },
  tabs: { display: "flex", flexDirection: "row", gap: 6 },
  tab: {
    flex: 1,
    padding: "6px 0",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#a1a1aa",
    fontSize: 12,
    cursor: "pointer",
  },
  tabOn: {
    borderColor: "#3b82f6",
    color: "#fff",
    background: "#1e3a8a",
  },
  pctRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  pct: {
    padding: "4px 8px",
    borderRadius: 4,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#a1a1aa",
    fontSize: 11,
    cursor: "pointer",
  },
  pctOn: { borderColor: "#3b82f6", color: "#fff" },
  range: { width: "100%", accentColor: "#3b82f6" },
  seg: { display: "flex", flexDirection: "row", gap: 6 },
  segBtn: {
    flex: 1,
    padding: "6px 0",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#a1a1aa",
    fontSize: 12,
    cursor: "pointer",
  },
  segOn: { borderColor: "#7c3aed", color: "#e4e4e7" },
  note: { margin: 0, fontSize: 10, color: "#52525b", lineHeight: 1.45 },
};
