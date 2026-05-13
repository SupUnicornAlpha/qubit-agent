import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createStrategyScript,
  deleteStrategyScript,
  getSessionOverview,
  listStrategyScripts,
  updateStrategyScript,
} from "../../api/backend";
import type { IndicatorStrategyScriptRecord } from "../../api/types";
import { qc } from "../../lib/uiClasses";
import { useAppStore } from "../../store";

type WfRow = { id?: string; goal?: string; status?: string };

export const IdeIndicatorIdePanel: FC = () => {
  const ideStrategySource = useAppStore((s) => s.ideStrategySource);
  const setIdeStrategySource = useAppStore((s) => s.setIdeStrategySource);
  const ideAiPrompt = useAppStore((s) => s.ideAiPrompt);
  const setIdeAiPrompt = useAppStore((s) => s.setIdeAiPrompt);
  const ideSignalPythonCode = useAppStore((s) => s.ideSignalPythonCode);
  const setIdeSignalPythonCode = useAppStore((s) => s.setIdeSignalPythonCode);
  const ideActiveStrategyScriptId = useAppStore((s) => s.ideActiveStrategyScriptId);
  const setIdeActiveStrategyScriptId = useAppStore((s) => s.setIdeActiveStrategyScriptId);
  const setChatDraftPrefill = useAppStore((s) => s.setChatDraftPrefill);
  const setIdeLeftTab = useAppStore((s) => s.setIdeLeftTab);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const chatSessions = useAppStore((s) => s.chatSessions);
  const chartSpec = useAppStore((s) => s.chartSpec);

  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [scriptName, setScriptName] = useState("策略稿");
  const [workflowRunId, setWorkflowRunId] = useState("");
  const [purpose, setPurpose] = useState<"research" | "live_trading" | "both">("both");
  const [workflows, setWorkflows] = useState<WfRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignal, setShowSignal] = useState(false);

  const sessionTitle = useMemo(() => {
    if (!selectedSessionId) return "（未选择会话）";
    const s = chatSessions.find((x) => x.id === selectedSessionId);
    return s?.title ?? selectedSessionId.slice(0, 8);
  }, [chatSessions, selectedSessionId]);

  const refreshScripts = useCallback(async () => {
    if (!selectedSessionId) {
      setScripts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [rows, ov] = await Promise.all([
        listStrategyScripts(selectedSessionId),
        getSessionOverview(selectedSessionId),
      ]);
      setScripts(rows);
      const wf = (ov.workflows ?? []) as WfRow[];
      setWorkflows(wf.filter((w) => typeof w?.id === "string"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    void refreshScripts();
  }, [refreshScripts]);

  const applyScript = (row: IndicatorStrategyScriptRecord) => {
    setIdeActiveStrategyScriptId(row.id);
    setScriptName(row.name);
    setIdeStrategySource(row.ideCode);
    setIdeSignalPythonCode(row.signalCode || "");
    setIdeAiPrompt(row.aiPromptSnapshot ?? "");
    setWorkflowRunId(row.workflowRunId ?? "");
    setPurpose(row.purpose);
  };

  const newDraft = () => {
    setIdeActiveStrategyScriptId(null);
    setScriptName("策略稿");
    setWorkflowRunId("");
    setError(null);
  };

  const saveNow = async () => {
    if (!selectedSessionId) {
      setError("请先在对话工作台选择会话后再保存。");
      return;
    }
    const name = scriptName.trim();
    if (!name) {
      setError("请填写策略名称。");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const chartSnapshotJson = {
        symbol: chartSpec.symbol,
        exchange: chartSpec.exchange,
        timeframe: chartSpec.timeframe,
        limit: chartSpec.limit,
      };
      const wf = workflowRunId.trim() || null;
      if (ideActiveStrategyScriptId) {
        await updateStrategyScript(ideActiveStrategyScriptId, {
          name,
          ideCode: ideStrategySource,
          signalCode: ideSignalPythonCode,
          workflowRunId: wf,
          aiPromptSnapshot: ideAiPrompt.trim() || null,
          chartSnapshotJson,
          purpose,
        });
      } else {
        const created = await createStrategyScript(selectedSessionId, {
          name,
          ideCode: ideStrategySource,
          signalCode: ideSignalPythonCode,
          workflowRunId: wf,
          aiPromptSnapshot: ideAiPrompt.trim() || null,
          chartSnapshotJson,
          purpose,
        });
        setIdeActiveStrategyScriptId(created.id);
      }
      await refreshScripts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const deleteNow = async () => {
    if (!ideActiveStrategyScriptId) return;
    if (!window.confirm("确定删除当前已保存的策略稿？")) return;
    setLoading(true);
    setError(null);
    try {
      await deleteStrategyScript(ideActiveStrategyScriptId);
      newDraft();
      await refreshScripts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const sendToChat = () => {
    const prompt = ideAiPrompt.trim() || "（未填写自然语言描述）";
    const block = `请根据以下「自然语言需求」与「指标/策略草稿」继续完善、检查风险点，并说明需要哪些行情数据或 API：\n\n【需求】\n${prompt}\n\n【当前草稿】\n\`\`\`python\n${ideStrategySource}\n\`\`\``;
    setChatDraftPrefill(block);
    setIdeLeftTab("chat");
  };

  const badgeText = ideActiveStrategyScriptId
    ? `已入库 · ${scriptName.trim() || "未命名"}`
    : "本地草稿 · 未保存";

  return (
    <div style={styles.root}>
      <div style={styles.head}>
        <span style={styles.title}>代码编辑器</span>
        <span style={styles.badge}>{badgeText}</span>
      </div>

      <div style={styles.metaBar}>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>关联会话</span>
          <span style={styles.metaVal}>{sessionTitle}</span>
          {!selectedSessionId ? <span style={styles.warn}>请在「对话工作台」选中会话</span> : null}
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>研究团队 Run</span>
          <select
            style={styles.selectSm}
            value={workflowRunId}
            onChange={(e) => setWorkflowRunId(e.target.value)}
            disabled={!selectedSessionId}
          >
            <option value="">（不关联具体 Run）</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {(w.goal ?? "").slice(0, 36)}
                {w.goal && w.goal.length > 36 ? "…" : ""} · {w.status ?? "?"}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>用途</span>
          <select
            style={styles.selectSm}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as typeof purpose)}
          >
            <option value="research">研究 / 对话产出</option>
            <option value="live_trading">量化交易执行</option>
            <option value="both">研究 + 交易</option>
          </select>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>策略名</span>
          <input
            style={styles.inpSm}
            value={scriptName}
            onChange={(e) => setScriptName(e.target.value)}
            placeholder="保存时使用的名称"
          />
        </div>
        <div style={styles.btnRow}>
          <button type="button" className={`qa-btn ${qc.btnGhost}`} onClick={() => void refreshScripts()} disabled={!selectedSessionId || loading}>
            刷新列表
          </button>
          <button type="button" className={`qa-btn ${qc.btnGhost}`} onClick={newDraft}>
            新建草稿
          </button>
          <button type="button" className={`qa-btn ${qc.btnAccent}`} onClick={() => void saveNow()} disabled={loading}>
            {ideActiveStrategyScriptId ? "保存更新" : "保存到会话"}
          </button>
          <button type="button" className={`qa-btn ${qc.btnGhost}`} onClick={() => void deleteNow()} disabled={!ideActiveStrategyScriptId || loading}>
            删除
          </button>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>已保存</span>
          <select
            style={styles.selectGrow}
            value={ideActiveStrategyScriptId ?? ""}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                newDraft();
                return;
              }
              const row = scripts.find((s) => s.id === id);
              if (row) applyScript(row);
            }}
            disabled={!selectedSessionId || scripts.length === 0}
          >
            <option value="">（选择已保存策略…）</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.purpose}
              </option>
            ))}
          </select>
        </div>
        {error ? <div style={styles.err}>{error}</div> : null}
      </div>

      <textarea
        className="qa-code"
        style={styles.code}
        value={ideStrategySource}
        onChange={(e) => setIdeStrategySource(e.target.value)}
        spellCheck={false}
        aria-label="策略与指标源码"
      />

      <details style={styles.details} open={showSignal} onToggle={(e) => setShowSignal((e.target as HTMLDetailsElement).open)}>
        <summary style={styles.sum}>Python 信号脚本（底部「代码策略」回测共用）</summary>
        <textarea
          className="qa-code"
          style={styles.signalCode}
          value={ideSignalPythonCode}
          onChange={(e) => setIdeSignalPythonCode(e.target.value)}
          spellCheck={false}
          aria-label="Python 信号 buy sell"
        />
      </details>

      <div style={styles.aiBox}>
        <div style={styles.aiTitle}>AI 生成（QuantDinger 式）</div>
        <textarea
          className={qc.textarea}
          style={styles.aiIn}
          value={ideAiPrompt}
          onChange={(e) => setIdeAiPrompt(e.target.value)}
          placeholder="用自然语言描述你想实现的指标或买卖逻辑…"
          rows={3}
        />
        <div style={styles.aiActions}>
          <button type="button" className={`qa-btn ${qc.btnAccent}`} onClick={sendToChat}>
            生成并带入对话
          </button>
          <span style={styles.hint}>保存时会一并记录此描述与当前图表标的，便于研究与交易模块复用。</span>
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "#09090b",
    color: "#e4e4e7",
  },
  head: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid #27272a",
  },
  title: { fontSize: 13, fontWeight: 700 },
  badge: { fontSize: 10, color: "#71717a", whiteSpace: "nowrap", maxWidth: "46%", textAlign: "right" },
  metaBar: {
    flexShrink: 0,
    padding: "8px 12px",
    borderBottom: "1px solid #27272a",
    background: "#0c0c0e",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 11,
  },
  metaRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
  metaLabel: { color: "#71717a", width: 72, flexShrink: 0 },
  metaVal: { color: "#a1a1aa", flex: 1, minWidth: 0 },
  warn: { color: "#f59e0b", fontSize: 10 },
  selectSm: {
    flex: 1,
    minWidth: 120,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  selectGrow: {
    flex: 1,
    minWidth: 0,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  inpSm: {
    flex: 1,
    minWidth: 100,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  btnRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 },
  err: { color: "#fca5a5", fontSize: 11 },
  code: {
    flex: 1,
    minHeight: 100,
    resize: "none",
    margin: 0,
    padding: "10px 12px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.45,
    border: "none",
    borderBottom: "1px solid #27272a",
    background: "#0c0c0e",
    color: "#d4d4d8",
    outline: "none",
  },
  details: { borderBottom: "1px solid #27272a", background: "#0c0c0e" },
  sum: { cursor: "pointer", padding: "6px 12px", fontSize: 11, color: "#71717a" },
  signalCode: {
    width: "100%",
    minHeight: 88,
    resize: "vertical",
    margin: 0,
    padding: "8px 12px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 11,
    lineHeight: 1.4,
    border: "none",
    borderTop: "1px solid #27272a",
    background: "#09090b",
    color: "#d4d4d8",
    outline: "none",
    boxSizing: "border-box",
  },
  aiBox: {
    flexShrink: 0,
    padding: "10px 12px 12px",
    borderTop: "1px solid #27272a",
    background: "#111114",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  aiTitle: { fontSize: 12, fontWeight: 600, color: "#a1a1aa" },
  aiIn: {
    width: "100%",
    resize: "vertical",
    minHeight: 64,
    padding: "8px 10px",
    fontSize: 12,
    fontFamily: "inherit",
  },
  aiActions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 },
  hint: { fontSize: 10, color: "#52525b", flex: 1, minWidth: 140 },
};
