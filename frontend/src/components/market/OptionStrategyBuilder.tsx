import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Activity, Layers3, ShieldAlert } from "lucide-react";
import { getOptionStrategyAnalysis } from "../../api/backend";
import type { OptionChain, OptionStrategyAnalysis } from "../../api/types";
import {
  OPTION_STRATEGY_OPTIONS,
  deriveOptionStrategy,
  nearestOptionStrike,
  optionStrategyStrikes,
  type OptionStrategyConfig,
  type OptionStrategyKind,
} from "../../lib/optionStrategy";

const money = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });

/** 根据当前期权链快照即时重算；不下单，也不持久化策略。 */
export const OptionStrategyBuilder: FC<{
  chain: OptionChain;
  spot: number | null;
  exchange?: string;
  expiry?: string;
  source?: "auto" | "futu" | "alpaca" | "research";
}> = ({ chain, spot, exchange, expiry, source = "auto" }) => {
  const [kind, setKind] = useState<OptionStrategyKind>("single");
  const [centerStrike, setCenterStrike] = useState<number | null>(null);
  const [wingSteps, setWingSteps] = useState(1);
  const [singleRight, setSingleRight] = useState<"call" | "put">("call");
  const [singleSide, setSingleSide] = useState<"buy" | "sell">("buy");
  const [remoteAnalysis, setRemoteAnalysis] = useState<OptionStrategyAnalysis | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const strikes = useMemo(() => optionStrategyStrikes(chain), [chain]);

  useEffect(() => {
    if (strikes.length === 0) {
      setCenterStrike(null);
      return;
    }
    if (centerStrike == null || !strikes.includes(centerStrike)) {
      setCenterStrike(nearestOptionStrike(chain, spot));
    }
  }, [centerStrike, chain, spot, strikes]);

  const config: OptionStrategyConfig = { kind, centerStrike, wingSteps, singleRight, singleSide };
  const estimate = useMemo(() => deriveOptionStrategy(chain, spot, config), [chain, config, spot]);
  const definition = OPTION_STRATEGY_OPTIONS.find((option) => option.value === kind);
  const twoSided = kind !== "single";
  const hasCompleteQuote = estimate.netDebit != null && estimate.legs.length > 0;
  const remoteStrategy = remoteStrategyName(kind);

  useEffect(() => {
    if (!remoteStrategy || centerStrike == null) {
      setRemoteAnalysis(null);
      setRemoteError(null);
      setRemoteLoading(false);
      return;
    }
    let cancelled = false;
    setRemoteLoading(true);
    setRemoteError(null);
    void getOptionStrategyAnalysis({
      symbol: chain.underlying,
      strategy: remoteStrategy,
      ...(exchange ? { exchange } : {}),
      ...(expiry ? { expiry } : {}),
      source,
      centerStrike,
      widthSteps: wingSteps,
      singleRight,
      singleSide,
    }).then((analysis) => {
      if (!cancelled) setRemoteAnalysis(analysis);
    }).catch((error: unknown) => {
      if (!cancelled) setRemoteError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setRemoteLoading(false);
    });
    return () => { cancelled = true; };
  }, [centerStrike, chain.fetchedAt, chain.underlying, exchange, expiry, remoteStrategy, singleRight, singleSide, source, wingSteps]);

  return (
    <section style={styles.root} aria-label="期权策略工具">
      <div style={styles.titleRow}>
        <div style={styles.title}><Layers3 size={14} aria-hidden /> 策略工具 <span>实时推演</span></div>
        <div style={styles.fetchedAt}><Activity size={11} aria-hidden /> {formatFetchedAt(chain.fetchedAt)}</div>
      </div>
      <div style={styles.controls}>
        <label style={styles.field}>策略
          <select value={kind} onChange={(event) => setKind(event.target.value as OptionStrategyKind)} style={styles.select}>
            {OPTION_STRATEGY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label style={styles.field}>中枢行权价
          <select value={centerStrike ?? ""} onChange={(event) => setCenterStrike(Number(event.target.value))} style={styles.select}>
            {strikes.map((strike) => <option key={strike} value={strike}>{money(strike, 2)}</option>)}
          </select>
        </label>
        {twoSided ? <label style={styles.field}>宽度
          <select value={wingSteps} onChange={(event) => setWingSteps(Number(event.target.value))} style={styles.select}>
            {[1, 2, 3].filter((step) => step < strikes.length).map((step) => <option key={step} value={step}>± {step} 档</option>)}
          </select>
        </label> : <>
          <label style={styles.field}>类型
            <select value={singleRight} onChange={(event) => setSingleRight(event.target.value as "call" | "put")} style={styles.select}><option value="call">Call</option><option value="put">Put</option></select>
          </label>
          <label style={styles.field}>方向
            <select value={singleSide} onChange={(event) => setSingleSide(event.target.value as "buy" | "sell")} style={styles.select}><option value="buy">买入</option><option value="sell">卖出</option></select>
          </label>
        </>}
      </div>
      <p style={styles.description}>{definition?.description}。以买入腿的 Ask、卖出腿的 Bid 估值，每张合约按 100 股计算。</p>

      {remoteStrategy ? <RemoteStrategyResult analysis={remoteAnalysis} loading={remoteLoading} error={remoteError} /> : estimate.legs.length === 0 ? <div style={styles.unavailable}>当前到期日没有可组成该策略的合约；请切换中枢行权价或到期日。</div> : <>
        <div style={styles.legs}>
          {estimate.legs.map((leg) => <div key={`${leg.action}-${leg.contract.contractSymbol}`} style={styles.leg}>
            <span style={{ ...styles.action, ...(leg.action === "buy" ? styles.buy : styles.sell) }}>{leg.action === "buy" ? "买入" : "卖出"}</span>
            <strong>{leg.contract.right === "call" ? "CALL" : "PUT"} {money(leg.contract.strike, 2)}</strong>
            <span>{leg.contract.expiration?.slice(0, 10) ?? "—"}</span>
            <span>报价 {money(leg.price, 4)}</span>
          </div>)}
        </div>
        <div style={styles.metrics}>
          <Metric label="净权利金" value={hasCompleteQuote ? `${estimate.netDebit! >= 0 ? "支出" : "收入"} $${money(Math.abs(estimate.netDebit!))}` : "报价不全"} accent={estimate.netDebit != null && estimate.netDebit < 0} />
          <Metric label="净 Δ" value={money(estimate.greeks.delta, 3)} />
          <Metric label="净 Γ" value={money(estimate.greeks.gamma, 3)} />
          <Metric label="净 Θ / 日" value={money(estimate.greeks.theta, 3)} />
          <Metric label="盈亏平衡" value={estimate.breakEvens.length ? estimate.breakEvens.map((value) => `$${money(value)}`).join(" / ") : "—"} />
        </div>
        <div style={styles.scenarios}>
          <span style={styles.scenarioLabel}>到期情景</span>
          {estimate.scenarioPnl.map((scenario) => <span key={scenario.label} style={styles.scenario}><b>{scenario.label} ${money(scenario.price)}</b><em style={{ color: (scenario.pnl ?? 0) >= 0 ? "var(--qb-success, #34d399)" : "var(--qb-danger, #fb7185)" }}>{scenario.pnl == null ? "—" : `${scenario.pnl >= 0 ? "+" : ""}$${money(scenario.pnl)}`}</em></span>)}
        </div>
        <div style={styles.disclaimer}><ShieldAlert size={12} aria-hidden /> 以上为当前期权链快照的到期损益估算，未计佣金、滑点或提前行权；研究级行情不可用于交易决策。</div>
      </>}
    </section>
  );
};

const Metric: FC<{ label: string; value: string; accent?: boolean }> = ({ label, value, accent = false }) => <div style={styles.metric}><span>{label}</span><strong style={accent ? styles.credit : undefined}>{value}</strong></div>;

const RemoteStrategyResult: FC<{ analysis: OptionStrategyAnalysis | null; loading: boolean; error: string | null }> = ({ analysis, loading, error }) => {
  if (!analysis) return <div style={styles.unavailable}>{loading ? "正在由期权策略模块加载多腿报价与损益…" : error ? `策略计算失败：${error}` : "等待策略参数…"}</div>;
  return <>
    <div style={styles.legs}>{analysis.legs.map((leg, index) => <div key={`${leg.kind}-${leg.contractSymbol ?? "stock"}-${index}`} style={styles.leg}>
      <span style={{ ...styles.action, ...(leg.action === "buy" ? styles.buy : styles.sell) }}>{leg.action === "buy" ? "买入" : "卖出"}</span>
      <strong>{leg.kind === "underlying" ? "正股" : `${leg.right?.toUpperCase()} ${money(leg.strike)}`}</strong>
      <span>{leg.expiration?.slice(0, 10) ?? "现货"}</span><span>标记 {money(leg.markPrice, 4)}</span>
    </div>)}</div>
    <div style={styles.metrics}>
      <Metric label="净权利金" value={analysis.netPremium == null ? "报价不全" : `${analysis.netPremium >= 0 ? "支出" : "收入"} $${money(Math.abs(analysis.netPremium))}`} accent={analysis.netPremium != null && analysis.netPremium < 0} />
      <Metric label="盯市盈亏" value={analysis.markToMarketPnl == null ? "—" : `${analysis.markToMarketPnl >= 0 ? "+" : ""}$${money(analysis.markToMarketPnl)}`} />
      <Metric label="最大盈利" value={analysis.risk.maxProfit == null ? "无限" : `$${money(analysis.risk.maxProfit)}`} />
      <Metric label="最大亏损" value={analysis.risk.maxLoss == null ? "未封顶" : `$${money(analysis.risk.maxLoss)}`} />
      <Metric label="盈亏平衡" value={analysis.expiryBreakEvens.length ? analysis.expiryBreakEvens.map((value) => `$${money(value)}`).join(" / ") : "—"} />
    </div>
    <div style={styles.scenarios}><span style={styles.scenarioLabel}>到期情景</span>{analysis.expiryScenarios.map((scenario) => <span key={scenario.label} style={styles.scenario}><b>{scenario.label} ${money(scenario.underlyingPrice)}</b><em style={{ color: (scenario.pnl ?? 0) >= 0 ? "var(--qb-success, #34d399)" : "var(--qb-danger, #fb7185)" }}>{scenario.pnl == null ? "—" : `${scenario.pnl >= 0 ? "+" : ""}$${money(scenario.pnl)}`}</em></span>)}</div>
    {analysis.warnings.map((warning) => <div key={warning} style={styles.disclaimer}><ShieldAlert size={12} aria-hidden /> {warning}</div>)}
    <div style={styles.disclaimer}><ShieldAlert size={12} aria-hidden /> 由本机策略模块按当前快照计算；未计佣金、滑点或提前行权，不能作为交易授权。</div>
  </>;
};

function remoteStrategyName(kind: OptionStrategyKind): string | null {
  const names: Partial<Record<OptionStrategyKind, string>> = {
    covered_call: "covered_call", collar: "collar", calendar: "calendar", diagonal: "diagonal",
    butterfly: "butterfly", condor: "condor", iron_butterfly: "iron_butterfly", iron_condor: "iron_condor", custom: "custom",
  };
  return names[kind] ?? null;
}

function formatFetchedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `链快照 ${new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "链快照已更新";
}

const styles: Record<string, CSSProperties> = {
  root: { margin: "0 10px 8px", border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 6, overflow: "hidden", background: "color-mix(in srgb, var(--qb-main-card-bg, #18181b) 88%, transparent)" },
  titleRow: { minHeight: 31, padding: "0 9px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderBottom: "1px solid var(--qb-main-card-border, #27272a)", background: "var(--qb-kline-embedded-bar-bg, #111114)" },
  title: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--qb-body-fg, #e4e4e7)", fontSize: 11, fontWeight: 700 },
  fetchedAt: { display: "inline-flex", alignItems: "center", gap: 4, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  controls: { display: "flex", alignItems: "end", flexWrap: "wrap", gap: 6, padding: "7px 9px 5px" },
  field: { display: "grid", gap: 3, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 9, letterSpacing: "0.04em" },
  select: { minWidth: 92, maxWidth: 156, padding: "3px 5px", border: "1px solid var(--qb-main-input-border, #3f3f46)", borderRadius: 4, background: "var(--qb-main-input-bg, #18181b)", color: "var(--qb-main-input-fg, #e4e4e7)", fontSize: 11 },
  description: { margin: "0 9px 7px", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, lineHeight: 1.45 },
  unavailable: { margin: "0 9px 8px", padding: "7px", border: "1px dashed var(--qb-main-card-border, #27272a)", color: "var(--qb-warn, #f59e0b)", fontSize: 10 },
  legs: { display: "flex", flexWrap: "wrap", gap: 5, padding: "0 9px 7px" },
  leg: { display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, padding: "4px 6px", border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 4, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  action: { padding: "1px 4px", borderRadius: 2, fontSize: 9, fontWeight: 700 },
  buy: { color: "var(--qb-success, #34d399)", background: "color-mix(in srgb, var(--qb-success, #34d399) 12%, transparent)" },
  sell: { color: "var(--qb-danger, #fb7185)", background: "color-mix(in srgb, var(--qb-danger, #fb7185) 12%, transparent)" },
  metrics: { display: "grid", gridTemplateColumns: "repeat(5, minmax(94px, 1fr))", borderTop: "1px solid var(--qb-main-card-border, #27272a)", borderBottom: "1px solid var(--qb-main-card-border, #27272a)", overflowX: "auto" },
  metric: { minWidth: 94, display: "grid", gap: 2, padding: "6px 8px", borderRight: "1px solid var(--qb-main-card-border, #27272a)", fontVariantNumeric: "tabular-nums" },
  credit: { color: "var(--qb-success, #34d399)" },
  scenarios: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 9, padding: "7px 9px", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  scenarioLabel: { fontWeight: 700 },
  scenario: { display: "inline-flex", gap: 4 },
  disclaimer: { display: "flex", alignItems: "flex-start", gap: 5, padding: "6px 9px", borderTop: "1px solid var(--qb-main-card-border, #27272a)", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 9, lineHeight: 1.45 },
};
