import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getRecommendationStats,
  listRecommendations,
  runRecommendationOutcomes,
} from "../../api/backend";
import type {
  RecommendationHorizonStats,
  RecommendationOutcomeRecord,
  RecommendationRecord,
  RecommendationStats,
  RecommendationStatus,
} from "../../api/types";

export const RecommendationsTab: FC<{ projectId: string }> = ({ projectId }) => {
  const [rows, setRows] = useState<RecommendationRecord[]>([]);
  const [stats, setStats] = useState<RecommendationStats | null>(null);
  const [status, setStatus] = useState<RecommendationStatus | "all">("all");
  const [symbol, setSymbol] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [horizonDays, setHorizonDays] = useState(20);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [nextRows, nextStats] = await Promise.all([
        listRecommendations({
          projectId,
          ...(status !== "all" ? { status } : {}),
          ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
          limit: 200,
        }),
        getRecommendationStats(projectId),
      ]);
      setRows(nextRows);
      setStats(nextStats);
      setSelectedId((current) =>
        current && nextRows.some((row) => row.id === current) ? current : (nextRows[0]?.id ?? null)
      );
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "推荐数据加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, status, symbol]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId]
  );
  const horizonStats = useMemo(
    () => stats?.horizonStats.find((item) => item.horizonDays === horizonDays) ?? null,
    [stats, horizonDays]
  );

  const runOutcomes = async () => {
    setLoading(true);
    try {
      const result = await runRecommendationOutcomes({ projectId, limit: 100 });
      setMessage(
        `评估完成：扫描 ${result.scanned}，成熟 ${result.evaluated}，待更多行情 ${result.notReady}，无效 ${result.invalid}，失败 ${result.failed}`
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "后验评估失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section style={ui.root} aria-label="推荐效果">
      <div style={ui.hero}>
        <div>
          <div style={ui.eyebrow}>DECISION SIGNALS</div>
          <h2 style={ui.title}>推荐效果</h2>
          <p style={ui.subtitle}>
            先看结论是否有效，再回到 Agent 过程。所有收益均来自推荐后的真实行情回放。
          </p>
        </div>
        <button
          type="button"
          className="qb-btn-primary-brand"
          disabled={loading}
          onClick={() => void runOutcomes()}
        >
          {loading ? "评估中…" : "运行后验评估"}
        </button>
      </div>

      <div style={ui.horizonBar}>
        <div>
          <strong>推荐回测窗口</strong>
          <span style={ui.horizonHint}>统一比较方向命中、收益路径与置信度可信度</span>
        </div>
        <div style={ui.horizonTabs}>
          {[1, 5, 20, 60].map((days) => (
            <button
              key={days}
              type="button"
              className={days === horizonDays ? "qb-btn-primary-brand" : "qb-btn-secondary"}
              onClick={() => setHorizonDays(days)}
            >
              {days} 日
            </button>
          ))}
        </div>
      </div>

      <div style={ui.kpis}>
        <Kpi label="有效推荐" value={formatNumber(stats?.active)} />
        <Kpi label={`${horizonDays} 日样本`} value={formatNumber(horizonStats?.mature)} />
        <Kpi
          label="方向胜率"
          value={formatPct(horizonStats?.winRatePct)}
          accent={scoreColor(horizonStats?.winRatePct)}
        />
        <Kpi
          label="平均收益"
          value={formatPct(horizonStats?.avgReturnPct)}
          accent={scoreColor(horizonStats?.avgReturnPct)}
        />
        <Kpi
          label="平均超额"
          value={formatPct(horizonStats?.avgExcessReturnPct)}
          accent={scoreColor(horizonStats?.avgExcessReturnPct)}
        />
        <Kpi label="平均 MAE" value={formatPct(horizonStats?.avgMaePct)} />
        <Kpi label="平均 MFE" value={formatPct(horizonStats?.avgMfePct)} />
      </div>

      <CalibrationPanel stats={horizonStats} />

      <div style={ui.filters}>
        <input
          style={ui.input}
          value={symbol}
          onChange={(event) => setSymbol(event.target.value.toUpperCase())}
          placeholder="筛选标的，如 AAPL / 600519"
          aria-label="筛选推荐标的"
        />
        <select
          style={ui.input}
          value={status}
          onChange={(event) => setStatus(event.target.value as RecommendationStatus | "all")}
        >
          <option value="all">全部状态</option>
          <option value="active">有效</option>
          <option value="closed">已验证</option>
          <option value="draft">草稿</option>
          <option value="expired">已过期</option>
          <option value="invalidated">已失效</option>
        </select>
        <button type="button" className="qb-btn-secondary" onClick={() => void refresh()}>
          刷新
        </button>
        {message ? <span style={ui.message}>{message}</span> : null}
      </div>

      <div style={ui.workspace}>
        <div style={ui.list}>
          {rows.length === 0 ? (
            <div style={ui.empty}>
              暂无结构化推荐。运行股票推荐场景后，DecisionSignal 会出现在这里。
            </div>
          ) : (
            rows.map((row) => {
              const outcome = outcomeForHorizon(row, horizonDays);
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  style={{ ...ui.row, ...(selectedId === row.id ? ui.rowSelected : {}) }}
                >
                  <div style={ui.rowHead}>
                    <strong>{row.symbol}</strong>
                    <SignalBadge side={row.side} />
                  </div>
                  <div style={ui.rowMeta}>
                    {row.market} · {row.horizonDays} 日 · 置信度 {(row.confidence * 100).toFixed(0)}
                    %
                  </div>
                  <div style={ui.rowOutcome}>
                    {outcome
                      ? `${horizonDays} 日 · ${outcomeLabel(outcome.outcome)} ${formatPct(outcome.returnPct)}`
                      : "等待后验行情"}
                  </div>
                </button>
              );
            })
          )}
        </div>
        <div style={ui.detail}>
          {selected ? (
            <RecommendationDetail row={selected} horizonDays={horizonDays} />
          ) : (
            <div style={ui.empty}>选择一条推荐查看交易计划与验证结果。</div>
          )}
        </div>
      </div>
    </section>
  );
};

