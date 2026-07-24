import type { CSSProperties, FC } from "react";
import { useEffect, useRef, useState } from "react";
import {
  getOrCreateDefaultProject,
  createStrategyRuntime,
  approveStrategyRuntimeForLive,
  evaluatePaperRuntime,
  getDefaultProjectSession,
  getDefaultWorkspace,
  createPortfolioAllocationPlan,
  remediatePositionReconciliation,
  scanPositionReconciliation,
  listProjects,
  listStrategyRuntimes,
  listStrategyScripts,
  stopStrategyRuntime,
} from "../../api/backend";
import type {
  PortfolioAllocationPlan,
  PositionRemediationPlan,
  PositionReconciliationReport,
  StrategyRuntimeRecord,
} from "../../api/backend";
import type { BrokerProvider, IndicatorStrategyScriptRecord } from "../../api/types";
import { CHART_TIMEFRAMES, chartControlStyle } from "../../lib/chartSpec";
import { ChartMarketSelect } from "../chart/ChartMarketSelect";
import { useTraderAgentEngine } from "../../hooks/useTraderAgentEngine";
import { KlinePanel } from "../chart/KlinePanel";
import { IdeQuickTradePanel } from "../ide/IdeQuickTradePanel";
import { useAppStore } from "../../store";

const styles: Record<string, CSSProperties> = {
  root: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    background: "transparent",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  details: {
    flexShrink: 0,
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  summary: {
    cursor: "pointer",
    padding: "10px 14px",
    fontSize: 13,
    color: "var(--qb-main-meta, #a1a1aa)",
    listStyle: "none",
    userSelect: "none",
  },
  configBody: {
    padding: "0 14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    maxWidth: 900,
  },
  row: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" },
  lab: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  inp: {
    minWidth: 120,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
  },
  select: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
  },
  field: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
    ...chartControlStyle,
  },
  hint: { margin: 0, fontSize: 11, color: "var(--qb-main-meta, #71717a)", lineHeight: 1.45 },
  scriptList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    maxHeight: 160,
    overflow: "auto",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    padding: 8,
    background: "var(--qb-stream-box-bg, #0c0c0e)",
  },
  scriptRow: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12 },
  mainRow: {
    flex: 1,
    display: "grid",
    gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 38%)",
    minHeight: 0,
    minWidth: 0,
    overflow: "auto",
  },
  flowCol: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    borderRight: "1px solid var(--qb-ide-chrome-border, #27272a)",
  },
  flowHead: {
    flexShrink: 0,
    padding: "10px 12px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--qb-team-titlebar-fg, #cbd5e1)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  flowTabs: {
    flexShrink: 0,
    display: "flex",
    gap: 4,
    padding: "6px 10px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  flowTab: {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid transparent",
    background: "transparent",
    color: "var(--qb-main-meta, #a1a1aa)",
    fontSize: 12,
    cursor: "pointer",
  },
  flowTabActive: {
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-card-bg, #18181b)",
    color: "var(--qb-body-fg, #e4e4e7)",
    fontWeight: 600,
  },
  driverKind: {
    display: "inline-block",
    marginRight: 6,
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 10,
    background: "rgba(59, 130, 246, 0.15)",
    color: "#93c5fd",
  },
  msgType: {
    display: "inline-block",
    marginRight: 6,
    padding: "1px 6px",
    borderRadius: 4,
    fontSize: 10,
    background: "rgba(168, 85, 247, 0.15)",
    color: "#d8b4fe",
  },
  flowActions: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  flowScroll: {
    flex: 1,
    overflow: "auto",
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 0,
    background: "var(--qb-main-panel-bg, var(--qb-bg-root))",
  },
  cmdRow: {
    flexShrink: 0,
    display: "flex",
    gap: 8,
    padding: "8px 12px",
    borderTop: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  cmdInp: {
    flex: 1,
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
  },
  logCard: {
    border: "1px solid var(--qb-main-card-border, #27272a)",
    borderRadius: 8,
    padding: "8px 10px",
    background: "var(--qb-main-card-bg, #18181b)",
  },
  logMeta: { fontSize: 10, color: "var(--qb-main-meta, #71717a)", marginBottom: 4 },
  logTitle: { fontSize: 12, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)", marginBottom: 4 },
  logBody: {
    fontSize: 12,
    color: "var(--qb-card-desc, #a1a1aa)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.45,
  },
  rightCol: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
  },
  klineToolbar: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "flex-end",
    padding: "8px 10px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  klineSlot: {
    flex: 1.25,
    minHeight: 220,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
  },
  tradeSlot: {
    flex: "0 0 auto",
    maxHeight: "42%",
    minHeight: 200,
    overflow: "auto",
    display: "flex",
    flexDirection: "column",
  },
};

