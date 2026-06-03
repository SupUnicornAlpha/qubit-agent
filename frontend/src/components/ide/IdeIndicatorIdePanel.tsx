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
import { TokyoCodeEditor } from "../code/TokyoCodeEditor";
import { qc } from "../../lib/uiClasses";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";

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
  const { t } = useTranslation();

  const defaultName = t("ide.indicatorIde.defaultScriptName");
  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [scriptName, setScriptName] = useState(defaultName);
  const [workflowRunId, setWorkflowRunId] = useState("");
  const [purpose, setPurpose] = useState<"research" | "live_trading" | "both">("both");
  const [workflows, setWorkflows] = useState<WfRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSignal, setShowSignal] = useState(false);

  const sessionTitle = useMemo(() => {
    if (!selectedSessionId) return t("ide.indicatorIde.meta.sessionEmpty");
    const s = chatSessions.find((x) => x.id === selectedSessionId);
    return s?.title ?? selectedSessionId.slice(0, 8);
  }, [chatSessions, selectedSessionId, t]);

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
    setScriptName(defaultName);
    setWorkflowRunId("");
    setError(null);
  };

  const saveNow = async () => {
    if (!selectedSessionId) {
      setError(t("ide.indicatorIde.errors.needSession"));
      return;
    }
    const name = scriptName.trim();
    if (!name) {
      setError(t("ide.indicatorIde.errors.needName"));
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
    if (!window.confirm(t("ide.indicatorIde.errors.confirmDelete"))) return;
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
    const prompt = ideAiPrompt.trim() || t("ide.indicatorIde.ai.promptEmpty");
    const block = t("ide.indicatorIde.ai.chatBlock", {
      prompt,
      code: ideStrategySource,
    });
    setChatDraftPrefill(block);
    setIdeLeftTab("chat");
  };

  const badgeText = ideActiveStrategyScriptId
    ? t("ide.indicatorIde.badge.saved", {
        name: scriptName.trim() || t("ide.indicatorIde.badge.unnamed"),
      })
    : t("ide.indicatorIde.badge.unsaved");

  return (
    <div style={styles.root}>
      <div style={styles.head}>
        <span style={styles.title}>{t("ide.indicatorIde.title")}</span>
        <span style={styles.badge}>{badgeText}</span>
      </div>

      <div style={styles.metaBar}>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>{t("ide.indicatorIde.meta.session")}</span>
          <span style={styles.metaVal}>{sessionTitle}</span>
          {!selectedSessionId ? (
            <span style={styles.warn}>{t("ide.indicatorIde.meta.sessionWarn")}</span>
          ) : null}
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>{t("ide.indicatorIde.meta.run")}</span>
          <select
            style={styles.selectSm}
            value={workflowRunId}
            onChange={(e) => setWorkflowRunId(e.target.value)}
            disabled={!selectedSessionId}
          >
            <option value="">{t("ide.indicatorIde.meta.runEmpty")}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {(w.goal ?? "").slice(0, 36)}
                {w.goal && w.goal.length > 36 ? "…" : ""} · {w.status ?? "?"}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>{t("ide.indicatorIde.meta.purpose")}</span>
          <select
            style={styles.selectSm}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as typeof purpose)}
          >
            <option value="research">{t("ide.indicatorIde.purpose.research")}</option>
            <option value="live_trading">{t("ide.indicatorIde.purpose.live")}</option>
            <option value="both">{t("ide.indicatorIde.purpose.both")}</option>
          </select>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>{t("ide.indicatorIde.meta.name")}</span>
          <input
            style={styles.inpSm}
            value={scriptName}
            onChange={(e) => setScriptName(e.target.value)}
            placeholder={t("ide.indicatorIde.meta.namePlaceholder")}
          />
        </div>
        <div style={styles.btnRow}>
          <button type="button" className="qb-btn-secondary" onClick={() => void refreshScripts()} disabled={!selectedSessionId || loading}>
            {t("ide.indicatorIde.actions.refresh")}
          </button>
          <button type="button" className="qb-btn-secondary" onClick={newDraft}>
            {t("ide.indicatorIde.actions.newDraft")}
          </button>
          <button type="button" className="qb-btn-primary-brand" onClick={() => void saveNow()} disabled={loading}>
            {ideActiveStrategyScriptId
              ? t("ide.indicatorIde.actions.saveUpdate")
              : t("ide.indicatorIde.actions.saveToSession")}
          </button>
          <button type="button" className="qb-btn-secondary" onClick={() => void deleteNow()} disabled={!ideActiveStrategyScriptId || loading}>
            {t("ide.indicatorIde.actions.delete")}
          </button>
        </div>
        <div style={styles.metaRow}>
          <span style={styles.metaLabel}>{t("ide.indicatorIde.meta.saved")}</span>
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
            <option value="">{t("ide.indicatorIde.meta.savedEmpty")}</option>
            {scripts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.purpose}
              </option>
            ))}
          </select>
        </div>
        {error ? <div style={styles.err}>{error}</div> : null}
      </div>

      <TokyoCodeEditor
        flat
        showChrome={false}
        showStatus
        flex={1}
        minHeight={140}
        language="python"
        filename={`${scriptName.trim() || "strategy"}.py`}
        value={ideStrategySource}
        onChange={setIdeStrategySource}
        textareaProps={{ "aria-label": t("ide.indicatorIde.editor.ariaSource") }}
      />

      <details style={styles.details} open={showSignal} onToggle={(e) => setShowSignal((e.target as HTMLDetailsElement).open)}>
        <summary style={styles.sum}>{t("ide.indicatorIde.signal.summary")}</summary>
        <TokyoCodeEditor
          flat
          showChrome={false}
          showStatus={false}
          minHeight={88}
          language="python"
          filename="signal.py"
          value={ideSignalPythonCode}
          onChange={setIdeSignalPythonCode}
          textareaProps={{ "aria-label": t("ide.indicatorIde.editor.ariaSignal") }}
        />
      </details>

      <div style={styles.aiBox}>
        <div style={styles.aiTitle}>{t("ide.indicatorIde.ai.title")}</div>
        <textarea
          className={qc.textarea}
          style={styles.aiIn}
          value={ideAiPrompt}
          onChange={(e) => setIdeAiPrompt(e.target.value)}
          placeholder={t("ide.indicatorIde.ai.placeholder")}
          rows={3}
        />
        <div style={styles.aiActions}>
          <button type="button" className="qb-btn-primary-brand" onClick={sendToChat}>
            {t("ide.indicatorIde.ai.send")}
          </button>
          <span style={styles.hint}>{t("ide.indicatorIde.ai.hint")}</span>
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
    background: "var(--qb-kline-root-bg, #09090b)",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  head: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
  },
  title: { fontSize: 13, fontWeight: 700 },
  badge: { fontSize: 10, color: "var(--qb-main-meta, #71717a)", whiteSpace: "nowrap", maxWidth: "46%", textAlign: "right" },
  metaBar: {
    flexShrink: 0,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-team-stage-bg, #0c0c0e)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    fontSize: 11,
  },
  metaRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
  metaLabel: { color: "var(--qb-main-meta, #71717a)", width: 72, flexShrink: 0 },
  metaVal: { color: "var(--qb-main-meta, #a1a1aa)", flex: 1, minWidth: 0 },
  warn: { color: "#f59e0b", fontSize: 10 },
  selectSm: {
    flex: 1,
    minWidth: 120,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  selectGrow: {
    flex: 1,
    minWidth: 0,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  inpSm: {
    flex: 1,
    minWidth: 100,
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
  },
  btnRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 },
  err: { color: "#fca5a5", fontSize: 11 },
  details: { borderBottom: "1px solid var(--qb-main-input-border, #27272a)", background: "var(--qb-team-stage-bg, #0c0c0e)" },
  sum: { cursor: "pointer", padding: "6px 12px", fontSize: 11, color: "var(--qb-main-meta, #71717a)" },
  aiBox: {
    flexShrink: 0,
    padding: "10px 12px 12px",
    borderTop: "1px solid var(--qb-main-input-border, #27272a)",
    background: "var(--qb-chat-main-bg, #111114)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  aiTitle: { fontSize: 12, fontWeight: 600, color: "var(--qb-main-meta, #a1a1aa)" },
  aiIn: {
    width: "100%",
    resize: "vertical",
    minHeight: 64,
    padding: "8px 10px",
    fontSize: 12,
    fontFamily: "inherit",
  },
  aiActions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 },
  hint: { fontSize: 10, color: "var(--qb-main-meta, #52525b)", flex: 1, minWidth: 140 },
};