const RecommendationDetail: FC<{ row: RecommendationRecord; horizonDays: number }> = ({
  row,
  horizonDays,
}) => {
  const outcome = outcomeForHorizon(row, horizonDays);
  return (
    <div>
      <div style={ui.detailHead}>
        <div>
          <div style={ui.eyebrow}>
            {row.market} · {new Date(row.asof).toLocaleString()}
          </div>
          <h3 style={ui.detailTitle}>
            {row.symbol} <SignalBadge side={row.side} />
          </h3>
        </div>
        <div style={ui.confidence}>
          {(row.confidence * 100).toFixed(0)}%<span>置信度</span>
        </div>
      </div>
      <div style={ui.planGrid}>
        <Plan label="入场区间" value={formatRange(row.entryLow, row.entryHigh)} />
        <Plan label="止损" value={formatPrice(row.stopLoss)} tone="#f87171" />
        <Plan label="目标" value={formatPrice(row.takeProfit)} tone="#4ade80" />
        <Plan
          label="风险收益比"
          value={row.riskRewardRatio == null ? "—" : `${row.riskRewardRatio.toFixed(2)} : 1`}
        />
        <Plan
          label="建议仓位"
          value={row.positionSizePct == null ? "—" : `${(row.positionSizePct * 100).toFixed(0)}%`}
        />
        <Plan label="状态" value={row.status} />
      </div>
      <Block title="投资理由" content={row.rationale || "未提供"} />
      <Block title="失效条件" content={formatList(row.invalidationJson)} />
      <Block title="观察条件" content={formatList(row.watchConditionsJson)} />
      <div style={ui.block}>
        <div style={ui.blockTitle}>多周期回测</div>
        <div style={ui.outcomeMatrix}>
          {[1, 5, 20, 60].map((days) => {
            const item = outcomeForHorizon(row, days);
            return (
              <div
                key={days}
                style={{ ...ui.matrixCell, ...(days === horizonDays ? ui.matrixCellActive : {}) }}
              >
                <span>{days} 日</span>
                <strong>{item ? outcomeLabel(item.outcome) : "待评估"}</strong>
                <small>{item ? formatPct(item.returnPct) : "—"}</small>
              </div>
            );
          })}
        </div>
      </div>
      {outcome ? (
        <div style={ui.outcomePanel}>
          <div style={ui.blockTitle}>{horizonDays} 日后验结果</div>
          <div style={ui.planGrid}>
            <Plan label="结果" value={outcomeLabel(outcome.outcome)} />
            <Plan
              label="模拟收益"
              value={formatPct(outcome.returnPct)}
              tone={scoreColor(outcome.returnPct)}
            />
            <Plan
              label="超额收益"
              value={formatPct(outcome.excessReturnPct)}
              tone={scoreColor(outcome.excessReturnPct)}
            />
            <Plan label="MAE" value={formatPct(outcome.maxAdverseExcursionPct)} tone="#f87171" />
            <Plan label="MFE" value={formatPct(outcome.maxFavorableExcursionPct)} tone="#4ade80" />
            <Plan label="退出原因" value={outcome.exitReason ?? "—"} />
            <Plan label="观测 K 线" value={String(outcome.barsObserved)} />
          </div>
          {outcome.ambiguousBar ? (
            <div style={ui.warning}>同一根 K 线同时触发止盈和止损，已按保守口径使用止损价。</div>
          ) : null}
          {outcome.evaluationError ? <div style={ui.warning}>{outcome.evaluationError}</div> : null}
        </div>
      ) : null}
    </div>
  );
};

