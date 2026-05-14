import type { CSSProperties, FC } from "react";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";

type OrderKind = "market" | "limit";

export const IdeQuickTradePanel: FC<{ variant?: "sidebar" | "trader"; traderLinked?: boolean }> = ({
  variant = "sidebar",
  traderLinked = false,
}) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const pushTraderAgentLog = useAppStore((s) => s.pushTraderAgentLog);
  const pushTraderMarker = useAppStore((s) => s.pushTraderMarker);
  const [orderKind, setOrderKind] = useState<OrderKind>("market");
  const [amountPct, setAmountPct] = useState(25);
  const [leverage, setLeverage] = useState(3);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [exchangeVenue, setExchangeVenue] = useState("（模拟）");

  const lastSig = useRef<string>("");

  useEffect(() => {
    if (!traderLinked) return;
    const sig = `${orderKind}|${amountPct}|${leverage}|${marginMode}`;
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    const t = window.setTimeout(() => {
      pushTraderAgentLog({
        kind: "user",
        title: "快捷交易参数变更",
        body: `订单类型=${orderKind === "market" ? "市价" : "限价"} · 名义比例=${amountPct}% · 杠杆=${leverage}x · 保证金=${marginMode === "cross" ? "全仓" : "逐仓"}\n品种 ${chartSpec.symbol} / ${chartSpec.exchange} · ${chartSpec.timeframe}`,
      });
    }, 450);
    return () => window.clearTimeout(t);
  }, [traderLinked, orderKind, amountPct, leverage, marginMode, chartSpec.symbol, chartSpec.exchange, chartSpec.timeframe, pushTraderAgentLog]);

  const markDemo = (side: "buy" | "sell") => {
    pushTraderMarker({
      side,
      text: side === "buy" ? "手动做多意向" : "手动做空意向",
      source: "manual",
    });
    pushTraderAgentLog({
      kind: "user",
      title: side === "buy" ? "快捷交易：做多意向（演示）" : "快捷交易：做空意向（演示）",
      body: `已在 K 线末根叠加标记（与 Agent 演示共用 store）。真实通道仍关闭。`,
    });
  };

  const panelStyle: CSSProperties =
    variant === "trader"
      ? { ...styles.panel, width: "100%", maxWidth: "100%", borderLeft: "none", borderTop: "none" }
      : styles.panel;

  return (
    <aside style={panelStyle} aria-label="快捷交易">
      <h2 style={styles.title}>快捷交易</h2>
      <p style={styles.pair}>
        {chartSpec.symbol} / {chartSpec.exchange} · {chartSpec.timeframe}
      </p>
      {traderLinked ? (
        <p style={styles.linkHint}>
          与左侧 Agent 流、上方 K 线联动：参数变更会写入对话流；演示按钮会在 K 线打标（末根）。
        </p>
      ) : null}
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
        <button type="button" className="qb-btn-trade-long" disabled title="待执行安全策略与券商对接">
          做多
        </button>
        <button type="button" className="qb-btn-trade-short" disabled title="待执行安全策略与券商对接">
          做空
        </button>
      </div>
      {traderLinked ? (
        <div style={styles.demoRow}>
          <button type="button" className="qb-btn-demo-buy" onClick={() => markDemo("buy")}>
            K 线标记：做多意向（演示）
          </button>
          <button type="button" className="qb-btn-demo-sell" onClick={() => markDemo("sell")}>
            K 线标记：做空意向（演示）
          </button>
        </div>
      ) : null}
      <div className="qb-segmented qb-segmented--inline" style={styles.segBar}>
        <button
          type="button"
          className={`qb-segmented__tab${orderKind === "market" ? " qb-segmented__tab--active" : ""}`}
          onClick={() => setOrderKind("market")}
        >
          市价
        </button>
        <button
          type="button"
          className={`qb-segmented__tab${orderKind === "limit" ? " qb-segmented__tab--active" : ""}`}
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
            className={`qb-chip qb-chip--sm${amountPct === p ? " qb-chip--active" : ""}`}
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
      <div className="qb-segmented qb-segmented--inline" style={styles.segBar}>
        <button
          type="button"
          className={`qb-segmented__tab${marginMode === "cross" ? " qb-segmented__tab--active" : ""}`}
          onClick={() => setMarginMode("cross")}
        >
          全仓
        </button>
        <button
          type="button"
          className={`qb-segmented__tab${marginMode === "isolated" ? " qb-segmented__tab--active" : ""}`}
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
  linkHint: { margin: 0, fontSize: 11, color: "#71717a", lineHeight: 1.45 },
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
  demoRow: { display: "flex", flexDirection: "row", gap: 8, flexWrap: "wrap" },
  segBar: { width: "100%" },
  pctRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  range: { width: "100%", accentColor: "#3b82f6" },
  note: { margin: 0, fontSize: 10, color: "#52525b", lineHeight: 1.45 },
};
