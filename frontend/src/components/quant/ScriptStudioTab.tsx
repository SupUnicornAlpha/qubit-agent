/**
 * ScriptStudioTab — 量化工作台「脚本工坊」
 *
 * 用途：让 indicator_strategy_script（Python on_bar / signalCode）成为量化工作台
 * 的一等公民，统一在量化工作台里观察、检视、跳转编辑。与 Composer 路径（因子配方）
 * 平级。
 *
 * 三栏：
 *   左：脚本列表（按 project 跨 session 拉；过滤 purpose / sessionId / workflowRunId）
 *   中：脚本详情 hero card（元数据 + on_bar 代码只读 + signal 代码只读 + AI prompt 快照）
 *   右：动作面板（跳到 Strategy IDE 编辑 / 复制代码 / 显示与本脚本绑定的 strategy_runtime）
 *
 * 说明：这里不是脚本编辑器（编辑请走研究工作台 → 左栏 Indicator tab）。
 * 这里是「项目维度只读检视 + 路由」。Composer 路径的 `kind="script"` 引用、
 * Backtest 的 scriptId 直连、Lineage 字段补齐 都列在 docs/FACTOR_RULE_STRATEGY_DESIGN.md
 * 的 backlog 里；本 tab 先做 MVP 让用户终于能在量化工作台「看到 Python 在哪」。
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  backtestStrategyContractApi,
  compileStrategyContract,
  createStrategyRuntime,
  getProjectStrategyScript,
  listProjectStrategyScripts,
  listStrategyRuntimes,
  paperDeployStrategyContract,
  paperRunStrategyContract,
  putFsWorkspaceFile,
  stopStrategyRuntime,
  updateStrategyScript,
  type QuantStrategyScriptDetail,
  type QuantStrategyScriptSummary,
  type StrategyManifestV2,
  type StrategyRuntimeRecord,
} from "../../api/backend";
import { preferStrategyApiCode } from "../../lib/strategyApiCode";
import { useAppStore } from "../../store";
import { useDefaultProject } from "./useDefaultProject";

function chartExchangeToMarket(exchange: string): string {
  const u = exchange.trim().toUpperCase();
  if (u === "HK") return "HK";
  if (u === "US") return "US";
  if (u === "CRYPTO") return "CRYPTO";
  return "CN";
}

type PurposeFilter = "all" | "research" | "live_trading" | "both";

/** purpose → 颜色 token 映射；与 LineageBadge 风格保持一致 */
const PURPOSE_TONE: Record<
  "research" | "live_trading" | "both",
  { label: string; dot: string; text: string; border: string; bg: string }
> = {
  research: {
    label: "Research",
    dot: "var(--qb-quant-accent-2)",
    text: "var(--qb-quant-accent-2)",
    border: "color-mix(in srgb, var(--qb-quant-accent-2) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-2) 10%, var(--qb-bg-elevated))",
  },
  live_trading: {
    label: "Live",
    dot: "var(--qb-quant-accent-5)",
    text: "var(--qb-quant-accent-5)",
    border: "color-mix(in srgb, var(--qb-quant-accent-5) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-5) 10%, var(--qb-bg-elevated))",
  },
  both: {
    label: "Both",
    dot: "var(--qb-quant-accent-3)",
    text: "var(--qb-quant-accent-3)",
    border: "color-mix(in srgb, var(--qb-quant-accent-3) 55%, transparent)",
    bg: "color-mix(in srgb, var(--qb-quant-accent-3) 10%, var(--qb-bg-elevated))",
  },
};