const CalibrationPanel: FC<{ stats: RecommendationHorizonStats | null }> = ({ stats }) => (
  <div style={ui.calibration}>
    <div style={ui.calibrationHead}>
      <div>
        <div style={ui.blockTitle}>置信度校准</div>
        <span style={ui.horizonHint}>置信度应接近同分桶真实命中率；越一致越可信。</span>
      </div>
      <div style={ui.calibrationScores}>
        <span>
          Brier <strong>{formatScore(stats?.brierScore)}</strong>
        </span>
        <span>
          ECE <strong>{formatScore(stats?.ece)}</strong>
        </span>
      </div>
    </div>
    <div style={ui.calibrationBins}>
      {(stats?.calibrationBins ?? []).map((bin) => (
        <div key={bin.minConfidence} style={ui.calibrationBin}>
          <span>
            {Math.round(bin.minConfidence * 100)}–{Math.round(bin.maxConfidence * 100)}%
          </span>
          <strong>{bin.accuracyPct == null ? "—" : `${bin.accuracyPct.toFixed(0)}%`}</strong>
          <small>
            n={bin.count} · 均值{" "}
            {bin.avgConfidence == null ? "—" : `${(bin.avgConfidence * 100).toFixed(0)}%`}
          </small>
        </div>
      ))}
      {!stats ? <span style={ui.horizonHint}>暂无成熟样本</span> : null}
    </div>
  </div>
);

const Kpi: FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div style={ui.kpi}>
    <span>{label}</span>
    <strong style={{ color: accent }}>{value}</strong>
  </div>
);
const Plan: FC<{ label: string; value: string; tone?: string }> = ({ label, value, tone }) => (
  <div style={ui.plan}>
    <span>{label}</span>
    <strong style={{ color: tone }}>{value}</strong>
  </div>
);
const Block: FC<{ title: string; content: string }> = ({ title, content }) => (
  <div style={ui.block}>
    <div style={ui.blockTitle}>{title}</div>
    <div style={ui.blockContent}>{content}</div>
  </div>
);
const SignalBadge: FC<{ side: RecommendationRecord["side"] }> = ({ side }) => (
  <span
    style={{
      ...ui.badge,
      color: side === "long" ? "#4ade80" : side === "short" ? "#f87171" : "#fbbf24",
    }}
  >
    {side === "long" ? "LONG" : side === "short" ? "SHORT" : "NEUTRAL"}
  </span>
);

