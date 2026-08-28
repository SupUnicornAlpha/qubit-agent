/**
 * Agent Eval 平台：Score 分析 + Experiment（Monitor 告警与评测 tab）。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EvalDatasetRecord, EvalRunRecord } from "../../api/types";
import {
  compareAgentEvalScores,
  diffAgentEvalExperiment,
  getAgentEvalScoreDailyAnalytics,
  listAgentEvalDatasetItems,
  runAgentEvalExperiment,
  type AgentEvalDatasetItemRecord,
  type AgentEvalExperimentDiff,
  type AgentEvalExperimentResult,
  type ScoreCompareResult,
  type ScoreDailyRollupRow,
} from "../../api/backend";
import { dailyRollupToChartRows, formatDeltaPct } from "../../lib/agentEvalFormat";
import { monitorAxisTick, monitorGridStroke, monitorTooltipStyle, styles } from "./monitor-shared";

const WATCHED_SCORES = ["aqm.weighted_score", "benchmark.overall.score", "aqm.A-3"] as const;
const CHART_COLORS = ["#22c55e", "#3b82f6", "#a78bfa"];

export type AgentEvalPlatformPanelProps = {
  projectId: string;
  evalDatasets: EvalDatasetRecord[];
  evalRuns: EvalRunRecord[];
  onRefreshRuns: (datasetId: string) => void | Promise<void>;
};

export const AgentEvalPlatformPanel: FC<AgentEvalPlatformPanelProps> = ({
  projectId,
  evalDatasets,
  evalRuns,
  onRefreshRuns,
}) => {
  const [selectedScore, setSelectedScore] = useState<string>(WATCHED_SCORES[0]);
  const [compare, setCompare] = useState<ScoreCompareResult | null>(null);
  const [dailyRows, setDailyRows] = useState<ScoreDailyRollupRow[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

  const [datasetId, setDatasetId] = useState("");
  const [experimentLabel, setExperimentLabel] = useState("monitor-experiment");
  const [configFingerprint, setConfigFingerprint] = useState("default-v1");
  const [baselineRunId, setBaselineRunId] = useState("");
  const [mode, setMode] = useState<"replay" | "launch">("replay");
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [lastExperiment, setLastExperiment] = useState<AgentEvalExperimentResult | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [datasetItems, setDatasetItems] = useState<AgentEvalDatasetItemRecord[]>([]);

  const [diffBaseline, setDiffBaseline] = useState("");
  const [diffChallenger, setDiffChallenger] = useState("");
  const [diffResult, setDiffResult] = useState<AgentEvalExperimentDiff | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  const chartData = useMemo(() => dailyRollupToChartRows(dailyRows), [dailyRows]);
  const chartScoreNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of dailyRows) names.add(row.name);
    return [...names].sort();
  }, [dailyRows]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const [cmp, daily] = await Promise.all([
        compareAgentEvalScores(selectedScore, 7),
        getAgentEvalScoreDailyAnalytics({ names: [...WATCHED_SCORES] }),
      ]);
      setCompare(cmp);
      setDailyRows(daily);
    } catch (err) {
      setAnalyticsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyticsLoading(false);
    }
  }, [selectedScore]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  useEffect(() => {
    if (!datasetId) {
      setDatasetItems([]);
      return;
    }
    void listAgentEvalDatasetItems(datasetId)
      .then(setDatasetItems)
      .catch(() => setDatasetItems([]));
  }, [datasetId]);

  useEffect(() => {
    if (!datasetId && evalDatasets[0]?.id) setDatasetId(evalDatasets[0].id);
  }, [datasetId, evalDatasets]);

  const onRunExperiment = async () => {
    if (!datasetId || !projectId) {
      setExperimentError("需要选择 dataset 与 project");
      return;
    }
    setExperimentBusy(true);
    setExperimentError(null);
    try {
      const result = await runAgentEvalExperiment({
        datasetId,
        experimentLabel,
        configFingerprint,
        projectId,
        mode,
        ...(baselineRunId.trim() ? { baselineRunId: baselineRunId.trim() } : {}),
        waitTimeoutMs: 120_000,
      });
      setLastExperiment(result);
      setDiffChallenger(result.runId);
      if (result.baselineRunId) setDiffBaseline(result.baselineRunId);
      await onRefreshRuns(datasetId);
    } catch (err) {
      setExperimentError(err instanceof Error ? err.message : String(err));
    } finally {
      setExperimentBusy(false);
    }
  };

  const onDiff = async () => {
    if (!diffBaseline.trim() || !diffChallenger.trim()) {
      setExperimentError("请填写 baseline 与 challenger runId");
      return;
    }
    setDiffBusy(true);
    setExperimentError(null);
    try {
      setDiffResult(await diffAgentEvalExperiment(diffBaseline.trim(), diffChallenger.trim()));
    } catch (err) {
      setExperimentError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Agent Eval 平台 · Score 分析
      </h3>
      <div style={styles.form}>
        <select
          style={styles.select}
          value={selectedScore}
          onChange={(e) => setSelectedScore(e.target.value)}
        >
          {WATCHED_SCORES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="qb-btn-secondary"
          onClick={() => void loadAnalytics()}
          disabled={analyticsLoading}
        >
          刷新分析
        </button>
      </div>
      {analyticsError ? <div style={{ color: "#f87171", fontSize: 12 }}>{analyticsError}</div> : null}
      {compare ? (
        <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
          <div style={styles.kpi}>
            <div style={styles.kpiLabel}>近 7 日均值</div>
            <div style={styles.kpiValue}>
              {compare.recentAvg != null ? compare.recentAvg.toFixed(3) : "—"}
            </div>
          </div>
          <div style={styles.kpi}>
            <div style={styles.kpiLabel}>前 7 日均值</div>
            <div style={styles.kpiValue}>
              {compare.baselineAvg != null ? compare.baselineAvg.toFixed(3) : "—"}
            </div>
          </div>
          <div style={styles.kpi}>
            <div style={styles.kpiLabel}>环比</div>
            <div
              style={{
                ...styles.kpiValue,
                color:
                  compare.deltaPct != null && compare.deltaPct < -15
                    ? "#f87171"
                    : compare.deltaPct != null && compare.deltaPct > 0
                      ? "#22c55e"
                      : undefined,
              }}
            >
              {formatDeltaPct(compare.deltaPct)}
            </div>
          </div>
          <div style={styles.kpi}>
            <div style={styles.kpiLabel}>样本数</div>
            <div style={styles.kpiValue}>
              {compare.recentCount} / {compare.baselineCount}
            </div>
          </div>
        </div>
      ) : null}
      {chartData.length > 0 ? (
        <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
          <div style={styles.chartTitle}>Score 日趋势（均值）</div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
              <XAxis dataKey="day" tick={monitorAxisTick} />
              <YAxis domain={[0, 1]} tick={monitorAxisTick} />
              <Tooltip contentStyle={monitorTooltipStyle} />
              <Legend />
              {chartScoreNames.map((name, idx) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  name={name}
                  stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div style={styles.hint}>暂无 Score 日聚合数据（workflow 终态后会写入 agent_score）</div>
      )}

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Agent Eval 平台 · Experiment
      </h3>
      <div style={styles.form}>
        <select style={styles.select} value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
          <option value="">选择 dataset</option>
          {evalDatasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}@{d.version}
            </option>
          ))}
        </select>
        <input
          style={styles.input}
          placeholder="experimentLabel"
          value={experimentLabel}
          onChange={(e) => setExperimentLabel(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="configFingerprint"
          value={configFingerprint}
          onChange={(e) => setConfigFingerprint(e.target.value)}
        />
        <select style={styles.select} value={mode} onChange={(e) => setMode(e.target.value as "replay" | "launch")}>
          <option value="replay">replay</option>
          <option value="launch">launch</option>
        </select>
        <input
          style={styles.input}
          placeholder="baselineRunId（可选）"
          value={baselineRunId}
          onChange={(e) => setBaselineRunId(e.target.value)}
        />
        <button
          type="button"
          className="qb-btn-primary-brand"
          disabled={experimentBusy || !datasetId || !projectId}
          onClick={() => void onRunExperiment()}
        >
          运行 Experiment
        </button>
      </div>
      {!projectId ? (
        <div style={styles.hint}>请在顶部 toolbar 选择 project 后再运行 Experiment</div>
      ) : null}
      {datasetItems.length > 0 ? (
        <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)", marginBottom: 8 }}>
          Dataset 含 {datasetItems.length} 条 case
        </div>
      ) : null}
      {experimentError ? <div style={{ color: "#f87171", fontSize: 12 }}>{experimentError}</div> : null}
      {lastExperiment ? (
        <pre style={styles.streamBox}>
          {`runId: ${lastExperiment.runId}
passRate: ${(lastExperiment.summary.passRate * 100).toFixed(1)}%
avgScore: ${lastExperiment.summary.avgScore.toFixed(3)}
cases: ${lastExperiment.summary.caseCount}`}
        </pre>
      ) : null}

      <div style={{ ...styles.form, marginTop: 8 }}>
        <input
          style={styles.input}
          placeholder="baselineRunId"
          value={diffBaseline}
          onChange={(e) => setDiffBaseline(e.target.value)}
        />
        <input
          style={styles.input}
          placeholder="challengerRunId"
          value={diffChallenger}
          onChange={(e) => setDiffChallenger(e.target.value)}
        />
        <button type="button" className="qb-btn-secondary" disabled={diffBusy} onClick={() => void onDiff()}>
          对比 Diff
        </button>
      </div>
      {evalRuns.length > 0 ? (
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          最近 runs：
          {evalRuns.slice(0, 5).map((run) => (
            <button
              key={run.id}
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => setDiffChallenger(run.id)}
              title="填入 challenger"
            >
              {run.id.slice(0, 8)}…
            </button>
          ))}
        </div>
      ) : null}
      {diffResult ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>caseKey</th>
                <th style={styles.th}>baseline</th>
                <th style={styles.th}>challenger</th>
                <th style={styles.th}>delta</th>
              </tr>
            </thead>
            <tbody>
              {diffResult.rows.slice(0, 30).map((row) => (
                <tr key={row.caseKey} style={styles.tr}>
                  <td style={styles.td}>{row.caseKey}</td>
                  <td style={styles.td}>{row.baselineScore?.toFixed(3) ?? "—"}</td>
                  <td style={styles.td}>{row.challengerScore?.toFixed(3) ?? "—"}</td>
                  <td style={styles.td}>{row.delta?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 12, padding: 8 }}>
            improved {diffResult.summary.improved} · regressed {diffResult.summary.regressed} · unchanged{" "}
            {diffResult.summary.unchanged}
          </div>
        </div>
      ) : null}
    </>
  );
};