function chartExchangeToMarket(exchange: string): string {
  const u = exchange.trim().toUpperCase();
  if (u === "HK") return "HK";
  if (u === "US") return "US";
  if (u === "CRYPTO") return "CRYPTO";
  return "CN";
}

export const TraderLivePanel: FC = () => {
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const chartSpec = useAppStore((s) => s.chartSpec);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const traderAgentLog = useAppStore((s) => s.traderAgentLog);
  const pushTraderAgentLog = useAppStore((s) => s.pushTraderAgentLog);
  const clearTraderAgentLog = useAppStore((s) => s.clearTraderAgentLog);
  const traderDrivers = useAppStore((s) => s.traderDrivers);
  const clearTraderDrivers = useAppStore((s) => s.clearTraderDrivers);
  const traderAgentMessages = useAppStore((s) => s.traderAgentMessages);
  const clearTraderAgentMessages = useAppStore((s) => s.clearTraderAgentMessages);
  const clearTraderMarkers = useAppStore((s) => s.clearTraderMarkers);
  const traderAgentConfig = useAppStore((s) => s.traderAgentConfig);
  const setTraderAgentConfig = useAppStore((s) => s.setTraderAgentConfig);
  const toggleTraderStrategyScriptId = useAppStore((s) => s.toggleTraderStrategyScriptId);

  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [runtimes, setRuntimes] = useState<StrategyRuntimeRecord[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null);
  const [scriptsErr, setScriptsErr] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userCmd, setUserCmd] = useState("");
  const [lastOrderIntentId, setLastOrderIntentId] = useState<string | null>(null);
  const [reconcileProvider, setReconcileProvider] = useState<BrokerProvider>("futu");
  const [reconcileReport, setReconcileReport] = useState<PositionReconciliationReport | null>(null);
  const [remediationPlan, setRemediationPlan] = useState<PositionRemediationPlan | null>(null);
  const [remediationRuntimeId, setRemediationRuntimeId] = useState("");
  const [remediationBusy, setRemediationBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [portfolioCapital, setPortfolioCapital] = useState(100_000);
  const [portfolioPlan, setPortfolioPlan] = useState<PortfolioAllocationPlan | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [flowTab, setFlowTab] = useState<"decision" | "drivers" | "messages">("decision");
  const booted = useRef(false);

  const engine = useTraderAgentEngine(projectId, sessionId);

  const runPositionReconciliation = async () => {
    if (!projectId) return;
    setReconcileError(null);
    try {
      const result = await scanPositionReconciliation({
        projectId,
        provider: reconcileProvider,
      });
      setReconcileReport(result.report);
      setRemediationPlan(result.remediation);
    } catch (error) {
      setReconcileReport(null);
      setRemediationPlan(null);
      setReconcileError(error instanceof Error ? error.message : String(error));
    }
  };

  const executePositionRemediation = async () => {
    if (!projectId || !remediationPlan || !remediationRuntimeId) return;
    const actionSummary = remediationPlan.actions
      .map((action) => `${action.action === "buy" ? "买入" : "卖出"} ${action.symbol} ${action.quantity}`)
      .join("\n");
    if (!window.confirm(`将重新对账并通过风控/HITL 下发以下修复单：\n${actionSummary}\n\n确认继续？`)) return;
    setRemediationBusy(true);
    setReconcileError(null);
    try {
      const result = await remediatePositionReconciliation({
        projectId,
        provider: reconcileProvider,
        expectedPlanHash: remediationPlan.planHash,
        strategyRuntimeId: remediationRuntimeId,
      });
      await runPositionReconciliation();
      setReconcileError(`已提交 ${result.orders.length} 个修复订单；订单仍需通过风控与人工审批。`);
    } catch (error) {
      setReconcileError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemediationBusy(false);
    }
  };

  const runPortfolioAllocation = async () => {
    if (!projectId) return;
    setPortfolioError(null);
    try {
      setPortfolioPlan(await createPortfolioAllocationPlan({
        projectId,
        capital: portfolioCapital,
        grossLimit: 1,
        netLimit: 0.5,
        perPositionMax: 0.25,
        totalRiskBudget: 0.02,
        maxSectorGross: 0.4,
      }));
    } catch (error) {
      setPortfolioPlan(null);
      setPortfolioError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      try {
        // 单租户兜底 workspace；详见 src/runtime/bootstrap/ensure-default-workspace.ts。
        const dft = await getDefaultWorkspace();
        const wsId = dft.id;
        const projects = await listProjects(wsId);
        let pid = projects[0]?.id;
        if (!pid) {
          // 只读 get-or-create：后端写死稳定 ID 幂等，不再前端 createProject 兜底。
          const dftProj = await getOrCreateDefaultProject();
          pid = dftProj.id;
        }
        const session = await getDefaultProjectSession(pid);
        setProjectId(pid);
        setSessionId(session.id);
        const rows = await listStrategyScripts(session.id);
        setScripts(rows);
        const rt = await listStrategyRuntimes({ sessionId: session.id });
        setRuntimes(rt);
        pushTraderAgentLog({
          kind: "ingest",
          title: "会话与策略库已连接",
          body: `sessionId=${session.id}\n已加载 ${rows.length} 条策略脚本。策略运行时、资讯轮询与用户指令将驱动纸面下单。`,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setScriptsErr(msg);
        pushTraderAgentLog({
          kind: "info",
          title: "策略库加载失败",
          body: msg,
        });
      }
    })();
  }, [pushTraderAgentLog]);

  const ingestChartToAgent = () => {
    const spec = useAppStore.getState().chartSpec;
    pushTraderAgentLog({
      kind: "ingest",
      title: "行情上下文（与 K 线 / 快捷交易共用 chartSpec）",
      body: `symbol=${spec.symbol} exchange=${spec.exchange} tf=${spec.timeframe} limit=${spec.limit}`,
    });
  };

  const startSelectedStrategyRuntime = async () => {
    const scriptId = traderAgentConfig.strategyScriptIds[0];
    if (!scriptId) {
      setRuntimeMsg("请先勾选一条策略脚本");
      return;
    }
    const spec = useAppStore.getState().chartSpec;
    setRuntimeBusy(true);
    setRuntimeMsg(null);
    try {
      const row = await createStrategyRuntime({
        strategyScriptId: scriptId,
        market: chartExchangeToMarket(spec.exchange),
        symbol: spec.symbol.trim(),
        timeframe: spec.timeframe,
        executionMode: "paper",
        autoStart: true,
        params: { orderQty: 100, barLimit: 120 },
      });
      setRuntimes((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
      setRuntimeMsg(`已启动模拟运行时 ${row.id.slice(0, 8)}…`);
      pushTraderAgentLog({
        kind: "decision",
        title: "策略运行时已启动",
        body: `runtime=${row.id} mode=paper symbol=${row.symbol}`,
      });
    } catch (e) {
      setRuntimeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const stopRuntimeById = async (id: string) => {
    setRuntimeBusy(true);
    try {
      const row = await stopStrategyRuntime(id);
      setRuntimes((prev) => prev.map((r) => (r.id === id ? row : r)));
      setRuntimeMsg(`已停止 ${id.slice(0, 8)}…`);
    } catch (e) {
      setRuntimeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const evaluatePaperById = async (id: string) => {
    setRuntimeBusy(true);
    try {
      const result = await evaluatePaperRuntime(id);
      setRuntimeMsg(
        `Paper Gate ${result.pass ? "通过" : "未通过"}：${result.tradingDays} 日，收益 ${(result.netReturn * 100).toFixed(2)}%，Sharpe ${result.sharpe.toFixed(2)}`
      );
    } catch (error) {
      setRuntimeMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const approveLiveById = async (id: string) => {
    setRuntimeBusy(true);
    try {
      const result = await approveStrategyRuntimeForLive(id);
      setRuntimeMsg(result.liveEligible ? "已批准进入 live" : "尚未满足 live 条件");
    } catch (error) {
      setRuntimeMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const submitUserCmd = async () => {
    const text = userCmd.trim();
    if (!text) return;
    setUserCmd("");
    try {
      const data = await engine.runCommand(text);
      if (data?.orderIntentId) setLastOrderIntentId(data.orderIntentId);
    } catch (e) {
      pushTraderAgentLog({
        kind: "user",
        title: "指令执行失败",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div data-qb-trader-root style={styles.root}>
      <details className="qb-a3d-tilt" style={styles.details} data-qb-trader-bar>
        <summary style={styles.summary}>交易 Agent 配置</summary>
        <div style={styles.configBody}>
          <p style={styles.hint}>
            触发方式持久化于 sessionStorage。策略信号由后台 worker 评估并下单；定时/资讯由 Agent
            轮询 feed 写入左侧流；用户可在下方输入「买入 100」「撤单 &lt;intentId&gt;」等指令。
          </p>
          <div style={styles.row}>
            <label style={styles.lab}>
              触发方式
              <select
                style={styles.select}
                value={traderAgentConfig.triggerMode}
                onChange={(e) =>
                  setTraderAgentConfig({
                    triggerMode: e.target.value as "manual" | "interval" | "strategy_signal",
                  })
                }
              >
                <option value="manual">手动（快捷交易 + 用户指令）</option>
                <option value="interval">定时轮询（资讯 + 策略日志 + K 线刷新）</option>
                <option value="strategy_signal">策略信号（后台运行时自动下单）</option>
              </select>
            </label>
            {traderAgentConfig.triggerMode === "interval" ? (
              <label style={styles.lab}>
                间隔（秒）
                <input
                  style={styles.inp}
                  type="number"
                  min={10}
                  max={3600}
                  value={traderAgentConfig.intervalSec}
                  onChange={(e) =>
                    setTraderAgentConfig({ intervalSec: Number(e.target.value) || 60 })
                  }
                />
              </label>
            ) : null}
            <button type="button" className="qb-btn-ghost" onClick={() => requestChartReload()}>
              刷新 K 线数据
            </button>
            <button type="button" className="qb-btn-ghost" onClick={ingestChartToAgent}>
              将当前品种写入对话流
            </button>
          </div>
          <div style={styles.row}>
            <label style={styles.lab}>
              持仓对账券商
              <select
                style={styles.select}
                value={reconcileProvider}
                onChange={(event) =>
                  setReconcileProvider(event.target.value as BrokerProvider)
                }
              >
                <option value="futu">Futu</option>
                <option value="ib">IB</option>
                <option value="ccxt">CCXT</option>
                <option value="alpaca">Alpaca</option>
                <option value="supermind">同花顺 SuperMind</option>
                <option value="eastmoney_emt">东方财富 EMT</option>
              </select>
            </label>
            <button
              type="button"
              className="qb-btn-secondary"
              disabled={!projectId}
              onClick={() => void runPositionReconciliation()}
            >
              对账内部账本 / 券商持仓
            </button>
            {reconcileReport ? (
              <span
                style={{
                  ...styles.hint,
                  color: reconcileReport.summary.mismatched > 0 ? "#f59e0b" : "#22c55e",
                }}
              >
                匹配 {reconcileReport.summary.matched}/{reconcileReport.summary.symbols} · 偏差标的{
                  reconcileReport.summary.mismatched
                } · 名义偏差 {reconcileReport.summary.absoluteNotionalDelta.toFixed(2)}
              </span>
            ) : null}
            {reconcileError ? (
              <span style={{ ...styles.hint, color: reconcileError.startsWith("已提交") ? "#22c55e" : "#ef4444" }}>
                {reconcileError}
              </span>
            ) : null}
          </div>
          {remediationPlan?.actions.length ? (
            <div style={styles.scriptList}>
              <strong style={{ fontSize: 12, color: "#f59e0b" }}>
                修复提案 · 仅显式确认后提交 · {remediationPlan.actions.length} 笔
              </strong>
              {remediationPlan.actions.map((action) => (
                <div key={action.symbol} style={{ ...styles.scriptRow, justifyContent: "space-between" }}>
                  <span>{action.action === "buy" ? "买入" : "卖出"} {action.symbol} · {action.quantity}</span>
                  <span style={styles.hint}>估算名义 {action.estimatedNotional.toFixed(2)}</span>
                </div>
              ))}
              <div style={styles.row}>
                <label style={styles.lab}>
                  修复执行上下文（Live Runtime）
                  <select
                    style={styles.select}
                    value={remediationRuntimeId}
                    onChange={(event) => setRemediationRuntimeId(event.target.value)}
                  >
                    <option value="">请选择已审批的 Live Runtime</option>
                    {runtimes
                      .filter((runtime) => runtime.executionMode === "live" && runtime.brokerAccountId)
                      .map((runtime) => (
                        <option key={runtime.id} value={runtime.id}>
                          {runtime.symbol} · {runtime.status} · {runtime.id.slice(0, 8)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={remediationBusy || !remediationRuntimeId}
                  onClick={() => void executePositionRemediation()}
                >
                  {remediationBusy ? "重新核对中…" : "确认并进入风控下单"}
                </button>
              </div>
              {!runtimes.some((runtime) => runtime.executionMode === "live" && runtime.brokerAccountId) ? (
                <span style={{ ...styles.hint, color: "#f59e0b" }}>
                  暂无绑定券商账户的 Live Runtime；请先完成策略晋级和 Live 配置。
                </span>
              ) : null}
            </div>
          ) : null}
          <div style={styles.row}>
            <label style={styles.lab}>
              组合总资金
              <input
                style={styles.inp}
                type="number"
                min={1}
                value={portfolioCapital}
                onChange={(event) => setPortfolioCapital(Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <button
              type="button"
              className="qb-btn-secondary"
              disabled={!projectId}
              onClick={() => void runPortfolioAllocation()}
            >
              从有效推荐生成组合计划
            </button>
            {portfolioPlan ? (
              <span style={{ ...styles.hint, color: "#22c55e" }}>
                {portfolioPlan.rows.length} 个目标仓位 · 总暴露 {(portfolioPlan.exposures.grossExposure * 100).toFixed(1)}%
                · 净暴露 {(portfolioPlan.exposures.netExposure * 100).toFixed(1)}% · 止损风险预算
                {(portfolioPlan.exposures.estimatedLossAtStopsPct * 100).toFixed(2)}%
                {portfolioPlan.risk?.metrics
                  ? ` · VaR95 ${(portfolioPlan.risk.metrics.historicalVar95Pct * 100).toFixed(2)}% · ES95 ${(portfolioPlan.risk.metrics.expectedShortfall95Pct * 100).toFixed(2)}%`
                  : " · 历史风险数据不足"}
              </span>
            ) : null}
            {portfolioError ? <span style={{ ...styles.hint, color: "#ef4444" }}>{portfolioError}</span> : null}
          </div>
          {portfolioPlan ? (
            <div style={styles.scriptList}>
              {portfolioPlan.rows.map((row) => (
                <div key={row.symbol} style={{ ...styles.scriptRow, justifyContent: "space-between" }}>
                  <strong>{row.symbol} · {row.side.toUpperCase()}</strong>
                  <span style={styles.hint}>
                    目标 {(row.targetWeight * 100).toFixed(2)}% / {row.targetQty.toFixed(2)} 股 · 调仓
                    {row.rebalanceQty >= 0 ? "+" : ""}{row.rebalanceQty.toFixed(2)} · 风险
                    {(row.riskContributionPct * 100).toFixed(2)}%
                  </span>
                </div>
              ))}
              {portfolioPlan.warnings.map((warning) => (
                <span key={warning} style={{ ...styles.hint, color: "#f59e0b" }}>⚠ {warning}</span>
              ))}
              {portfolioPlan.risk?.stressTests.slice(0, 2).map((stress) => (
                <span key={stress.scenario} style={{ ...styles.hint, color: stress.lossAmount > 0 ? "#f59e0b" : "#22c55e" }}>
                  压力 {stress.scenario}：{(stress.portfolioReturnPct * 100).toFixed(2)}% / 损失 {stress.lossAmount.toFixed(2)}
                </span>
              ))}
              {portfolioPlan.risk?.warnings.map((warning) => (
                <span key={`risk-${warning}`} style={{ ...styles.hint, color: "#f59e0b" }}>⚠ {warning}</span>
              ))}
            </div>
          ) : null}
          <div>
            <div style={{ ...styles.lab, marginBottom: 6 }}>运行策略（Python 策略库 · 多选）</div>
            {scriptsErr ? <p style={{ ...styles.hint, color: "#ef4444" }}>{scriptsErr}</p> : null}
            <div style={styles.scriptList}>
              {scripts.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>
                  暂无脚本；请先在 IDE 保存策略或写入会话策略库。
                </span>
              ) : (
                scripts.map((s) => (
                  <label key={s.id} style={styles.scriptRow}>
                    <input
                      type="checkbox"
                      checked={traderAgentConfig.strategyScriptIds.includes(s.id)}
                      onChange={() => toggleTraderStrategyScriptId(s.id)}
                    />
                    <span>
                      <strong style={{ color: "var(--qb-body-fg, #e4e4e7)" }}>{s.name}</strong>
                      <span style={{ color: "var(--qb-main-meta, #52525b)" }}> · {s.purpose}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
          <div style={styles.row}>
            <button
              type="button"
              className="qb-btn-primary-brand"
              disabled={runtimeBusy}
              onClick={() => void startSelectedStrategyRuntime()}
            >
              启动策略运行时（纸面）
            </button>
            {runtimeMsg ? <span style={styles.hint}>{runtimeMsg}</span> : null}
          </div>
          {runtimes.length > 0 ? (
            <div style={styles.scriptList}>
              {runtimes.slice(0, 5).map((r) => (
                <div key={r.id} style={{ ...styles.scriptRow, justifyContent: "space-between" }}>
                  <span>
                    {r.symbol} · {r.status} · {r.executionMode}
                  </span>
                  {r.status === "running" ? (
                    <button
                      type="button"
                      className="qb-btn-ghost qb-btn--compact"
                      disabled={runtimeBusy}
                      onClick={() => void stopRuntimeById(r.id)}
                    >
                      停止
                    </button>
                  ) : (
                    <span style={{ display: "flex", gap: 6 }}>
                      {r.executionMode === "paper" ? (
                        <button
                          type="button"
                          className="qb-btn-ghost qb-btn--compact"
                          disabled={runtimeBusy}
                          onClick={() => void evaluatePaperById(r.id)}
                        >
                          评估 Paper
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="qb-btn-ghost qb-btn--compact"
                        disabled={runtimeBusy}
                        onClick={() => void approveLiveById(r.id)}
                      >
                        审批 Live
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>

      <div style={styles.mainRow}>
        <div className="qb-trader-module qb-a3d-tilt" style={styles.flowCol}>
          <div style={styles.flowHead} data-qb-trader-bar>
            交易 Agent 工作台
          </div>
          <div style={styles.flowTabs} data-qb-trader-bar>
            {(
              [
                ["decision", "决策流", traderAgentLog.length],
                ["drivers", "策略驱动", traderDrivers.length],
                ["messages", "Agent 消息", traderAgentMessages.length],
              ] as const
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                data-qb-trader-flow-tab
                data-active={flowTab === key ? "true" : "false"}
                style={{
                  ...styles.flowTab,
                  ...(flowTab === key ? styles.flowTabActive : {}),
                }}
                onClick={() => setFlowTab(key)}
              >
                {label}
                {count > 0 ? ` (${count})` : ""}
              </button>
            ))}
          </div>
          <div style={styles.flowActions} data-qb-trader-bar>
            <button
              type="button"
              className="qb-btn-primary-brand"
              disabled={engine.busy || !engine.session}
              onClick={() => void engine.runAgentCycle()}
            >
              Agent 轮询一轮
            </button>
            <button
              type="button"
              className="qb-btn-ghost"
              onClick={() => {
                if (flowTab === "decision") clearTraderAgentLog();
                else if (flowTab === "drivers") clearTraderDrivers();
                else clearTraderAgentMessages();
              }}
            >
              清空当前页
            </button>
            <button type="button" className="qb-btn-ghost" onClick={clearTraderMarkers}>
              清空 K 线标记
            </button>
          </div>
          <div style={styles.flowScroll} data-qb-trader-scroll>
            {flowTab === "decision" ? (
              traderAgentLog.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>
                  暂无决策记录。成交、风控结果与用户操作将显示在此。
                </div>
              ) : (
                [...traderAgentLog].reverse().map((row) => (
                  <div key={row.id} style={styles.logCard} data-qb-trader-card>
                    <div style={styles.logMeta}>
                      {new Date(row.ts).toLocaleString()} · {row.kind}
                    </div>
                    <div style={styles.logTitle}>{row.title}</div>
                    <div style={styles.logBody}>{row.body}</div>
                  </div>
                ))
              )
            ) : null}
            {flowTab === "drivers" ? (
              traderDrivers.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>
                  暂无策略驱动。来源包括：策略运行时评估、定时任务、资讯
                  RSS、外部通信、告警与用户指令。
                </div>
              ) : (
                [...traderDrivers].reverse().map((row) => (
                  <div key={row.id} style={styles.logCard} data-qb-trader-card>
                    <div style={styles.logMeta}>
                      {new Date(row.ts).toLocaleString()}
                      <span style={styles.driverKind}>{row.driverKind}</span>
                    </div>
                    <div style={styles.logTitle}>{row.title}</div>
                    <div style={styles.logBody}>{row.body}</div>
                  </div>
                ))
              )
            ) : null}
            {flowTab === "messages" ? (
              traderAgentMessages.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>
                  暂无 A2A 消息。工作流内 Agent 间 TASK_ASSIGN / ORDER_INTENT / RISK_BLOCK
                  等将显示在此。
                </div>
              ) : (
                [...traderAgentMessages].reverse().map((row) => (
                  <div key={row.id} style={styles.logCard} data-qb-trader-card>
                    <div style={styles.logMeta}>
                      {new Date(row.ts).toLocaleString()}
                      <span style={styles.msgType}>{row.messageType}</span>
                    </div>
                    <div style={styles.logTitle}>
                      {row.senderRole} → {row.receiverRole ?? "—"}
                    </div>
                    <div style={styles.logBody}>{row.summary}</div>
                    <div style={{ ...styles.logBody, marginTop: 4, fontSize: 11, opacity: 0.85 }}>
                      {row.body}
                    </div>
                  </div>
                ))
              )
            ) : null}
          </div>
          <div style={styles.cmdRow} data-qb-trader-bar>
            <input
              style={styles.cmdInp}
              value={userCmd}
              onChange={(e) => setUserCmd(e.target.value)}
              placeholder="用户指令：买入 100 / 卖出 50 / 撤单 <intentId>"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitUserCmd();
              }}
            />
            <button
              type="button"
              className="qb-btn-primary-brand"
              disabled={engine.busy || !engine.session || !userCmd.trim()}
              onClick={() => void submitUserCmd()}
            >
              执行
            </button>
          </div>
        </div>

        <div className="qb-trader-module qb-a3d-tilt" style={styles.rightCol}>
          <div style={styles.klineSlot}>
            <div style={styles.klineToolbar} data-qb-trader-bar>
              <label style={styles.lab}>
                代码
                <input
                  style={styles.field}
                  value={chartSpec.symbol}
                  onChange={(e) => setChartSpec({ symbol: e.target.value })}
                  placeholder="600000"
                />
              </label>
              <label style={styles.lab}>
                市场
                <ChartMarketSelect
                  style={styles.field}
                  value={chartSpec.exchange}
                  onChange={(exchange) => setChartSpec({ exchange })}
                />
              </label>
              <label style={styles.lab}>
                周期
                <select
                  style={styles.field}
                  value={chartSpec.timeframe}
                  onChange={(e) => setChartSpec({ timeframe: e.target.value })}
                >
                  {CHART_TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="qb-btn-ghost qb-btn--compact"
                onClick={() => requestChartReload()}
              >
                刷新
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <KlinePanel embedded linkTraderMarkers />
            </div>
          </div>
          <div style={styles.tradeSlot}>
            <IdeQuickTradePanel
              variant="trader"
              traderLinked
              traderBusy={engine.busy}
              lastOrderIntentId={lastOrderIntentId}
              onPlaceOrder={async (side, qty, orderKind) => {
                const data = await engine.placeOrder({ side, qty, orderType: orderKind });
                if (data?.orderIntentId) setLastOrderIntentId(data.orderIntentId);
              }}
              onPlaceBracket={async (
                side,
                qty,
                orderKind,
                takeProfitPrice,
                stopLossPrice,
              ) => {
                const data = await engine.placeBracketOrder({
                  side,
                  qty,
                  entryOrderType: orderKind,
                  takeProfitPrice,
                  stopLossPrice,
                });
                setLastOrderIntentId(data.entry.orderIntentId);
              }}
              onCancelLast={
                lastOrderIntentId
                  ? async () => {
                      await engine.cancelOrder(lastOrderIntentId);
                      setLastOrderIntentId(null);
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
};
