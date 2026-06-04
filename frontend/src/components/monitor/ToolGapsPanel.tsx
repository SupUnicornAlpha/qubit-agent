/**
 * Self-Evolving Agent P7 — Memory > Tool Gaps sub-tab
 *
 * 数据流：
 *   - tool_gap_log  → 列表（按 status/kind 过滤；按 occurrenceCount + lastSeenAt 倒序）
 *   - tool_gap_run  → 顶部 KPI（最近 1 次 + 累计）
 *   - 点击行 → 详情；可 wont-fix / reopen
 *   - "Report a gap" 按钮 → 弹简表单 → POST /tool-gaps/report
 *
 * 设计原则：
 *   - 跟 SkillPromotionsPanel 的视觉/交互保持一致（KPI 行 + 表格 + 右侧详情）。
 *   - 写操作（wont-fix / reopen / report）失败时 toast 提示，不破坏列表。
 */

import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AutoInstallProposalItem,
  type AutoInstallerRunItem,
  type ProposalState,
  type ToolGapDetectionKind,
  type ToolGapListItem,
  type ToolGapRunSummary,
  type ToolGapStatus,
  approveAutoInstallProposal,
  listAutoInstallProposals,
  listAutoInstallerRuns,
  listToolGapRuns,
  listToolGaps,
  markToolGapWontFix,
  rejectAutoInstallProposal,
  reopenToolGap,
  reportToolGap,
} from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";

type FilterStatus = ToolGapStatus | "all";

const KIND_OPTIONS: Array<{ id: ToolGapDetectionKind | "all"; label: string }> = [
  { id: "all", label: "全部" },
  { id: "unknown_tool", label: "unknown_tool" },
  { id: "repeated_fail", label: "repeated_fail" },
  { id: "reflective_mention", label: "reflective_mention" },
  { id: "explicit_report", label: "explicit_report" },
];

const STATUS_OPTIONS: Array<{ id: FilterStatus; label: string }> = [
  { id: "open", label: "Open" },
  { id: "proposed", label: "Proposed" },
  { id: "installed", label: "Installed" },
  { id: "wont_fix", label: "Won't Fix" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "全部" },
];