export const ScriptStudioTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setActiveStrategyScriptId = useAppStore((s) => s.setIdeActiveStrategyScriptId);
  const handoff = useAppStore((s) => s.quantHandoff);
  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);

  const [scripts, setScripts] = useState<QuantStrategyScriptSummary[]>([]);
  const [purposeFilter, setPurposeFilter] = useState<PurposeFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requestedScriptId, setRequestedScriptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<QuantStrategyScriptDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [manifest, setManifest] = useState<StrategyManifestV2 | null>(null);
  const [backtestSummary, setBacktestSummary] = useState<string | null>(null);
  const [paperSessionId, setPaperSessionId] = useState<string | null>(null);
  const [paperSummary, setPaperSummary] = useState<string | null>(null);
  const [scriptRuntimes, setScriptRuntimes] = useState<StrategyRuntimeRecord[]>([]);
  const [engineBusy, setEngineBusy] = useState(false);

  /** 研究产物→脚本工坊：精确选中被点击的脚本。 */
  useEffect(() => {
    if (!handoff || handoff.kind !== "script-to-workbench") return;
    setPurposeFilter("all");
    setDetail(null);
    setRequestedScriptId(handoff.scriptId);
    setSelectedId(handoff.scriptId);
    setInfo(handoff.note ?? `已打开脚本 ${handoff.scriptId.slice(0, 8)}…`);
    setError(null);
    setQuantHandoff(null);
  }, [handoff, setQuantHandoff]);

  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const list = await listProjectStrategyScripts({
        projectId,
        ...(purposeFilter !== "all" ? { purpose: purposeFilter } : {}),
      });
      setScripts(list);
      // 自动选中第一条；保留已选中且仍在列表中的
      setSelectedId((current) => {
        if (requestedScriptId && current === requestedScriptId) return current;
        if (current && list.some((s) => s.id === current)) return current;
        return list[0]?.id ?? current;
      });
      if (list.length === 0 && !requestedScriptId) setDetail(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, purposeFilter, requestedScriptId]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  // 单条详情按 id 拉取（含 ideCode/signalCode 全文）
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setManifest(null);
    setBacktestSummary(null);
    setPaperSessionId(null);
    setPaperSummary(null);
    setPaperSessionId(null);
    setPaperSummary(null);
    (async () => {
      try {
        const d = await getProjectStrategyScript(selectedId);
        if (!cancelled) {
          setDetail(d);
          setRequestedScriptId(null);
        }
      } catch (e) {
        if (!cancelled) {
          setDetail(null);
          setError(
            `无法打开脚本 ${selectedId.slice(0, 8)}…：${(e as Error).message}。` +
              "该产物可能已删除，或不属于当前研究项目。"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filteredScripts = scripts;
  const selected = useMemo(
    () => filteredScripts.find((s) => s.id === selectedId) ?? null,
    [filteredScripts, selectedId]
  );

  /**
   * 跳到研究工作台 Monaco：脚本仍以工坊/DB 为准；
   * 若已同步到 Workspace FS，可在 Explorer 打开对应 .py。
   */
  const onOpenInIde = useCallback(() => {
    if (!detail) return;
    setActiveStrategyScriptId(detail.id);
    setActiveView("ide");
    setInfo("已打开研究工作台代码编辑。请从 Explorer 打开 Workspace 中的脚本文件；本工坊可继续只读检视。");
  }, [detail, setActiveStrategyScriptId, setActiveView]);

  const contractCode = useMemo(
    () =>
      preferStrategyApiCode({
        ideCode: detail?.ideCode,
        signalCode: detail?.signalCode,
      }),
    [detail]
  );

  const reloadRuntimes = useCallback(async () => {
    if (!detail?.id) {
      setScriptRuntimes([]);
      return;
    }
    try {
      const rows = await listStrategyRuntimes({
        ...(detail.workflowRunId ? { workflowRunId: detail.workflowRunId } : {}),
        ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
      });
      setScriptRuntimes(rows.filter((r) => r.strategyScriptId === detail.id).slice(0, 8));
    } catch {
      setScriptRuntimes([]);
    }
  }, [detail]);

  useEffect(() => {
    void reloadRuntimes();
  }, [reloadRuntimes]);

  const onVerifyContract = useCallback(async () => {
    if (!contractCode) {
      setError("当前脚本没有可验证的代码（需要 Strategy API：initialize + handle_data）");
      return;
    }
    setVerifyBusy(true);
    setError(null);
    setBacktestSummary(null);
    try {
      const compiled = await compileStrategyContract(contractCode);
      if (!compiled.ok) {
        setManifest(null);
        setError(`契约验证失败：${compiled.error}`);
        return;
      }
      setManifest(compiled.manifest);
      setInfo(
        `Manifest OK · codeHash=${compiled.manifest.codeHash.slice(0, 12)}… · type=${compiled.manifest.strategyType}`
      );
    } finally {
      setVerifyBusy(false);
    }
  }, [contractCode]);

  const onContractBacktest = useCallback(async () => {
    if (!contractCode) {
      setError("当前脚本没有可回测的 Strategy API 源码");
      return;
    }
    setVerifyBusy(true);
    setError(null);
    try {
      const r = await backtestStrategyContractApi({ code: contractCode, limit: 180 });
      if (!r.ok || !r.data) {
        setError(`契约回测失败：${r.error ?? "unknown"}`);
        return;
      }
      setManifest(r.data.manifest);
      const m = r.data.metrics;
      setBacktestSummary(
        `${r.data.primarySymbol} · ret ${m.totalReturnPct.toFixed(2)}% · MDD ${m.maxDrawdownPct.toFixed(2)}% · Sharpe~ ${m.sharpeApprox.toFixed(2)} · trades ${m.tradeCount}`
      );
      setInfo("契约回测完成（SimBroker · next-open）");
    } finally {
      setVerifyBusy(false);
    }
  }, [contractCode]);

  const onPaperDeploy = useCallback(async () => {
    if (!contractCode) {
      setError("需要 Strategy API 源码才能纸交易部署");
      return;
    }
    setVerifyBusy(true);
    setError(null);
    try {
      const r = await paperDeployStrategyContract({
        code: contractCode,
        paperCapital: 100_000,
        ...(projectId ? { projectId } : {}),
      });
      if (!r.ok || !r.data) {
        setError(`纸交易部署失败：${r.error ?? "unknown"}`);
        return;
      }
      setManifest(r.data.manifest);
      setPaperSessionId(r.data.sessionId);
      setPaperSummary(
        `session ${r.data.sessionId.slice(0, 8)}… · ${r.data.primarySymbol} · 纸本金 ${r.data.paperCapital}`
      );
      setInfo("PaperSession 已注册（固定纸本金）。可「纸交易回放」预览 intents。");
    } finally {
      setVerifyBusy(false);
    }
  }, [contractCode, projectId]);

  const onPaperRun = useCallback(async () => {
    if (!paperSessionId && !contractCode) {
      setError("请先「纸交易部署」或提供 Strategy API 源码");
      return;
    }
    setVerifyBusy(true);
    setError(null);
    try {
      const r = await paperRunStrategyContract({
        ...(paperSessionId ? { sessionId: paperSessionId } : { code: contractCode }),
        dryRun: true,
        limit: 180,
      });
      if (!r.ok || !r.data) {
        setError(`纸交易回放失败：${r.error ?? "unknown"}`);
        return;
      }
      setPaperSessionId(r.data.sessionId);
      const m = r.data.metrics;
      setPaperSummary(
        `dry_run · drafts ${r.data.orderDrafts.length} · ret ${m.totalReturnPct.toFixed(2)}% · trades ${m.tradeCount}`
      );
      setInfo(r.data.note ?? "纸交易回放完成（dry_run）");
    } finally {
      setVerifyBusy(false);
    }
  }, [paperSessionId, contractCode]);

  const onPaperRunWrite = useCallback(async () => {
    if (!paperSessionId && !contractCode) {
      setError("请先「纸交易部署」");
      return;
    }
    if (!detail?.workflowRunId) {
      setError("当前脚本没有绑定 workflow_run，无法写 order_intent。请从 Team 研究工作流打开的脚本操作，或仅用 dry_run / 启动引擎。");
      return;
    }
    setVerifyBusy(true);
    setError(null);
    try {
      const r = await paperRunStrategyContract({
        ...(paperSessionId ? { sessionId: paperSessionId } : { code: contractCode }),
        dryRun: false,
        limit: 180,
        workflowRunId: detail.workflowRunId,
        ...(projectId ? { projectId } : {}),
        name: detail.name,
      });
      if (!r.ok || !r.data) {
        setError(`写库回放失败：${r.error ?? "unknown"}`);
        return;
      }
      setPaperSessionId(r.data.sessionId);
      setPaperSummary(
        `已写库 · submitted ${r.data.submittedCount ?? 0} · drafts ${r.data.orderDrafts.length}`
      );
      setInfo(r.data.note ?? "已写入 paper order_intent");
    } finally {
      setVerifyBusy(false);
    }
  }, [paperSessionId, contractCode, detail, projectId]);

  const onWriteWorkspace = useCallback(async () => {
    if (!contractCode || !detail) {
      setError("没有可写入的 Strategy API 源码");
      return;
    }
    const workspaceId = useAppStore.getState().activeFsWorkspaceId;
    if (!workspaceId) {
      setError("未选择 FS Workspace。请先在 Explorer 打开课题 Workspace。");
      return;
    }
    const slug = detail.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    const path = `decision/strategies/${slug || "strategy"}-${detail.id.slice(0, 8)}.py`;
    try {
      await putFsWorkspaceFile(workspaceId, path, contractCode);
      useAppStore.getState().setPendingWorkspaceFile({ workspaceId, path });
      setActiveView("ide");
      setInfo(`已写入 Workspace ${path} 并打开编辑器`);
    } catch (e) {
      setError(`写入 Workspace 失败：${(e as Error).message}`);
    }
  }, [contractCode, detail, setActiveView]);

  const onStartPaperEngine = useCallback(async () => {
    if (!detail) return;
    setEngineBusy(true);
    setError(null);
    try {
      if (detail.purpose === "research") {
        // paper 引擎现已允许 research；同时升档 both 便于后续 sim
        await updateStrategyScript(detail.id, { purpose: "both" });
        setDetail({ ...detail, purpose: "both" });
        setInfo("已将 purpose research → both（paper 引擎可用）");
      }
      const spec = useAppStore.getState().chartSpec;
      let market = chartExchangeToMarket(spec.exchange);
      let symbol = spec.symbol.trim();
      if (manifest?.universe.instruments[0]) {
        const id = manifest.universe.instruments[0].instrumentId;
        if (id.includes(":")) {
          market = id.split(":")[0] || market;
          symbol = id.slice(id.indexOf(":") + 1) || symbol;
        } else {
          symbol = id || symbol;
        }
      }
      const row = await createStrategyRuntime({
        strategyScriptId: detail.id,
        market,
        symbol,
        timeframe: manifest?.primaryFrequency ?? spec.timeframe,
        executionMode: "paper",
        autoStart: true,
        params: {
          orderQty: 100,
          barLimit: 120,
          strategyMode: "script",
          ...(paperSessionId ? { paperSessionId } : {}),
          ...(manifest?.codeHash ? { codeHash: manifest.codeHash } : {}),
        },
      });
      setInfo(
        `已启动纸交易引擎 runtime ${row.id.slice(0, 8)}…（mode=paper · ${row.symbol}）`
      );
      await reloadRuntimes();
    } catch (e) {
      setError(`启动引擎失败：${(e as Error).message}`);
    } finally {
      setEngineBusy(false);
    }
  }, [detail, manifest, paperSessionId, reloadRuntimes]);

  const onStopRuntime = useCallback(
    async (id: string) => {
      setEngineBusy(true);
      try {
        await stopStrategyRuntime(id);
        setInfo(`已停止 runtime ${id.slice(0, 8)}…`);
        await reloadRuntimes();
      } catch (e) {
        setError(`停止失败：${(e as Error).message}`);
      } finally {
        setEngineBusy(false);
      }
    },
    [reloadRuntimes]
  );

  const onCopyCode = useCallback(async (code: string, label: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setInfo(`已复制 ${label}（${code.length} 字符）到剪贴板`);
    } catch (e) {
      setError(`复制失败：${(e as Error).message}`);
    }
  }, []);

  if (projectLoading) return <div style={styles.empty}>加载默认 project…</div>;
  if (projectError) return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  if (!projectId) return <div style={styles.empty}>未找到默认 project，请先在「研究工作台」初始化。</div>;

  return (
    <div className="qb-quant-tab-root qb-quant-tab-root--script" data-qb-quant-tab="script" style={styles.root}>
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>Python 脚本</strong>
          <span style={styles.muted}>{filteredScripts.length}</span>
        </div>
        <div className="qb-quant-filter-row" style={styles.filterRow}>
          <select
            value={purposeFilter}
            onChange={(e) => setPurposeFilter(e.target.value as PurposeFilter)}
            style={styles.select}
            title="按脚本用途筛选"
          >
            <option value="all">用途: 全部</option>
            <option value="research">Research</option>
            <option value="live_trading">Live</option>
            <option value="both">Both</option>
          </select>
          <button
            type="button"
            onClick={reloadList}
            disabled={busy}
            className="qb-quant-btn qb-quant-btn--ghost"
            style={styles.btnGhost}
            title="刷新列表"
          >
            ↻
          </button>
        </div>
        <div className="qb-quant-list" style={styles.list}>
          {filteredScripts.length === 0 ? (
            <div style={styles.empty}>
              {busy ? "加载中…" : "本 project 下暂无 Python 脚本"}
              {!busy ? (
                <div style={{ marginTop: 6, color: "var(--qb-text-muted)", fontSize: 11 }}>
                  在「研究工作台」左栏 Indicator tab 编辑 on_bar 即可新建。
                </div>
              ) : null}
            </div>
          ) : null}
          {filteredScripts.map((s) => {
            const tone = PURPOSE_TONE[s.purpose];
            const isActive = s.id === selectedId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedId(s.id)}
                className={`qb-quant-script-row${isActive ? " qb-quant-script-row--active" : ""}`}
                style={{
                  ...styles.listItem,
                  ...(isActive ? styles.listItemActive : {}),
                }}
              >
                <div style={styles.listItemTop}>
                  <span
                    className="qb-quant-status-dot"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: tone.dot,
                      flexShrink: 0,
                      boxShadow: `0 0 0 2px color-mix(in srgb, ${tone.dot} 35%, transparent)`,
                    }}
                  />
                  <span style={{ fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.name}
                  </span>
                  <span
                    style={{
                      ...styles.purposeChip,
                      color: tone.text,
                      borderColor: tone.border,
                      background: tone.bg,
                    }}
                  >
                    {tone.label}
                  </span>
                </div>
                <div style={styles.listItemMeta}>
                  {s.signalCodeLength > 0 ? `signal ${s.signalCodeLength}c` : null}
                  {s.signalCodeLength > 0 && s.ideCodeLength > 0 ? " · " : null}
                  {s.ideCodeLength > 0 ? `ide ${s.ideCodeLength}c` : null}
                  {s.signalCodeLength === 0 && s.ideCodeLength === 0 ? "（空）" : null}
                </div>
                <div style={styles.listItemMeta}>
                  {s.sessionTitle ? `📜 ${s.sessionTitle}` : null}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {selected && detail ? (
          <div className="qb-quant-script-detail qb-quant-hero-card" style={styles.heroCard}>
            <div style={styles.detailHeader}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={styles.detailTitle}>{detail.name}</strong>
                  <span
                    style={{
                      ...styles.purposeChip,
                      color: PURPOSE_TONE[detail.purpose].text,
                      borderColor: PURPOSE_TONE[detail.purpose].border,
                      background: PURPOSE_TONE[detail.purpose].bg,
                    }}
                  >
                    {PURPOSE_TONE[detail.purpose].label}
                  </span>
                </div>
                <span style={styles.muted}>
                  session: {detail.sessionTitle ?? detail.sessionId.slice(0, 8)}
                  {" · "}
                  {detail.workflowRunId
                    ? `workflow ${detail.workflowRunId.slice(0, 8)}`
                    : "无 workflow 关联"}
                  {" · "}
                  更新于 {new Date(detail.updatedAt).toLocaleString()}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => void onVerifyContract()}
                  disabled={verifyBusy || !contractCode}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="Strategy API V2：compile → Manifest"
                >
                  {verifyBusy ? "验证中…" : "验证契约"}
                </button>
                <button
                  type="button"
                  onClick={() => void onContractBacktest()}
                  disabled={verifyBusy || !contractCode}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="同码 SimBroker 回测"
                >
                  契约回测
                </button>
                <button
                  type="button"
                  onClick={() => void onPaperDeploy()}
                  disabled={verifyBusy || !contractCode}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="注册固定纸本金 PaperSession"
                >
                  纸交易部署
                </button>
                <button
                  type="button"
                  onClick={() => void onPaperRun()}
                  disabled={verifyBusy || (!paperSessionId && !contractCode)}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="dry_run 预览 intents（不写库）"
                >
                  纸交易回放
                </button>
                <button
                  type="button"
                  onClick={() => void onPaperRunWrite()}
                  disabled={verifyBusy || (!paperSessionId && !contractCode) || !detail?.workflowRunId}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="dryRun=false：写 paper order_intent（需绑定 workflow）"
                >
                  写库回放
                </button>
                <button
                  type="button"
                  onClick={() => void onWriteWorkspace()}
                  disabled={!contractCode || !detail}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="写入 decision/strategies/*.py 并打开 IDE"
                >
                  写入 Workspace
                </button>
                <button
                  type="button"
                  onClick={() => void onStartPaperEngine()}
                  disabled={engineBusy || !detail}
                  className="qb-quant-btn qb-quant-btn--primary"
                  style={styles.btnPrimary}
                  title="创建 strategy_runtime（executionMode=paper）并由引擎推进"
                >
                  {engineBusy ? "启动中…" : "启动纸交易引擎"}
                </button>
                <button
                  type="button"
                  onClick={onOpenInIde}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="打开研究工作台编辑"
                >
                  在 IDE 编辑
                </button>
              </div>
            </div>

            {manifest ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--qb-border-subtle)",
                  background: "color-mix(in srgb, var(--qb-quant-accent-3) 8%, var(--qb-bg-elevated))",
                  fontSize: 11,
                  lineHeight: 1.6,
                }}
              >
                <div style={{ fontWeight: 650, marginBottom: 4 }}>StrategyManifest</div>
                <div style={styles.muted}>
                  codeHash {manifest.codeHash.slice(0, 16)}… · {manifest.strategyType} · warmup{" "}
                  {manifest.warmupBars} · freq {manifest.primaryFrequency}
                </div>
                <div style={styles.muted}>
                  universe{" "}
                  {manifest.universe.instruments.map((i) => i.instrumentId).join(", ") || "—"}
                  {" · handlers "}
                  {manifest.handlers.join(", ")}
                </div>
                {manifest.paramsSchema.length > 0 ? (
                  <div style={styles.muted}>
                    params{" "}
                    {manifest.paramsSchema
                      .map((p) => `${p.name}=${String(p.default)}`)
                      .join(", ")}
                  </div>
                ) : null}
                {backtestSummary ? (
                  <div style={{ marginTop: 4, color: "var(--qb-text-strong)" }}>
                    回测 {backtestSummary}
                  </div>
                ) : null}
                {paperSummary ? (
                  <div style={{ marginTop: 4, color: "var(--qb-text-strong)" }}>
                    纸交易 {paperSummary}
                  </div>
                ) : null}
              </div>
            ) : null}

            {scriptRuntimes.length > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 8,
                  border: "1px solid var(--qb-border-subtle)",
                  fontSize: 11,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ fontWeight: 650, marginBottom: 6 }}>绑定运行时</div>
                {scriptRuntimes.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <span style={styles.muted}>
                      {r.id.slice(0, 8)}… · {r.executionMode} · {r.status} · {r.symbol}
                    </span>
                    {r.status === "running" || r.status === "starting" ? (
                      <button
                        type="button"
                        className="qb-quant-btn qb-quant-btn--ghost"
                        style={styles.btnGhost}
                        disabled={engineBusy}
                        onClick={() => void onStopRuntime(r.id)}
                      >
                        停止
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            <div style={styles.codeSectionsWrap}>
              {detail.signalCode && detail.signalCode.trim().length > 0 ? (
                <CodeBlock
                  title="signal_code · 信号代码（python_backtest_runner.py 协议）"
                  hint="返回 buy[]/sell[] 等长数组；可作为回测的 signal 源"
                  code={detail.signalCode}
                  onCopy={() => onCopyCode(detail.signalCode, "signal_code")}
                />
              ) : null}
              {detail.ideCode && detail.ideCode.trim().length > 0 ? (
                <CodeBlock
                  title="ide_code · 主代码（python_strategy_backtest_runner.py · on_bar）"
                  hint="逐 bar 回调；ctx.buy/ctx.sell + ctx.state 跨 bar 状态"
                  code={detail.ideCode}
                  onCopy={() => onCopyCode(detail.ideCode, "ide_code")}
                />
              ) : null}
              {!detail.signalCode?.trim() && !detail.ideCode?.trim() ? (
                <div style={styles.empty}>该脚本暂无代码内容。</div>
              ) : null}
              {detail.aiPromptSnapshot && detail.aiPromptSnapshot.trim().length > 0 ? (
                <CodeBlock
                  title="ai_prompt_snapshot · 产生时的 AI 提示词"
                  hint="如果脚本由 Agent 生成，这里能看到当时的 prompt"
                  code={detail.aiPromptSnapshot}
                  onCopy={() => onCopyCode(detail.aiPromptSnapshot ?? "", "ai_prompt")}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ ...styles.empty, padding: 24 }}>
            {scripts.length === 0
              ? "本 project 暂无 Python 脚本 —— 去研究工作台左栏 Indicator tab 写一个 on_bar()"
              : "从左侧选一条脚本查看代码"}
          </div>
        )}
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>说明</strong>
        </div>
        <div style={{ padding: 12, fontSize: 11, color: "var(--qb-text-muted)", lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4 }}>
            这里是什么？
          </div>
          量化工作台里两种"策略"并存：
          <ul style={{ paddingLeft: 18, margin: "4px 0 12px" }}>
            <li>
              <strong>组合工坊</strong>：因子配方（factor + rule + 权重） — 纯 TS 执行
            </li>
            <li>
              <strong>脚本工坊（此处）</strong>：Python — 旧路径 <code>on_bar()</code>，或 Strategy API V2
              （<code>initialize</code> + <code>handle_data</code>）。点「验证契约」编译 Manifest。
            </li>
          </ul>

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            能做什么
          </div>
          <ul style={{ paddingLeft: 18, margin: "4px 0 12px" }}>
            <li>只读看代码 · 验证契约 · 契约回测</li>
            <li>纸交易部署 / 回放（dry_run intents）</li>
            <li>启动纸交易引擎（strategy_runtime · paper）</li>
          </ul>

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            Team → 工坊
          </div>
          研究产出脚本点「在工坊打开」会跳到本 Tab；再点上方按钮进引擎。
          Orchestrator 写码请用{" "}
          <code>agent.invoke(callee_spec_id=def-strategy-coder)</code>。

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            在哪里编辑？
          </div>
          研究工作台左栏 <strong>Monaco</strong> 编辑 Workspace 文件；脚本请先同步/落到课题 FS，再从 Explorer 打开。
          「在 IDE 打开」会切到工作台。

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            为什么这里不能编辑？
          </div>
          编辑落在 Workspace Monaco（单一真相源）。这里专注：项目维度只读检视、跨 session 列表、跳转入口。

          <div style={{ fontWeight: 600, color: "var(--qb-text-strong)", marginBottom: 4, marginTop: 12 }}>
            Backlog
          </div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>scriptId → 回测直连（扩 BacktestSignalSpec.kind=&quot;script&quot;）</li>
            <li>lineage 字段（createdBy / agentInstanceId）</li>
            <li>从这里 clone / 派生新脚本</li>
            <li>组合工坊的 kind=&quot;script&quot; 直接引用本脚本</li>
          </ul>
        </div>
      </aside>

      {error ? <div style={styles.errorToast}>{error}</div> : null}
      {info ? <div style={styles.infoToast}>{info}</div> : null}
    </div>
  );
};

/** 代码块只读展示 + 一键复制 —— 没装 syntax highlighter，先用 monospace + line-numbers off */
const CodeBlock: FC<{
  title: string;
  hint?: string;
  code: string;
  onCopy: () => void;
}> = ({ title, hint, code, onCopy }) => {
  const lines = code.split("\n").length;
  return (
    <div style={styles.codeBlock}>
      <div style={styles.codeBlockHeader}>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{title}</span>
          {hint ? <span style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>{hint}</span> : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--qb-text-muted)" }}>
            {code.length}c · {lines} lines
          </span>
          <button type="button" onClick={onCopy} style={styles.btnGhost}>
            复制
          </button>
        </div>
      </div>
      <pre style={styles.pre}>
        <code style={styles.code}>{code}</code>
      </pre>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, 320px) 1fr minmax(220px, 280px)",
    height: "100%",
    minHeight: 0,
  },
  colLeft: {
    display: "flex",
    flexDirection: "column",
    borderRight: "1px solid var(--qb-border-subtle)",
    minHeight: 0,
  },
  colMid: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "auto",
    padding: 10,
  },
  colRight: {
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--qb-border-subtle)",
    minHeight: 0,
    overflow: "auto",
  },
  colHeader: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 12,
  },
  filterRow: {
    flex: "0 0 auto",
    display: "flex",
    gap: 6,
    padding: "6px 10px 8px",
    borderBottom: "1px solid var(--qb-border-subtle)",
  },
  list: { flex: 1, minHeight: 0, overflow: "auto" },
  listItem: {
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    borderBottom: "1px solid var(--qb-border-subtle)",
    cursor: "pointer",
    color: "inherit",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  listItemActive: { background: "var(--qb-bg-elevated)" },
  listItemTop: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
  },
  listItemMeta: { fontSize: 10, color: "var(--qb-text-muted)" },
  purposeChip: {
    display: "inline-flex",
    alignItems: "center",
    padding: "1px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    border: "1px solid",
    letterSpacing: 0.2,
    flexShrink: 0,
  },
  heroCard: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    padding: 14,
  },
  detailHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  detailTitle: { fontSize: 14, fontWeight: 600 },
  codeSectionsWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  codeBlock: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    background: "var(--qb-bg-surface)",
    overflow: "hidden",
  },
  codeBlockHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    background: "var(--qb-bg-elevated)",
  },
  pre: {
    margin: 0,
    padding: "10px 12px",
    maxHeight: 480,
    overflow: "auto",
    fontSize: 11,
    lineHeight: 1.55,
    fontFamily: "var(--qb-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    background: "var(--qb-bg-surface)",
  },
  code: {
    fontFamily: "inherit",
    color: "var(--qb-text-strong)",
    whiteSpace: "pre",
  },
  select: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  btnPrimary: {
    padding: "4px 10px",
    fontSize: 12,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-elevated)",
    cursor: "pointer",
    color: "inherit",
  },
  btnGhost: {
    padding: "2px 8px",
    fontSize: 11,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  empty: {
    padding: 18,
    color: "var(--qb-text-muted)",
    fontSize: 12,
    textAlign: "center",
  },
  muted: { fontSize: 11, color: "var(--qb-text-muted)" },
  errorPanel: {
    padding: 16,
    color: "var(--qb-quant-accent-5)",
    fontSize: 12,
  },
  errorToast: {
    position: "absolute",
    bottom: 18,
    right: 18,
    padding: "8px 12px",
    background: "color-mix(in srgb, var(--qb-quant-accent-5) 12%, var(--qb-bg-elevated))",
    border: "1px solid var(--qb-quant-accent-5)",
    borderRadius: 6,
    fontSize: 11,
    color: "var(--qb-quant-accent-5)",
    maxWidth: 360,
    whiteSpace: "pre-wrap",
  },
  infoToast: {
    position: "absolute",
    bottom: 18,
    right: 18,
    padding: "8px 12px",
    background: "color-mix(in srgb, var(--qb-quant-accent-3) 12%, var(--qb-bg-elevated))",
    border: "1px solid var(--qb-quant-accent-3)",
    borderRadius: 6,
    fontSize: 11,
    color: "var(--qb-quant-accent-3)",
    maxWidth: 360,
  },
};
