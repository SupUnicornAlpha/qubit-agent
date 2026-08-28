import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  flattenMonitorWorkflowRows,
  listChatSessions,
  listMonitorWorkflows,
} from "../../api/backend";
import { quantLineageFilterActive } from "../../lib/quantListScope";
import { EMPTY_QUANT_LINEAGE_FILTER, type QuantLineageFilterMode } from "../../store";
import { useDefaultProject } from "./useDefaultProject";

type WorkflowOption = { id: string; label: string; sessionId?: string | null };
type SessionOption = { id: string; label: string };

export const QuantLineageFilterBar: FC = () => {
  const {
    workspaceId,
    scopeProjectId,
    defaultProjectId,
    lineageFilter,
    setLineageFilter,
    loading: projectMetaLoading,
  } = useDefaultProject();

  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>([]);
  const [sessionOptions, setSessionOptions] = useState<SessionOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  useEffect(() => {
    if (!workspaceId || projectMetaLoading) return;
    let cancelled = false;
    setOptionsLoading(true);
    void (async () => {
      try {
        const projectId = scopeProjectId ?? defaultProjectId ?? undefined;
        const [wfData, sessions] = await Promise.all([
          listMonitorWorkflows({ projectId, sessionId: undefined }).catch(() => []),
          listChatSessions({ workspaceId, projectId }).catch(() => []),
        ]);
        if (cancelled) return;
        const wfRows = flattenMonitorWorkflowRows(wfData) as Array<{
          id?: unknown;
          goal?: unknown;
          sessionId?: unknown;
          status?: unknown;
        }>;
        setWorkflowOptions(
          wfRows.slice(0, 60).map((row) => {
            const id = String(row.id ?? "").trim();
            const goal = typeof row.goal === "string" ? row.goal.trim() : "";
            const status = typeof row.status === "string" ? row.status : "";
            const label = goal
              ? `${goal.slice(0, 48)}${goal.length > 48 ? "…" : ""}`
              : id.slice(0, 12);
            return {
              id,
              label: status ? `${label} · ${status}` : label,
              sessionId: row.sessionId ? String(row.sessionId) : null,
            };
          }).filter((row) => row.id)
        );
        setSessionOptions(
          sessions.slice(0, 40).map((s) => ({
            id: s.id,
            label: s.title?.trim() || s.id.slice(0, 12),
          }))
        );
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, scopeProjectId, defaultProjectId, projectMetaLoading]);

  const mode = lineageFilter.mode;
  const hint = useMemo(() => {
    if (!quantLineageFilterActive(lineageFilter)) {
      return "不限 workflow / session，按上方 project 范围展示";
    }
    if (lineageFilter.mode === "workflow") {
      return "仅展示该 workflow_run 期间 Agent / 工具链写入的产出";
    }
    return "展示该会话下全部 workflow 的产出（session → 多个 workflow 时自动合并）";
  }, [lineageFilter]);

  const onModeChange = (next: QuantLineageFilterMode) => {
    if (next === "none") {
      setLineageFilter({ ...EMPTY_QUANT_LINEAGE_FILTER });
      return;
    }
    setLineageFilter({ mode: next, id: lineageFilter.mode === next ? lineageFilter.id : "" });
  };

  return (
    <div className="qb-quant-scope-row" style={styles.row} aria-label="产出 lineage 筛选">
      <label style={styles.label}>
        产出筛选
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as QuantLineageFilterMode)}
          style={styles.select}
          disabled={projectMetaLoading}
        >
          <option value="none">不限 workflow / session</option>
          <option value="workflow">按工作流 ID</option>
          <option value="session">按会话 ID</option>
        </select>
      </label>

      {mode === "workflow" ? (
        <label style={styles.label}>
          Workflow
          <input
            list="qb-quant-workflow-options"
            value={lineageFilter.id}
            onChange={(e) => setLineageFilter({ mode: "workflow", id: e.target.value })}
            placeholder="workflow_run_id（可粘贴或从列表选）"
            style={styles.input}
            spellCheck={false}
          />
          <datalist id="qb-quant-workflow-options">
            {workflowOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </datalist>
        </label>
      ) : null}

      {mode === "session" ? (
        <label style={styles.label}>
          Session
          <input
            list="qb-quant-session-options"
            value={lineageFilter.id}
            onChange={(e) => setLineageFilter({ mode: "session", id: e.target.value })}
            placeholder="chat session_id（可粘贴或从列表选）"
            style={styles.input}
            spellCheck={false}
          />
          <datalist id="qb-quant-session-options">
            {sessionOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </datalist>
        </label>
      ) : null}

      {quantLineageFilterActive(lineageFilter) ? (
        <button
          type="button"
          className="qb-quant-btn qb-quant-btn--ghost"
          style={styles.clearBtn}
          onClick={() => setLineageFilter({ ...EMPTY_QUANT_LINEAGE_FILTER })}
        >
          清除筛选
        </button>
      ) : null}

      <span style={styles.hint}>
        {optionsLoading ? "加载 workflow / session 列表…" : hint}
      </span>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 11,
    color: "var(--qb-text-muted)",
  },
  select: {
    minWidth: 180,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
    color: "inherit",
  },
  input: {
    minWidth: 280,
    fontSize: 12,
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
    color: "inherit",
  },
  clearBtn: {
    minHeight: 28,
    padding: "2px 8px",
    fontSize: 11,
    alignSelf: "flex-end",
  },
  hint: {
    fontSize: 11,
    color: "var(--qb-text-muted)",
    maxWidth: 420,
    lineHeight: 1.4,
    alignSelf: "flex-end",
    paddingBottom: 2,
  },
};