function fmtTs(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function shortId(id?: string | null): string {
  if (!id) return "";
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function kindAccent(k: ToolGapDetectionKind): string {
  switch (k) {
    case "unknown_tool":
      return "#f87171";
    case "repeated_fail":
      return "#eab308";
    case "reflective_mention":
      return "#a78bfa";
    case "explicit_report":
      return "#22c55e";
  }
}

function statusAccent(s: ToolGapStatus): string {
  switch (s) {
    case "open":
      return "#3b82f6";
    case "proposed":
      return "#a78bfa";
    case "installed":
      return "#22c55e";
    case "wont_fix":
      return "#a1a1aa";
    case "rejected":
      return "#f87171";
  }
}

export type ToolGapsPanelProps = {
  projectId: string;
  autoRefresh: boolean;
};

export const ToolGapsPanel: FC<ToolGapsPanelProps> = ({ projectId, autoRefresh }) => {
  const [status, setStatus] = useState<FilterStatus>("open");
  const [kind, setKind] = useState<ToolGapDetectionKind | "all">("all");
  const [items, setItems] = useState<ToolGapListItem[]>([]);
  const [runs, setRuns] = useState<ToolGapRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const [list, runList] = await Promise.all([
        listToolGaps({
          projectId,
          status,
          ...(kind !== "all" ? { kind } : {}),
          limit: 100,
        }),
        listToolGapRuns({ projectId, limit: 10 }),
      ]);
      setItems(list);
      setRuns(runList);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
      setItems([]);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, status, kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!autoRefresh || !projectId) return;
    const t = window.setInterval(() => void reload(), 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, reload]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  );

  const handleWontFix = useCallback(
    async (id: string) => {
      const reason = window.prompt("标记为 wont_fix 的原因（可空）：", "") ?? "";
      setActionErr(null);
      try {
        await markToolGapWontFix(id, { reason: reason || undefined });
        await reload();
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      }
    },
    [reload]
  );

  const handleReopen = useCallback(
    async (id: string) => {
      const reason = window.prompt("重新打开的原因（可空）：", "") ?? "";
      setActionErr(null);
      try {
        await reopenToolGap(id, { reason: reason || undefined });
        await reload();
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      }
    },
    [reload]
  );

  return (
    <div style={{ minWidth: 0 }}>
      <RunsBar runs={runs} onRefresh={() => void reload()} />

      <div style={styles.split}>
        <div style={styles.col}>
          <FilterBar
            status={status}
            setStatus={setStatus}
            kind={kind}
            setKind={setKind}
            onRefresh={() => void reload()}
            onReport={() => setReportOpen(true)}
          />
          {actionErr ? (
            <div style={{ ...styles.empty, color: "#f87171" }}>动作失败：{actionErr}</div>
          ) : null}
          <ListTable
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={loading}
            error={err}
          />
        </div>
        <div style={styles.col}>
          <DetailPanel item={selected} onWontFix={handleWontFix} onReopen={handleReopen} />
        </div>
      </div>

      <ProposalsSection projectId={projectId} autoRefresh={autoRefresh} />

      {reportOpen ? (
        <ReportDialog
          projectId={projectId}
          onClose={() => setReportOpen(false)}
          onCreated={() => {
            setReportOpen(false);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
};

const RunsBar: FC<{ runs: ToolGapRunSummary[]; onRefresh: () => void }> = ({ runs, onRefresh }) => {
  const latest = runs[0];
  const total = runs.reduce(
    (acc, r) => ({
      signals: acc.signals + r.totalSignals,
      created: acc.created + r.gapsCreated,
      incremented: acc.incremented + r.gapsIncremented,
      skipped: acc.skipped + r.gapsSkipped,
    }),
    { signals: 0, created: 0, incremented: 0, skipped: 0 }
  );
  return (
    <section style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h3 style={{ ...styles.subTitle, margin: 0 }}>ToolGapWatcher · 跑批概览</h3>
        <button
          type="button"
          className="qb-btn-secondary"
          style={{ fontSize: 11, padding: "3px 10px" }}
          onClick={onRefresh}
        >
          刷新
        </button>
      </div>
      {runs.length === 0 ? (
        <div style={styles.empty}>
          暂无 watcher 跑批记录。运行{" "}
          <code>bun run src/scripts/run-tool-gap-watcher.ts --projectId=...</code> 触发。
        </div>
      ) : (
        <>
          <div style={styles.kpiRow}>
            {latest ? (
              <>
                <Kpi
                  label="最近 run · signals"
                  value={String(latest.totalSignals)}
                  accent="#3b82f6"
                />
                <Kpi
                  label="最近 run · created"
                  value={String(latest.gapsCreated)}
                  accent="#22c55e"
                />
                <Kpi
                  label="最近 run · incremented"
                  value={String(latest.gapsIncremented)}
                  accent="#a78bfa"
                />
                <Kpi
                  label="最近 run · status"
                  value={latest.status}
                  accent={latest.status === "failed" ? "#f87171" : "#22c55e"}
                />
                <Kpi label="elapsed" value={`${latest.elapsedMs}ms`} accent="#eab308" />
              </>
            ) : null}
            <Kpi
              label={`累计 (${runs.length} run)`}
              value={`${total.signals}sig / ${total.created}new`}
              accent="#71717a"
            />
          </div>
          {latest?.errorMessage ? (
            <div style={{ ...styles.empty, color: "#f87171" }}>
              last error: {latest.errorMessage}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
};

const FilterBar: FC<{
  status: FilterStatus;
  setStatus: (v: FilterStatus) => void;
  kind: ToolGapDetectionKind | "all";
  setKind: (v: ToolGapDetectionKind | "all") => void;
  onRefresh: () => void;
  onReport: () => void;
}> = ({ status, setStatus, kind, setKind, onRefresh, onReport }) => (
  <section style={{ marginBottom: 10 }}>
    <h3 style={{ ...styles.subTitle, margin: "0 0 8px" }}>Tool Gaps · 列表</h3>
    <div style={styles.form}>
      <select
        value={status}
        onChange={(e) => setStatus(e.target.value as FilterStatus)}
        style={styles.select}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value as ToolGapDetectionKind | "all")}
        style={styles.select}
      >
        {KIND_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="qb-btn-secondary"
        style={{ fontSize: 11, padding: "3px 10px" }}
        onClick={onRefresh}
      >
        刷新
      </button>
      <button
        type="button"
        className="qb-btn-primary"
        style={{ fontSize: 11, padding: "3px 10px" }}
        onClick={onReport}
      >
        Report a gap
      </button>
    </div>
  </section>
);

const ListTable: FC<{
  items: ToolGapListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}> = ({ items, selectedId, onSelect, loading, error }) => {
  if (error) return <div style={styles.empty}>加载失败：{error}</div>;
  if (loading && items.length === 0) return <div style={styles.empty}>加载中…</div>;
  if (items.length === 0) {
    return (
      <div style={styles.empty}>
        当前条件下没有 gap。
        <br />- 等 ToolGapWatcher 周期跑后会自动落 unknown_tool / repeated_fail / reflective_mention
        三路。
        <br />- agent 可以主动调 builtin <code>tool.report_gap</code> 上报。
      </div>
    );
  }
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={{ ...styles.th, width: 100 }}>kind</th>
            <th style={{ ...styles.th }}>signature</th>
            <th style={{ ...styles.th, width: 60, textAlign: "right" }}>occ</th>
            <th style={{ ...styles.th, width: 90 }}>status</th>
            <th style={{ ...styles.th, width: 140 }}>last seen</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const sel = it.id === selectedId;
            return (
              <tr
                key={it.id}
                style={{ ...styles.tr, ...(sel ? styles.trSelected : {}) }}
                onClick={() => onSelect(it.id)}
              >
                <td style={styles.td}>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: 10,
                      fontWeight: 700,
                      color: kindAccent(it.detectionKind),
                      border: `1px solid ${kindAccent(it.detectionKind)}55`,
                    }}
                  >
                    {it.detectionKind}
                  </span>
                </td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                  {it.gapSignature}
                </td>
                <td
                  style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                >
                  {it.occurrenceCount}
                </td>
                <td style={styles.td}>
                  <span
                    style={{
                      fontSize: 10,
                      padding: "1px 6px",
                      borderRadius: 4,
                      color: statusAccent(it.status),
                      border: `1px solid ${statusAccent(it.status)}55`,
                    }}
                  >
                    {it.status}
                  </span>
                </td>
                <td style={{ ...styles.td, fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" }}>
                  {fmtTs(it.lastSeenAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const DetailPanel: FC<{
  item: ToolGapListItem | null;
  onWontFix: (id: string) => void;
  onReopen: (id: string) => void;
}> = ({ item, onWontFix, onReopen }) => {
  if (!item) {
    return (
      <section style={{ ...styles.empty, padding: 24 }}>← 在左侧列表点击 gap 行查看详情。</section>
    );
  }
  const canWontFix = item.status === "open" || item.status === "proposed";
  const canReopen = item.status === "wont_fix" || item.status === "rejected";
  return (
    <section>
      <h3 style={{ ...styles.subTitle, margin: "0 0 8px" }}>详情</h3>
      <div
        style={{
          background: "var(--qb-main-card-bg, #18181b)",
          border: `1px solid ${kindAccent(item.detectionKind)}55`,
          borderRadius: 10,
          padding: "12px 14px",
          marginBottom: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              padding: "1px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 700,
              color: kindAccent(item.detectionKind),
              border: `1px solid ${kindAccent(item.detectionKind)}`,
            }}
          >
            {item.detectionKind}
          </span>
          <span
            style={{
              padding: "1px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 700,
              color: statusAccent(item.status),
              border: `1px solid ${statusAccent(item.status)}`,
            }}
          >
            {item.status}
          </span>
          <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
            occurrence={item.occurrenceCount}
          </span>
        </div>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--qb-body-fg, #f4f4f5)",
            marginBottom: 6,
            fontFamily: "monospace",
          }}
        >
          {item.gapSignature}
        </div>
        {item.excerpt ? (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--qb-main-input-fg, #d4d4d8)",
              background: "var(--qb-stream-box-bg, #1f1f23)",
              padding: 10,
              borderRadius: 8,
              margin: "8px 0",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {item.excerpt}
          </pre>
        ) : null}
        <Badges item={item} />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          className="qb-btn-secondary"
          style={{ fontSize: 11, padding: "4px 12px", opacity: canWontFix ? 1 : 0.5 }}
          disabled={!canWontFix}
          onClick={() => onWontFix(item.id)}
        >
          Mark won't fix
        </button>
        <button
          type="button"
          className="qb-btn-secondary"
          style={{ fontSize: 11, padding: "4px 12px", opacity: canReopen ? 1 : 0.5 }}
          disabled={!canReopen}
          onClick={() => onReopen(item.id)}
        >
          Reopen
        </button>
      </div>

      {item.statusAt ? (
        <div style={{ fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)", marginBottom: 4 }}>
          流转：{item.statusBy ?? "?"} @ {fmtTs(item.statusAt)}
          {item.statusReason ? ` · "${item.statusReason}"` : ""}
        </div>
      ) : null}
    </section>
  );
};

const Badges: FC<{ item: ToolGapListItem }> = ({ item }) => {
  const bits: Array<{ k: string; v: string }> = [
    { k: "first", v: fmtTs(item.firstSeenAt) },
    { k: "last", v: fmtTs(item.lastSeenAt) },
  ];
  if (item.requestedToolName) bits.push({ k: "tool", v: item.requestedToolName });
  if (item.requestedToolKind) bits.push({ k: "toolKind", v: item.requestedToolKind });
  if (item.definitionId) bits.push({ k: "agent", v: shortId(item.definitionId) });
  if (item.workflowRunId) bits.push({ k: "from wf", v: shortId(item.workflowRunId) });
  if (item.sourceToolCallId) bits.push({ k: "src tool_call", v: shortId(item.sourceToolCallId) });
  if (item.sourceExperienceId) bits.push({ k: "src exp", v: shortId(item.sourceExperienceId) });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11 }}>
      {bits.map((b) => (
        <span
          key={b.k}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: "var(--qb-stream-box-bg, #1f1f23)",
            color: "var(--qb-main-meta, #a1a1aa)",
          }}
        >
          <span style={{ color: "var(--qb-main-meta, #71717a)" }}>{b.k}=</span>
          <span style={{ color: "var(--qb-main-input-fg, #d4d4d8)" }}>{b.v}</span>
        </span>
      ))}
    </div>
  );
};

const ReportDialog: FC<{
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}> = ({ projectId, onClose, onCreated }) => {
  const [toolName, setToolName] = useState("");
  const [serverName, setServerName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!toolName.trim() && !reason.trim()) {
      setErr("toolName 或 reason 至少填一个");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Parameters<typeof reportToolGap>[0] = { projectId };
      if (toolName.trim()) body.toolName = toolName.trim();
      if (serverName.trim()) body.serverName = serverName.trim();
      if (reason.trim()) body.reason = reason.trim();
      await reportToolGap(body);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "var(--qb-main-card-bg, #18181b)",
          padding: 20,
          borderRadius: 10,
          width: 380,
          border: "1px solid var(--qb-main-input-border, #27272a)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h4 style={{ margin: "0 0 12px" }}>Report a tool gap</h4>
        <p style={{ fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)", margin: "0 0 12px" }}>
          人工反馈："想用某工具但没有 / 不可用"。Watcher 会按 signature 去重累计。
        </p>
        <label style={{ display: "block", fontSize: 11, marginBottom: 6 }}>
          Tool name（可选）
          <input
            type="text"
            value={toolName}
            onChange={(e) => setToolName(e.target.value)}
            placeholder="e.g. get_realtime_options_chain"
            style={{ ...styles.input, width: "100%", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", fontSize: 11, marginBottom: 6 }}>
          MCP server（可选；与 toolName 一起生成 mcp: 签名）
          <input
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
            placeholder="e.g. slack"
            style={{ ...styles.input, width: "100%", marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", fontSize: 11, marginBottom: 12 }}>
          Reason（可选；无 toolName 时取关键词作 concept 签名）
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="为什么需要这个工具？"
            style={{ ...styles.input, width: "100%", marginTop: 4, resize: "vertical" }}
          />
        </label>
        {err ? <div style={{ color: "#f87171", fontSize: 11, marginBottom: 8 }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            className="qb-btn-secondary"
            style={{ fontSize: 11, padding: "4px 12px" }}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="qb-btn-primary"
            style={{ fontSize: 11, padding: "4px 12px" }}
            onClick={submit}
            disabled={busy}
          >
            {busy ? "提交中…" : "提交"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────── Self-Evolving Agent P8 — Proposals section ─────────────────────────
// 展示 auto_install_proposal + auto_installer_run。approve/reject 当场 toast 错误并 reload。

const PROPOSAL_STATE_OPTIONS: Array<{ id: ProposalState | "all"; label: string }> = [
  { id: "pending_review", label: "Pending" },
  { id: "no_candidate", label: "No Candidate" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "全部" },
];

function safetyAccent(s: "low" | "medium" | "high"): string {
  if (s === "low") return "#22c55e";
  if (s === "medium") return "#eab308";
  return "#f87171";
}

function proposalStateAccent(s: ProposalState): string {
  switch (s) {
    case "pending_review":
      return "#3b82f6";
    case "approved":
      return "#22c55e";
    case "rejected":
      return "#f87171";
    case "no_candidate":
      return "#a1a1aa";
  }
}

const ProposalsSection: FC<{ projectId: string; autoRefresh: boolean }> = ({
  projectId,
  autoRefresh,
}) => {
  const [state, setState] = useState<ProposalState | "all">("pending_review");
  const [items, setItems] = useState<AutoInstallProposalItem[]>([]);
  const [runs, setRuns] = useState<AutoInstallerRunItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const [list, runList] = await Promise.all([
        listAutoInstallProposals({ projectId, state, limit: 50 }),
        listAutoInstallerRuns({ projectId, limit: 5 }),
      ]);
      setItems(list);
      setRuns(runList);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
      setItems([]);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, state]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!autoRefresh || !projectId) return;
    const t = window.setInterval(() => void reload(), 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, reload]);

  const handleApprove = useCallback(
    async (id: string) => {
      const reason = window.prompt("Approve 备注（可空）：", "") ?? "";
      setActionErr(null);
      try {
        await approveAutoInstallProposal(id, { reason: reason || undefined, actor: "user" });
        await reload();
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      }
    },
    [reload]
  );

  const handleReject = useCallback(
    async (id: string) => {
      const reason = window.prompt("Reject 原因（可空）：", "") ?? "";
      setActionErr(null);
      try {
        await rejectAutoInstallProposal(id, { reason: reason || undefined, actor: "user" });
        await reload();
      } catch (e) {
        setActionErr(e instanceof Error ? e.message : String(e));
      }
    },
    [reload]
  );

  const latestRun = runs[0];
  const cumulative = useMemo(
    () =>
      runs.reduce(
        (acc, r) => ({
          scanned: acc.scanned + r.gapsScanned,
          created: acc.created + r.proposalsCreated,
          skipped: acc.skipped + r.proposalsSkippedExisting,
          noCand: acc.noCand + r.proposalsNoCandidate,
        }),
        { scanned: 0, created: 0, skipped: 0, noCand: 0 }
      ),
    [runs]
  );

  return (
    <section
      style={{
        marginTop: 24,
        paddingTop: 16,
        borderTop: "1px solid var(--qb-main-border, #27272a)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h3 style={{ ...styles.subTitle, margin: 0 }}>AutoInstaller · Proposals</h3>
        <button
          type="button"
          className="qb-btn-secondary"
          style={{ fontSize: 11, padding: "3px 10px" }}
          onClick={() => void reload()}
        >
          刷新
        </button>
      </div>

      {runs.length === 0 ? (
        <div style={styles.empty}>
          暂无 AutoInstaller 跑批记录。运行{" "}
          <code>bun run src/scripts/run-auto-installer.ts --projectId=...</code> 触发。
        </div>
      ) : (
        <div style={styles.kpiRow}>
          {latestRun ? (
            <>
              <Kpi
                label="最近 run · scanned"
                value={String(latestRun.gapsScanned)}
                accent="#3b82f6"
              />
              <Kpi
                label="最近 run · created"
                value={String(latestRun.proposalsCreated)}
                accent="#22c55e"
              />
              <Kpi
                label="最近 run · no_cand"
                value={String(latestRun.proposalsNoCandidate)}
                accent="#a1a1aa"
              />
              <Kpi
                label="最近 run · status"
                value={latestRun.status}
                accent={latestRun.status === "failed" ? "#f87171" : "#22c55e"}
              />
            </>
          ) : null}
          <Kpi
            label={`累计 (${runs.length} run)`}
            value={`${cumulative.scanned}sc / ${cumulative.created}new`}
            accent="#71717a"
          />
        </div>
      )}

      <div style={{ ...styles.form, margin: "12px 0 8px" }}>
        <select
          value={state}
          onChange={(e) => setState(e.target.value as ProposalState | "all")}
          style={styles.select}
        >
          {PROPOSAL_STATE_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {actionErr ? (
        <div style={{ ...styles.empty, color: "#f87171" }}>动作失败：{actionErr}</div>
      ) : null}
      {err ? <div style={{ ...styles.empty, color: "#f87171" }}>加载失败：{err}</div> : null}
      {loading && items.length === 0 ? <div style={styles.empty}>加载中…</div> : null}
      {!loading && items.length === 0 && !err ? (
        <div style={styles.empty}>
          当前 state={state} 没有 proposal。等 AutoInstaller 跑批后会扫{" "}
          <code>tool_gap_log.status=open</code> 生成 proposal。
        </div>
      ) : null}

      {items.length > 0 ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: 90 }}>kind</th>
                <th style={{ ...styles.th }}>target</th>
                <th style={{ ...styles.th, width: 80, textAlign: "right" }}>score</th>
                <th style={{ ...styles.th, width: 70 }}>safety</th>
                <th style={{ ...styles.th, width: 100 }}>state</th>
                <th style={{ ...styles.th, width: 140 }}>created</th>
                <th style={{ ...styles.th, width: 140 }}>actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const canAct = p.state === "pending_review";
                return (
                  <tr key={p.id} style={styles.tr}>
                    <td style={styles.td}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          color: proposalStateAccent(p.state),
                          border: `1px solid ${proposalStateAccent(p.state)}55`,
                        }}
                      >
                        {p.proposalKind.replace("install_", "")}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                      {p.targetSlug ?? <span style={{ color: "#71717a" }}>—</span>}
                      {/* C4 合表后：用 proposalKind 区分 external（之前用 targetKind='mcp_catalog_item'）；
                          老数据 targetKind 仍可能是 'mcp_catalog_item'，两个条件都成立时显示 (ext) */}
                      {p.proposalKind === "install_mcp_external" ||
                      p.targetKind === "mcp_catalog_item" ? (
                        <span style={{ marginLeft: 6, color: "#a1a1aa", fontSize: 10 }}>(ext)</span>
                      ) : null}
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {p.matchScore.toFixed(2)}
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          color: safetyAccent(p.safetyLevel),
                          border: `1px solid ${safetyAccent(p.safetyLevel)}55`,
                        }}
                      >
                        {p.safetyLevel}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          color: proposalStateAccent(p.state),
                          border: `1px solid ${proposalStateAccent(p.state)}55`,
                        }}
                      >
                        {p.state}
                      </span>
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        fontSize: 11,
                        color: "var(--qb-main-meta, #a1a1aa)",
                      }}
                    >
                      {fmtTs(p.createdAt)}
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          className="qb-btn-primary"
                          style={{
                            fontSize: 10,
                            padding: "2px 8px",
                            opacity: canAct ? 1 : 0.4,
                          }}
                          disabled={!canAct}
                          onClick={() => handleApprove(p.id)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="qb-btn-secondary"
                          style={{
                            fontSize: 10,
                            padding: "2px 8px",
                            opacity:
                              p.state === "pending_review" || p.state === "no_candidate" ? 1 : 0.4,
                          }}
                          disabled={p.state !== "pending_review" && p.state !== "no_candidate"}
                          onClick={() => handleReject(p.id)}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
};
