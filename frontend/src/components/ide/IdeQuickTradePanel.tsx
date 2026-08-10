import type { CSSProperties, FC } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";

type OrderKind = "market" | "limit";

export const IdeQuickTradePanel: FC<{
  variant?: "sidebar" | "trader";
  traderLinked?: boolean;
  traderBusy?: boolean;
  executionMode?: "paper" | "sim";
  onPlaceOrder?: (
    side: "buy" | "sell",
    qty: number,
    orderKind: OrderKind,
    limitPrice?: number
  ) => Promise<void>;
  onPlaceBracket?: (
    side: "buy" | "sell",
    qty: number,
    orderKind: OrderKind,
    takeProfitPrice: number,
    stopLossPrice: number,
    entryLimitPrice?: number
  ) => Promise<void>;
  onCancelLast?: () => Promise<void>;
  lastOrderIntentId?: string | null;
}> = ({
  variant = "sidebar",
  traderLinked = false,
  traderBusy = false,
  executionMode = "paper",
  onPlaceOrder,
  onPlaceBracket,
  onCancelLast,
  lastOrderIntentId,
}) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const pushTraderAgentLog = useAppStore((s) => s.pushTraderAgentLog);
  const { t } = useTranslation();
  const [orderKind, setOrderKind] = useState<OrderKind>("market");
  const [qty, setQty] = useState(100);
  const [limitPrice, setLimitPrice] = useState("");
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [orderErr, setOrderErr] = useState<string | null>(null);

  const lastSig = useRef<string>("");
  const canTrade = traderLinked && Boolean(onPlaceOrder);

  useEffect(() => {
    if (!traderLinked) return;
    const sig = `${orderKind}|${qty}|${limitPrice}|${executionMode}`;
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    const timer = window.setTimeout(() => {
      pushTraderAgentLog({
        kind: "user",
        title: t("ide.quickTrade.logTitle"),
        body: `订单类型=${orderKind === "market" ? t("ide.quickTrade.orderKind.market") : t("ide.quickTrade.orderKind.limit")} · 数量=${qty} · 执行=${executionMode}\n品种 ${chartSpec.symbol} / ${chartSpec.exchange} · ${chartSpec.timeframe}`,
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    traderLinked,
    orderKind,
    qty,
    limitPrice,
    executionMode,
    chartSpec.symbol,
    chartSpec.exchange,
    chartSpec.timeframe,
    pushTraderAgentLog,
    t,
  ]);

  const submit = async (side: "buy" | "sell") => {
    if (!onPlaceOrder) return;
    setOrderErr(null);
    try {
      if (!Number.isFinite(qty) || qty <= 0) throw new Error("数量必须大于 0");
      const resolvedLimitPrice = Number(limitPrice);
      if (orderKind === "limit" && !(resolvedLimitPrice > 0)) {
        throw new Error("限价单必须填写有效限价");
      }
      const takeProfitPrice = Number(tp);
      const stopLossPrice = Number(sl);
      const hasProtection = tp.trim().length > 0 || sl.trim().length > 0;
      if (hasProtection) {
        if (!onPlaceBracket) throw new Error(t("ide.quickTrade.bracketUnavailable"));
        if (!(takeProfitPrice > 0) || !(stopLossPrice > 0)) {
          throw new Error(t("ide.quickTrade.bracketIncomplete"));
        }
        await onPlaceBracket(
          side,
          qty,
          orderKind,
          takeProfitPrice,
          stopLossPrice,
          orderKind === "limit" ? resolvedLimitPrice : undefined
        );
      } else {
        await onPlaceOrder(
          side,
          qty,
          orderKind,
          orderKind === "limit" ? resolvedLimitPrice : undefined
        );
      }
    } catch (e) {
      setOrderErr(e instanceof Error ? e.message : String(e));
    }
  };

  const panelStyle: CSSProperties =
    variant === "trader"
      ? { ...styles.panel, width: "100%", maxWidth: "100%", borderLeft: "none", borderTop: "none" }
      : styles.panel;

  const orderKindLabel =
    orderKind === "market"
      ? t("ide.quickTrade.orderKind.market")
      : t("ide.quickTrade.orderKind.limit");

  return (
    <aside style={panelStyle} aria-label={t("ide.quickTrade.ariaLabel")}>
      <h2 style={styles.title}>{t("ide.quickTrade.title")}</h2>
      <p style={styles.pair}>
        {chartSpec.symbol} / {chartSpec.exchange} · {chartSpec.timeframe}
      </p>
      {traderLinked ? <p style={styles.linkHint}>{t("ide.quickTrade.intro")}</p> : null}
      <label style={styles.lab}>
        数量
        <input
          style={styles.inpActive}
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          disabled={!canTrade}
        />
      </label>
      <p style={styles.price}>
        {canTrade
          ? `${qty} 单位 · ${executionMode === "paper" ? "纸面执行" : "券商模拟执行"}`
          : t("ide.quickTrade.backendOffline")}
      </p>
      {orderErr ? <p style={styles.err}>{orderErr}</p> : null}
      <div style={styles.lr}>
        <button
          type="button"
          className="qb-btn-trade-long"
          disabled={!canTrade || traderBusy}
          onClick={() => void submit("buy")}
        >
          {traderBusy ? t("ide.quickTrade.submitting") : t("ide.quickTrade.long")}
        </button>
        <button
          type="button"
          className="qb-btn-trade-short"
          disabled={!canTrade || traderBusy}
          onClick={() => void submit("sell")}
        >
          {traderBusy ? t("ide.quickTrade.submitting") : t("ide.quickTrade.short")}
        </button>
      </div>
      {canTrade && lastOrderIntentId ? (
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          disabled={traderBusy || !onCancelLast}
          onClick={() => void onCancelLast?.()}
        >
          {t("ide.quickTrade.cancelLast", { id: lastOrderIntentId.slice(0, 8) })}
        </button>
      ) : null}
      <div className="qb-segmented qb-segmented--inline" style={styles.segBar}>
        <button
          type="button"
          className={`qb-segmented__tab${orderKind === "market" ? " qb-segmented__tab--active" : ""}`}
          onClick={() => setOrderKind("market")}
        >
          {t("ide.quickTrade.orderKind.market")}
        </button>
        <button
          type="button"
          className={`qb-segmented__tab${orderKind === "limit" ? " qb-segmented__tab--active" : ""}`}
          onClick={() => setOrderKind("limit")}
        >
          {t("ide.quickTrade.orderKind.limit")}
        </button>
      </div>
      {orderKind === "limit" ? (
        <label style={styles.lab}>
          限价
          <input
            style={styles.inpActive}
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            placeholder="订单触发价格"
            disabled={!canTrade}
            type="number"
            min="0"
            step="any"
          />
        </label>
      ) : null}
      <label style={styles.lab}>
        {t("ide.quickTrade.tp")}
        <input
          style={styles.inp}
          value={tp}
          onChange={(e) => setTp(e.target.value)}
          placeholder={t("ide.quickTrade.tpslPlaceholder")}
          disabled={!canTrade}
          type="number"
          min="0"
          step="any"
        />
      </label>
      <label style={styles.lab}>
        {t("ide.quickTrade.sl")}
        <input
          style={styles.inp}
          value={sl}
          onChange={(e) => setSl(e.target.value)}
          placeholder={t("ide.quickTrade.tpslPlaceholder")}
          disabled={!canTrade}
          type="number"
          min="0"
          step="any"
        />
      </label>
      <p style={styles.note}>
        {t("ide.quickTrade.currentKindPrefix")}
        <strong>{orderKindLabel}</strong>
        {t("ide.quickTrade.currentKindSuffix")}
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
  lab: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 11,
    color: "var(--qb-main-meta, #71717a)",
  },
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
  note: { margin: 0, fontSize: 10, color: "var(--qb-main-meta, #52525b)", lineHeight: 1.45 },
};
