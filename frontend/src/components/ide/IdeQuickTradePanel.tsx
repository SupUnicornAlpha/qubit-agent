import type { CSSProperties, FC } from "react";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";

type OrderKind = "market" | "limit";

export const IdeQuickTradePanel: FC<{
  variant?: "sidebar" | "trader";
  traderLinked?: boolean;
  traderBusy?: boolean;
  onPlaceOrder?: (side: "buy" | "sell", qty: number, orderKind: OrderKind) => Promise<void>;
  onCancelLast?: () => Promise<void>;
  lastOrderIntentId?: string | null;
}> = ({
  variant = "sidebar",
  traderLinked = false,
  traderBusy = false,
  onPlaceOrder,
  onCancelLast,
  lastOrderIntentId,
}) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const pushTraderAgentLog = useAppStore((s) => s.pushTraderAgentLog);
  const [orderKind, setOrderKind] = useState<OrderKind>("market");
  const [amountPct, setAmountPct] = useState(25);
  const [notional, setNotional] = useState(10_000);
  const [leverage, setLeverage] = useState(3);
  const [marginMode, setMarginMode] = useState<"cross" | "isolated">("cross");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [orderErr, setOrderErr] = useState<string | null>(null);

  const lastSig = useRef<string>("");
  const canTrade = traderLinked && Boolean(onPlaceOrder);

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

  const qtyFromNotional = () => {
    const base = Math.max(1, Math.floor((notional * amountPct) / 100 / 100));
    return base;
  };

  const submit = async (side: "buy" | "sell") => {
    if (!onPlaceOrder) return;
    setOrderErr(null);
    try {
      await onPlaceOrder(side, qtyFromNotional(), orderKind);
    } catch (e) {
      setOrderErr(e instanceof Error ? e.message : String(e));
    }
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
          与左侧 Agent 流、上方 K 线联动：纸面下单走统一执行管道（风控 → execution_task → 纸面成交）。
        </p>
      ) : null}
      <label style={styles.lab}>
        名义金额（示意，用于估算数量）
        <input
          style={styles.inpActive}
          type="number"
          min={100}
          value={notional}
          onChange={(e) => setNotional(Number(e.target.value) || 10_000)}
          disabled={!canTrade}
        />
      </label>
      <p style={styles.price}>
        {canTrade
          ? `预估数量约 ${qtyFromNotional()} 股/张 · 纸面模式`
          : "在实时交易页连接后端后可用"}
      </p>
      {orderErr ? <p style={styles.err}>{orderErr}</p> : null}
      <div style={styles.lr}>
        <button
          type="button"
          className="qb-btn-trade-long"
          disabled={!canTrade || traderBusy}
          onClick={() => void submit("buy")}
        >
          {traderBusy ? "提交中…" : "做多"}
        </button>
        <button
          type="button"
          className="qb-btn-trade-short"
          disabled={!canTrade || traderBusy}
          onClick={() => void submit("sell")}
        >
          {traderBusy ? "提交中…" : "做空"}
        </button>
      </div>
      {canTrade && lastOrderIntentId ? (
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          disabled={traderBusy || !onCancelLast}
          onClick={() => void onCancelLast?.()}
        >
          撤上一单 ({lastOrderIntentId.slice(0, 8)}…)
        </button>
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
        <input style={styles.inp} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="可选（后续版本）" disabled />
      </label>
      <label style={styles.lab}>
        止损价
        <input style={styles.inp} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="可选（后续版本）" disabled />
      </label>
      <p style={styles.note}>
        当前订单类型：<strong>{orderKind === "market" ? "市价" : "限价"}</strong>。止盈止损与实盘券商将在后续版本接入。
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
    background: "var(--qb-chat-main-bg, #111114)",
    borderLeft: "1px solid var(--qb-main-input-border, #27272a)",
    overflow: "auto",
  },
  title: { margin: 0, fontSize: 15, fontWeight: 700, color: "var(--qb-body-fg, #e4e4e7)" },
  pair: { margin: 0, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
  linkHint: { margin: 0, fontSize: 11, color: "var(--qb-main-meta, #71717a)", lineHeight: 1.45 },
  price: { margin: 0, fontSize: 12, color: "var(--qb-main-meta, #71717a)" },
  err: { margin: 0, fontSize: 12, color: "#f87171" },
  lab: { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--qb-main-meta, #71717a)" },
  select: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 12,
  },
  inp: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 12,
    opacity: 0.7,
  },
  inpActive: {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 12,
  },
  lr: { display: "flex", flexDirection: "row", gap: 8 },
  segBar: { width: "100%" },
  pctRow: { display: "flex", flexWrap: "wrap", gap: 4 },
  range: { width: "100%", accentColor: "#3b82f6" },
  note: { margin: 0, fontSize: 10, color: "var(--qb-main-meta, #52525b)", lineHeight: 1.45 },
};
