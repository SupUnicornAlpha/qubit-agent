/**
 * 监控 · Skills tab：按 skill 聚合 + 失败列表。
 *
 * 数据源：agent_skill_run（显式归因，详见 docs/MONITORING_V2_DESIGN.md §4.1.4）。
 * 父 MonitorDashboard 只需要传 sessionFilter 与跳 workflow 的回调；自身轮询。
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listMonitorSkillsSummary, type MonitorSkillSummaryRow } from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";
import { FailuresPanel } from "./FailuresPanel";

export type SkillsTabProps = {
  sessionFilter?: string | undefined;
  onJumpToWorkflow?: (workflowRunId: string) => void;
};

const WINDOW_PRESETS = [60, 240, 1440, 4320] as const;

export const SkillsTab: FC<SkillsTabProps> = ({ sessionFilter, onJumpToWorkflow }) => {
  const [windowMinutes, setWindowMinutes] = useState<number>(1440);
  const [rows, setRows] = useState<MonitorSkillSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params: Parameters<typeof listMonitorSkillsSummary>[0] = { windowMinutes };
      if (sessionFilter) params.sessionId = sessionFilter;
      const data = await listMonitorSkillsSummary(params);
      setRows(data);
      setHint(data.length === 0 ? "窗口内无 skill 执行记录（确认 agent_skill_run 已写入）" : null);
    } catch (e) {
      setHint(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [windowMinutes, sessionFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const kpis = useMemo(() => {
    let totalRuns = 0;
    let success = 0;
    let fail = 0;
    let partial = 0;
    for (const r of rows) {
      totalRuns += r.totalRuns;
      success += r.successCount;
      fail += r.failCount;
      partial += r.partialCount;
    }
    return {
      totalRuns,
      success,
      fail,
      partial,
      successRate: totalRuns > 0 ? Number(((success / totalRuns) * 100).toFixed(1)) : null,
    };
  }, [rows]);

  return (
    <>
      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Skills · 调用聚合（按显式 agent_skill_run）
      </h3>

      <div style={styles.form}>
        <select
          style={styles.select}
          value={windowMinutes}
          onChange={(e) => setWindowMinutes(Number(e.target.value))}
        >
          {WINDOW_PRESETS.map((m) => (
            <option key={m} value={m}>
              近 {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
            </option>
          ))}
        </select>
        <button className="qb-btn-secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>

      <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
        <Kpi label="窗口召回数" value={String(kpis.totalRuns)} />
        <Kpi label="成功" value={String(kpis.success)} accent="#22c55e" />
        <Kpi label="失败" value={String(kpis.fail)} accent="#ef4444" />
        <Kpi label="部分成功" value={String(kpis.partial)} accent="#eab308" />
        <Kpi
          label="成功率"
          value={kpis.successRate != null ? `${kpis.successRate}%` : "—"}
          accent="#a78bfa"
        />
      </div>

      {hint ? <div style={styles.hint}>{hint}</div> : null}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Skill</th>
              <th style={styles.th}>分类</th>
              <th style={styles.th}>调用</th>
              <th style={styles.th}>成功</th>
              <th style={styles.th}>失败</th>
              <th style={styles.th}>部分</th>
              <th style={styles.th}>成功率</th>
              <th style={styles.th}>均分</th>
              <th style={styles.th}>最近使用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.skillId}>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }} title={r.skillId}>
                  {r.skillName}
                </td>
                <td style={styles.td}>{r.category}</td>
                <td style={styles.td}>{r.totalRuns}</td>
                <td style={{ ...styles.td, color: "#22c55e" }}>{r.successCount}</td>
                <td style={{ ...styles.td, color: r.failCount > 0 ? "#ef4444" : undefined }}>{r.failCount}</td>
                <td style={styles.td}>{r.partialCount}</td>
                <td style={styles.td}>{`${(r.successRate * 100).toFixed(1)}%`}</td>
                <td style={styles.td}>{r.avgScore != null ? r.avgScore.toFixed(3) : "—"}</td>
                <td style={styles.td}>{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading ? <div style={styles.empty}>无数据</div> : null}
      </div>

      <h3 className="qb-monitor__section" style={styles.subTitle}>
        Skills · 失败列表
      </h3>
      <FailuresPanel
        defaultScope="skill"
        defaultWindowMinutes={windowMinutes}
        defaultLimit={20}
        sessionId={sessionFilter || undefined}
        autoRefreshMs={30_000}
        onSelectWorkflow={onJumpToWorkflow}
        title="Skill 失败"
      />
    </>
  );
};