function formatNumber(value: number | null | undefined): string {
  return value == null ? "—" : String(value);
}
function formatPct(value: number | null | undefined): string {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function formatScore(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(3);
}
function formatPrice(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}
function formatRange(low: number | null, high: number | null): string {
  if (low == null && high == null) return "首个可用收盘价";
  if (low == null || high == null) return formatPrice(low ?? high);
  return `${Math.min(low, high).toFixed(2)} – ${Math.max(low, high).toFixed(2)}`;
}
function formatList(value: unknown[]): string {
  return value.length ? value.map(String).join("；") : "未提供";
}
function outcomeForHorizon(
  row: RecommendationRecord,
  horizonDays: number
): RecommendationOutcomeRecord | null {
  return row.outcomes?.find((item) => item.horizonDays === horizonDays) ?? null;
}
function outcomeLabel(value: RecommendationOutcomeRecord["outcome"]): string {
  return (
    (
      { pending: "等待验证", win: "命中", loss: "未命中", flat: "中性", invalid: "无效" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}
function scoreColor(value: number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return value > 0 ? "#4ade80" : value < 0 ? "#f87171" : "#fbbf24";
}

const ui: Record<string, CSSProperties> = {
  root: { display: "flex", flexDirection: "column", gap: 14 },
  hero: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 20,
    padding: "18px 20px",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 12,
    background: "linear-gradient(135deg, rgba(124,58,237,.14), rgba(34,211,238,.05))",
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: ".14em",
    color: "var(--qb-main-meta, #71717a)",
    marginBottom: 5,
  },
  title: { margin: 0, fontSize: 24 },
  subtitle: {
    margin: "6px 0 0",
    maxWidth: 680,
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  kpis: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 },
  horizonBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    padding: "10px 12px",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 9,
    background: "var(--qb-main-card-bg, #111114)",
    fontSize: 12,
  },
  horizonHint: {
    display: "block",
    marginTop: 3,
    fontSize: 10,
    color: "var(--qb-main-meta, #71717a)",
  },
  horizonTabs: { display: "flex", gap: 6 },
  kpi: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    padding: "12px 14px",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 9,
    background: "var(--qb-main-card-bg, #111114)",
    fontSize: 11,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  filters: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  input: {
    minHeight: 34,
    padding: "6px 10px",
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    borderRadius: 7,
    background: "var(--qb-main-card-bg, #111114)",
    color: "inherit",
  },
  message: { fontSize: 11, color: "#fbbf24" },
  calibration: {
    padding: "12px 14px",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 9,
    background: "var(--qb-main-card-bg, #111114)",
  },
  calibrationHead: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "center",
  },
  calibrationScores: {
    display: "flex",
    gap: 14,
    fontSize: 11,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  calibrationBins: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(90px, 1fr))",
    gap: 7,
    marginTop: 10,
  },
  calibrationBin: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: 9,
    borderRadius: 7,
    background: "rgba(255,255,255,.025)",
    fontSize: 10,
    color: "var(--qb-main-meta, #71717a)",
  },
  workspace: {
    display: "grid",
    gridTemplateColumns: "minmax(240px, 320px) minmax(0, 1fr)",
    gap: 10,
    minHeight: 480,
  },
  list: { display: "flex", flexDirection: "column", gap: 7, overflow: "auto", maxHeight: 650 },
  row: {
    textAlign: "left",
    padding: 12,
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 9,
    background: "var(--qb-main-card-bg, #111114)",
    color: "inherit",
    cursor: "pointer",
  },
  rowSelected: { borderColor: "#7c3aed", background: "rgba(124,58,237,.12)" },
  rowHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  rowMeta: { marginTop: 5, fontSize: 10, color: "var(--qb-main-meta, #71717a)" },
  rowOutcome: { marginTop: 8, fontSize: 12 },
  detail: {
    padding: 18,
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 10,
    background: "var(--qb-main-card-bg, #111114)",
    overflow: "auto",
  },
  detailHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 16,
    marginBottom: 16,
  },
  detailTitle: { display: "flex", alignItems: "center", gap: 10, margin: 0, fontSize: 23 },
  confidence: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    fontSize: 24,
    fontWeight: 700,
    color: "#a78bfa",
  },
  planGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 8,
  },
  plan: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    padding: "10px 12px",
    borderRadius: 8,
    background: "rgba(255,255,255,.025)",
    fontSize: 10,
    color: "var(--qb-main-meta, #71717a)",
  },
  block: {
    marginTop: 16,
    paddingTop: 14,
    borderTop: "1px solid var(--qb-main-input-border, #27272a)",
  },
  blockTitle: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: ".05em",
    color: "var(--qb-main-meta, #a1a1aa)",
    marginBottom: 7,
  },
  blockContent: { fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap" },
  outcomePanel: {
    marginTop: 18,
    padding: 14,
    border: "1px solid rgba(34,197,94,.25)",
    borderRadius: 9,
    background: "rgba(34,197,94,.04)",
  },
  outcomeMatrix: { display: "grid", gridTemplateColumns: "repeat(4, minmax(90px, 1fr))", gap: 8 },
  matrixCell: {
    display: "flex",
    flexDirection: "column",
    gap: 5,
    padding: 10,
    border: "1px solid var(--qb-main-input-border, #27272a)",
    borderRadius: 8,
    fontSize: 10,
    color: "var(--qb-main-meta, #71717a)",
  },
  matrixCellActive: { borderColor: "#7c3aed", background: "rgba(124,58,237,.1)" },
  warning: { marginTop: 9, fontSize: 11, color: "#fbbf24" },
  empty: {
    padding: 24,
    textAlign: "center",
    fontSize: 12,
    lineHeight: 1.7,
    color: "var(--qb-main-meta, #71717a)",
  },
  badge: { fontSize: 10, fontWeight: 800, letterSpacing: ".08em" },
};
