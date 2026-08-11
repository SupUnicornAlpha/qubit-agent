import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  approveStrategyRuntimeForLive,
  createPortfolioAllocationPlan,
  createStrategyRuntime,
  getTradingModuleStatus,
  evaluatePaperRuntime,
  getDefaultProjectSession,
  getDefaultWorkspace,
  getOrCreateDefaultProject,
  listBrokerAccounts,
  listExecutionIntents,
  listProjects,
  listStrategyRuntimes,
  listStrategyScripts,
  remediatePositionReconciliation,
  scanPositionReconciliation,
  stopStrategyRuntime,
  setTradingModuleStatus,
} from "../../api/backend";
import type {
  ExecutionIntentSummary,
  PortfolioAllocationPlan,
  PositionReconciliationReport,
  PositionRemediationPlan,
  StrategyRuntimeRecord,
} from "../../api/backend";
import type {
  BrokerAccountRecord,
  BrokerProvider,
  IndicatorStrategyScriptRecord,
} from "../../api/types";
import { useTraderAgentEngine } from "../../hooks/useTraderAgentEngine";
import { CHART_TIMEFRAMES, chartControlStyle } from "../../lib/chartSpec";
import type { TraderAgentLogRecord } from "../../store";
import { useAppStore } from "../../store";
import { ChartMarketSelect } from "../chart/ChartMarketSelect";
import { KlinePanel } from "../chart/KlinePanel";
import { IdeQuickTradePanel } from "../ide/IdeQuickTradePanel";
import { QuantStrategyWorkbench } from "./QuantStrategyWorkbench";

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
  hint: {
    margin: 0,
    fontSize: 11,
    color: "var(--qb-main-meta, #71717a)",
    lineHeight: 1.45,
  },
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
  scriptRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 12,
  },
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
  logMeta: {
    fontSize: 10,
    color: "var(--qb-main-meta, #71717a)",
    marginBottom: 4,
  },
  logTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--qb-body-fg, #e4e4e7)",
    marginBottom: 4,
  },
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

type DecisionBatch = {
  id: string;
  rows: TraderAgentLogRecord[];
  operation: string;
  outcome: string;
  status: "success" | "warning" | "error" | "neutral";
  emphasis: "execution" | "risk" | "normal";
};

function isStrategyDecisionRow(row: TraderAgentLogRecord): boolean {
  return (
    row.kind === "strategy" ||
    /(策略运行时|策略信号|contract_signal|strategy[_\s-]?runtime|runtime=)/i.test(
      `${row.title}\n${row.body}`,
    )
  );
}

function eventSummary(
  row: TraderAgentLogRecord,
): Omit<DecisionBatch, "id" | "rows"> {
  const text = `${row.title}\n${row.body}`.toLowerCase();
  const failed =
    /(error|失败|拒绝|block|reject|contract_signal_eval_error)/.test(text);
  const executed = /(executed|已提交|成交|filled|成功)/.test(text);
  const hasIntent = /orderintent=|order intent/.test(text);

  if (isStrategyDecisionRow(row)) {
    if (failed) {
      return {
        operation: "用最新已收盘 K 线评估策略表达式",
        outcome: "表达式评估失败，未创建订单或变更仓位",
        status: "error",
        emphasis: "risk",
      };
    }
    if (executed || hasIntent) {
      return {
        operation: "将策略目标仓位转换为委托",
        outcome: "已创建执行意图，等待风控与成交回报",
        status: "success",
        emphasis: "execution",
      };
    }
    return {
      operation: "扫描策略信号与目标仓位",
      outcome: "本轮未形成需要执行的仓位变更",
      status: "neutral",
      emphasis: "normal",
    };
  }

  if (row.kind === "ingest") {
    return {
      operation: "接收市场、资讯或工作流输入",
      outcome: "已写入决策上下文，等待后续 Agent 或策略消费",
      status: "neutral",
      emphasis: "normal",
    };
  }
  if (failed) {
    return {
      operation: row.title,
      outcome: "操作被阻断或失败，未造成持仓变更",
      status: "error",
      emphasis: "risk",
    };
  }
  return {
    operation: row.title,
    outcome:
      executed || hasIntent ? "已提交，等待下游回报" : "已记录到交易工作流",
    status: executed ? "success" : "warning",
    emphasis: executed || hasIntent ? "execution" : "normal",
  };
}

function decisionBatchesFrom(rows: TraderAgentLogRecord[]): DecisionBatch[] {
  const batches = new Map<string, DecisionBatch>();
  for (const row of [...rows].reverse()) {
    const summary = eventSummary(row);
    // A runtime can evaluate many instruments or retry in a short interval.  Keep
    // the actual events, but expose that burst as one operational batch first.
    const minute = Math.floor(row.ts / 60_000);
    const key = isStrategyDecisionRow(row)
      ? `strategy:${minute}:${summary.status}:${summary.operation}`
      : `event:${row.id}`;
    const existing = batches.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    batches.set(key, { id: key, rows: [row], ...summary });
  }
  // The event store can retain more history, while this operational surface only
  // renders the newest traces so a high-frequency runtime remains readable.
  return [...batches.values()].slice(0, 16);
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
  const clearTraderAgentMessages = useAppStore(
    (s) => s.clearTraderAgentMessages,
  );
  const clearTraderMarkers = useAppStore((s) => s.clearTraderMarkers);
  const traderAgentConfig = useAppStore((s) => s.traderAgentConfig);
  const setTraderAgentConfig = useAppStore((s) => s.setTraderAgentConfig);
  const toggleTraderStrategyScriptId = useAppStore(
    (s) => s.toggleTraderStrategyScriptId,
  );

  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [runtimes, setRuntimes] = useState<StrategyRuntimeRecord[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null);
  const [scriptsErr, setScriptsErr] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userCmd, setUserCmd] = useState("");
  const [lastOrderIntentId, setLastOrderIntentId] = useState<string | null>(
    null,
  );
  const [reconcileProvider, setReconcileProvider] =
    useState<BrokerProvider>("futu");
  const [reconcileReport, setReconcileReport] =
    useState<PositionReconciliationReport | null>(null);
  const [remediationPlan, setRemediationPlan] =
    useState<PositionRemediationPlan | null>(null);
  const [remediationRuntimeId, setRemediationRuntimeId] = useState("");
  const [remediationBusy, setRemediationBusy] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [portfolioCapital, setPortfolioCapital] = useState(100_000);
  const [portfolioPlan, setPortfolioPlan] =
    useState<PortfolioAllocationPlan | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [flowTab, setFlowTab] = useState<"decision" | "drivers" | "messages">(
    "decision",
  );
  const [expandedDecisionBatches, setExpandedDecisionBatches] = useState<
    Set<string>
  >(() => new Set());
  const [executionMode, setExecutionMode] = useState<"paper" | "sim">("paper");
  const [strategyMode, setStrategyMode] = useState<"paper" | "sim" | "live">(
    "paper",
  );
  const [brokerAccounts, setBrokerAccounts] = useState<BrokerAccountRecord[]>(
    [],
  );
  const [strategyBrokerAccountId, setStrategyBrokerAccountId] = useState("");
  const [surface, setSurface] = useState<
    "overview" | "quant" | "agent" | "manual" | "risk"
  >("overview");
  const [executionIntents, setExecutionIntents] = useState<
    ExecutionIntentSummary[]
  >([]);
  const [intentsError, setIntentsError] = useState<string | null>(null);
  const [tradingModuleEnabled, setTradingModuleEnabled] = useState(true);
  const booted = useRef(false);

  const engine = useTraderAgentEngine(
    projectId,
    sessionId,
    tradingModuleEnabled,
  );

  useEffect(() => {
    let cancelled = false;
    void getTradingModuleStatus()
      .then((status) => {
        if (!cancelled) setTradingModuleEnabled(status.enabled);
      })
      .catch(() => {
        // 后端短暂不可达时保留默认开启，不把只读/撤单功能误锁死。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const decisionBatches = useMemo(
    () => decisionBatchesFrom(traderAgentLog),
    [traderAgentLog],
  );
  const decisionSummary = useMemo(
    () => ({
      total: traderAgentLog.length,
      strategyRuns: traderAgentLog.filter(isStrategyDecisionRow).length,
      failed: traderAgentLog.filter(
        (row) => eventSummary(row).status === "error",
      ).length,
      executions: traderAgentLog.filter(
        (row) => eventSummary(row).emphasis === "execution",
      ).length,
    }),
    [traderAgentLog],
  );
  const riskSummary = useMemo(() => {
    const blocked = executionIntents.filter((intent) =>
      /(blocked|rejected|cancelled|failed)/i.test(intent.lifecycleStatus),
    ).length;
    const filled = executionIntents.filter(
      (intent) => intent.lifecycleStatus === "filled",
    ).length;
    const active = executionIntents.filter(
      (intent) =>
        !/(filled|blocked|rejected|cancelled|failed)/i.test(
          intent.lifecycleStatus,
        ),
    ).length;
    return { active, blocked, filled };
  }, [executionIntents]);

  const refreshExecutionIntents = useCallback(async () => {
    if (!engine.session?.workflowRunId) return;
    try {
      setIntentsError(null);
      setExecutionIntents(
        await listExecutionIntents({
          workflowRunId: engine.session.workflowRunId,
          limit: 20,
        }),
      );
    } catch (error) {
      setIntentsError(error instanceof Error ? error.message : String(error));
    }
  }, [engine.session?.workflowRunId]);

  useEffect(() => {
    void refreshExecutionIntents();
  }, [refreshExecutionIntents]);

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
      .map(
        (action) =>
          `${action.action === "buy" ? "买入" : "卖出"} ${action.symbol} ${action.quantity}`,
      )
      .join("\n");
    if (
      !window.confirm(
        `将重新对账并通过风控/HITL 下发以下修复单：\n${actionSummary}\n\n确认继续？`,
      )
    )
      return;
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
      setReconcileError(
        `已提交 ${result.orders.length} 个修复订单；订单仍需通过风控与人工审批。`,
      );
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
      setPortfolioPlan(
        await createPortfolioAllocationPlan({
          projectId,
          capital: portfolioCapital,
          grossLimit: 1,
          netLimit: 0.5,
          perPositionMax: 0.25,
          totalRiskBudget: 0.02,
          maxSectorGross: 0.4,
        }),
      );
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
        const accounts = await listBrokerAccounts();
        setBrokerAccounts(accounts);
        const preferred =
          accounts.find((account) => account.enabled && account.isDefault) ??
          accounts.find((account) => account.enabled);
        if (preferred) setStrategyBrokerAccountId(preferred.id);
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

  const startSelectedStrategyRuntime = async (
    selectedScriptId?: string,
    selectedPaperCapital?: number,
    selectedOrderQty?: number,
  ) => {
    const scriptId = selectedScriptId ?? traderAgentConfig.strategyScriptIds[0];
    if (!scriptId) {
      setRuntimeMsg("请先勾选一条策略脚本");
      return;
    }
    const selectedBrokerAccount = brokerAccounts.find(
      (account) => account.id === strategyBrokerAccountId,
    );
    if (
      strategyMode === "live" &&
      (!selectedBrokerAccount ||
        !selectedBrokerAccount.enabled ||
        selectedBrokerAccount.mode !== "live")
    ) {
      setRuntimeMsg("实盘发布必须选择已启用的实盘券商账户");
      return;
    }
    if (
      strategyMode === "live" &&
      !window.confirm(
        "将创建并启动实盘策略运行时。系统会在启动前再次校验回测、Paper 与人工审批闸门。确认继续？",
      )
    )
      return;
    const spec = useAppStore.getState().chartSpec;
    setRuntimeBusy(true);
    setRuntimeMsg(null);
    try {
      const row = await createStrategyRuntime({
        strategyScriptId: scriptId,
        market: chartExchangeToMarket(spec.exchange),
        symbol: spec.symbol.trim(),
        timeframe: spec.timeframe,
        executionMode: strategyMode,
        ...(strategyBrokerAccountId
          ? { brokerAccountId: strategyBrokerAccountId }
          : {}),
        autoStart: true,
        params: {
          orderQty: selectedOrderQty ?? 100,
          paperCapital: selectedPaperCapital ?? 100_000,
          barLimit: 120,
        },
      });
      setRuntimes((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
      setRuntimeMsg(
        `已启动${strategyMode === "paper" ? "纸面" : strategyMode === "sim" ? "券商模拟" : "实盘"}运行时 ${row.id.slice(0, 8)}…`,
      );
      pushTraderAgentLog({
        kind: "decision",
        title: "策略运行时已启动",
        body: `runtime=${row.id} mode=${strategyMode} symbol=${row.symbol}`,
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

  const startTradingModule = async () => {
    setRuntimeBusy(true);
    try {
      const status = await setTradingModuleStatus(true);
      setTradingModuleEnabled(status.enabled);
      setRuntimeMsg("交易模块已启动：交易 Agent 与工作面已恢复。");
    } catch (error) {
      setRuntimeMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const closeTradingModule = async () => {
    setRuntimeBusy(true);
    try {
      const status = await setTradingModuleStatus(false);
      const stoppedById = new Set(status.stoppedRuntimeIds ?? []);
      setRuntimes((previous) =>
        previous.map((runtime) =>
          stoppedById.has(runtime.id) ? { ...runtime, status: "stopped" } : runtime,
        ),
      );
      setTradingModuleEnabled(status.enabled);
      setRuntimeMsg(
        stoppedById.size > 0
          ? `交易模块已关闭，并停止 ${stoppedById.size} 个策略运行时。`
          : "交易模块已关闭。",
      );
      pushTraderAgentLog({
        kind: "decision",
        title: "交易模块已关闭",
        body: `stoppedRuntimes=${stoppedById.size}\n后端订单创建、策略启动与交易 Agent 轮询已暂停。`,
      });
    } catch (error) {
      setRuntimeMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const evaluatePaperById = async (id: string) => {
    setRuntimeBusy(true);
    try {
      const result = await evaluatePaperRuntime(id);
      setRuntimeMsg(
        `Paper Gate ${result.pass ? "通过" : "未通过"}：${result.tradingDays} 日，收益 ${(result.netReturn * 100).toFixed(2)}%，Sharpe ${result.sharpe.toFixed(2)}`,
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
      setRuntimeMsg(
        result.liveEligible ? "已批准进入 live" : "尚未满足 live 条件",
      );
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
      const data = await engine.runCommand(text, executionMode);
      if (data?.orderIntentId) setLastOrderIntentId(data.orderIntentId);
      void refreshExecutionIntents();
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
      <header className="qb-trade-header">
        <div className="qb-trade-title">
          <p>EXECUTION CONTROL</p>
          <h1>交易</h1>
        </div>
        <div className="qb-trade-health" aria-label="交易运行状态">
          <div>
            <span>执行模式</span>
            <strong className="qb-trade-status--warn">
              {executionMode === "paper" ? "纸面" : "券商模拟"}
            </strong>
          </div>
          <div>
            <span>策略运行</span>
            <strong
              className={
                tradingModuleEnabled &&
                runtimes.some((r) => r.status === "running")
                  ? "qb-trade-status--ok"
                  : ""
              }
            >
              {runtimes.filter((r) => r.status === "running").length} 个运行中
            </strong>
          </div>
          <div>
            <span>Agent 会话</span>
            <strong
              className={
                tradingModuleEnabled && engine.session
                  ? "qb-trade-status--ok"
                  : "qb-trade-status--warn"
              }
            >
              {tradingModuleEnabled
                ? engine.session
                  ? "已连接"
                  : "连接中"
                : "已暂停"}
            </strong>
          </div>
          <div>
            <span>最后同步</span>
            <strong>
              {engine.lastPollAt
                ? new Date(engine.lastPollAt).toLocaleTimeString()
                : "等待数据"}
            </strong>
          </div>
        </div>
        <label className="qb-trade-mode">
          下单环境
          <select
            style={styles.select}
            value={executionMode}
            onChange={(e) =>
              setExecutionMode(e.target.value as "paper" | "sim")
            }
          >
            <option value="paper">纸面</option>
            <option value="sim">券商模拟</option>
          </select>
        </label>
        <div className="qb-trade-module-switch">
          <span>交易模块</span>
          <strong data-enabled={tradingModuleEnabled}>
            {tradingModuleEnabled ? "运行中" : "已关闭"}
          </strong>
          <button
            type="button"
            className={
              tradingModuleEnabled
                ? "qb-btn-ghost qb-btn--compact"
                : "qb-btn-primary-brand"
            }
            disabled={runtimeBusy}
            onClick={() =>
              void (tradingModuleEnabled
                ? closeTradingModule()
                : startTradingModule())
            }
          >
            {tradingModuleEnabled ? "关闭模块" : "启动模块"}
          </button>
        </div>
      </header>
      <nav className="qb-trade-nav" aria-label="交易工作面">
        {(
          [
            ["overview", "概览"],
            ["quant", "量化策略"],
            ["agent", "Agent 交易"],
            ["manual", "手动交易"],
            ["risk", "委托与风控"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            data-active={surface === id ? "true" : "false"}
            disabled={!tradingModuleEnabled}
            onClick={() => setSurface(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {!tradingModuleEnabled ? (
        <section className="qb-trade-module-paused" aria-label="交易模块已关闭">
          <p>TRADING MODULE PAUSED</p>
          <h2>交易模块已关闭</h2>
          <span>
            所有交易入口与 Agent
            轮询已暂停；运行中的策略已在关闭时停止。启动模块后可继续查看策略、委托与风控。
          </span>
          <button
            type="button"
            className="qb-btn-primary-brand"
            onClick={() => void startTradingModule()}
          >
            启动交易模块
          </button>
        </section>
      ) : (
        <>
          {surface === "quant" ? (
            <QuantStrategyWorkbench
              scripts={scripts}
              runtimes={runtimes}
              runtimeBusy={runtimeBusy}
              runtimeMsg={runtimeMsg}
              strategyMode={strategyMode}
              setStrategyMode={setStrategyMode}
              brokerAccounts={brokerAccounts}
              brokerAccountId={strategyBrokerAccountId}
              setBrokerAccountId={setStrategyBrokerAccountId}
              onStart={(scriptId, paperCapital, orderQty) =>
                void startSelectedStrategyRuntime(
                  scriptId,
                  paperCapital,
                  orderQty,
                )
              }
              onStop={(runtimeId) => void stopRuntimeById(runtimeId)}
              onEvaluatePaper={(runtimeId) => void evaluatePaperById(runtimeId)}
              onApproveLive={(runtimeId) => void approveLiveById(runtimeId)}
            />
          ) : null}
          {surface === "risk" ? (
            <details
              open
              className="qb-a3d-tilt qb-risk-workbench"
              style={styles.details}
              data-qb-trader-bar
            >
              <summary
                style={styles.summary}
                className="qb-risk-workbench__header"
              >
                <span>
                  <small>ORDER &amp; RISK CONTROL</small>
                  <strong>委托与风控</strong>
                  <em>先看执行状态，再进入对账、修复与组合约束。</em>
                </span>
                <span
                  className="qb-risk-workbench__metrics"
                  aria-label="风控摘要"
                >
                  <b>待处理 {riskSummary.active}</b>
                  <b data-status="success">已成交 {riskSummary.filled}</b>
                  <b
                    data-status={riskSummary.blocked > 0 ? "error" : "neutral"}
                  >
                    已拦截 {riskSummary.blocked}
                  </b>
                </span>
              </summary>
              <div
                style={{ ...styles.configBody, maxWidth: "none" }}
                className="qb-risk-workbench__grid"
              >
                {surface === "risk" ? (
                  <section
                    style={styles.scriptList}
                    className="qb-risk-module qb-risk-module--orders"
                    aria-label="近期委托与风控"
                  >
                    <div
                      style={{
                        ...styles.scriptRow,
                        justifyContent: "space-between",
                      }}
                    >
                      <strong style={{ color: "var(--qb-body-fg, #e4e4e7)" }}>
                        近期委托与风控
                      </strong>
                      <button
                        type="button"
                        className="qb-btn-ghost qb-btn--compact"
                        onClick={() => void refreshExecutionIntents()}
                      >
                        刷新委托
                      </button>
                    </div>
                    {intentsError ? (
                      <span style={{ ...styles.hint, color: "#ef4444" }}>
                        {intentsError}
                      </span>
                    ) : null}
                    {executionIntents.length === 0 && !intentsError ? (
                      <span style={styles.hint}>
                        暂无委托；这里展示执行引擎中的权威订单生命周期。
                      </span>
                    ) : null}
                    {executionIntents.map((intent) => (
                      <div
                        key={intent.id}
                        className="qb-risk-intent"
                        data-status={
                          intent.lifecycleStatus.includes("blocked") ||
                          intent.lifecycleStatus.includes("rejected")
                            ? "blocked"
                            : intent.lifecycleStatus === "filled"
                              ? "filled"
                              : "pending"
                        }
                      >
                        <span className="qb-risk-intent__side">
                          {intent.side === "buy" ? "BUY" : "SELL"}
                        </span>
                        <span className="qb-risk-intent__main">
                          <strong>
                            {intent.symbol ?? "—"} · {intent.qty} 股
                          </strong>
                          <small>
                            {intent.orderType} ·{" "}
                            {intent.timeInForce.toUpperCase()}
                            {intent.price != null
                              ? ` · ${intent.price}`
                              : " · 市价"}
                          </small>
                        </span>
                        <span className="qb-risk-intent__state">
                          <strong>{intent.lifecycleStatus}</strong>
                          <small>
                            {new Date(
                              intent.lifecycleUpdatedAt,
                            ).toLocaleTimeString()}
                          </small>
                          {!/(filled|blocked|rejected|cancelled|failed)/i.test(
                            intent.lifecycleStatus,
                          ) ? (
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              disabled={engine.busy}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `确认撤销 ${intent.symbol ?? "该标的"} 的委托？`,
                                  )
                                ) {
                                  return;
                                }
                                void engine
                                  .cancelOrder(intent.id)
                                  .then(() => refreshExecutionIntents());
                              }}
                            >
                              撤单
                            </button>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </section>
                ) : null}
                <div style={styles.row}>
                  <label style={styles.lab}>
                    触发方式
                    <select
                      style={styles.select}
                      value={traderAgentConfig.triggerMode}
                      onChange={(e) =>
                        setTraderAgentConfig({
                          triggerMode: e.target.value as
                            "manual" | "interval" | "strategy_signal",
                        })
                      }
                    >
                      <option value="manual">
                        手动（快捷交易 + 用户指令）
                      </option>
                      <option value="interval">
                        定时轮询（资讯 + 策略日志 + K 线刷新）
                      </option>
                      <option value="strategy_signal">
                        策略信号（后台运行时自动下单）
                      </option>
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
                          setTraderAgentConfig({
                            intervalSec: Number(e.target.value) || 60,
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className="qb-btn-ghost"
                    onClick={() => requestChartReload()}
                  >
                    刷新 K 线数据
                  </button>
                  <button
                    type="button"
                    className="qb-btn-ghost"
                    onClick={ingestChartToAgent}
                  >
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
                        setReconcileProvider(
                          event.target.value as BrokerProvider,
                        )
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
                        color:
                          reconcileReport.summary.mismatched > 0
                            ? "#f59e0b"
                            : "#22c55e",
                      }}
                    >
                      匹配 {reconcileReport.summary.matched}/
                      {reconcileReport.summary.symbols} · 偏差标的
                      {reconcileReport.summary.mismatched} · 名义偏差{" "}
                      {reconcileReport.summary.absoluteNotionalDelta.toFixed(2)}
                    </span>
                  ) : null}
                  {reconcileError ? (
                    <span
                      style={{
                        ...styles.hint,
                        color: reconcileError.startsWith("已提交")
                          ? "#22c55e"
                          : "#ef4444",
                      }}
                    >
                      {reconcileError}
                    </span>
                  ) : null}
                </div>
                {remediationPlan?.actions.length ? (
                  <div style={styles.scriptList}>
                    <strong style={{ fontSize: 12, color: "#f59e0b" }}>
                      修复提案 · 仅显式确认后提交 ·{" "}
                      {remediationPlan.actions.length} 笔
                    </strong>
                    {remediationPlan.actions.map((action) => (
                      <div
                        key={action.symbol}
                        style={{
                          ...styles.scriptRow,
                          justifyContent: "space-between",
                        }}
                      >
                        <span>
                          {action.action === "buy" ? "买入" : "卖出"}{" "}
                          {action.symbol} · {action.quantity}
                        </span>
                        <span style={styles.hint}>
                          估算名义 {action.estimatedNotional.toFixed(2)}
                        </span>
                      </div>
                    ))}
                    <div style={styles.row}>
                      <label style={styles.lab}>
                        修复执行上下文（Live Runtime）
                        <select
                          style={styles.select}
                          value={remediationRuntimeId}
                          onChange={(event) =>
                            setRemediationRuntimeId(event.target.value)
                          }
                        >
                          <option value="">请选择已审批的 Live Runtime</option>
                          {runtimes
                            .filter(
                              (runtime) =>
                                runtime.executionMode === "live" &&
                                runtime.brokerAccountId,
                            )
                            .map((runtime) => (
                              <option key={runtime.id} value={runtime.id}>
                                {runtime.symbol} · {runtime.status} ·{" "}
                                {runtime.id.slice(0, 8)}
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
                    {!runtimes.some(
                      (runtime) =>
                        runtime.executionMode === "live" &&
                        runtime.brokerAccountId,
                    ) ? (
                      <span style={{ ...styles.hint, color: "#f59e0b" }}>
                        暂无绑定券商账户的 Live Runtime；请先完成策略晋级和 Live
                        配置。
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
                      onChange={(event) =>
                        setPortfolioCapital(
                          Math.max(1, Number(event.target.value) || 1),
                        )
                      }
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
                      {portfolioPlan.rows.length} 个目标仓位 · 总暴露{" "}
                      {(portfolioPlan.exposures.grossExposure * 100).toFixed(1)}
                      % · 净暴露{" "}
                      {(portfolioPlan.exposures.netExposure * 100).toFixed(1)}%
                      · 止损风险预算
                      {(
                        portfolioPlan.exposures.estimatedLossAtStopsPct * 100
                      ).toFixed(2)}
                      %
                      {portfolioPlan.risk?.metrics
                        ? ` · VaR95 ${(portfolioPlan.risk.metrics.historicalVar95Pct * 100).toFixed(2)}% · ES95 ${(portfolioPlan.risk.metrics.expectedShortfall95Pct * 100).toFixed(2)}%`
                        : " · 历史风险数据不足"}
                    </span>
                  ) : null}
                  {portfolioError ? (
                    <span style={{ ...styles.hint, color: "#ef4444" }}>
                      {portfolioError}
                    </span>
                  ) : null}
                </div>
                {portfolioPlan ? (
                  <div style={styles.scriptList}>
                    {portfolioPlan.rows.map((row) => (
                      <div
                        key={row.symbol}
                        style={{
                          ...styles.scriptRow,
                          justifyContent: "space-between",
                        }}
                      >
                        <strong>
                          {row.symbol} · {row.side.toUpperCase()}
                        </strong>
                        <span style={styles.hint}>
                          目标 {(row.targetWeight * 100).toFixed(2)}% /{" "}
                          {row.targetQty.toFixed(2)} 股 · 调仓
                          {row.rebalanceQty >= 0 ? "+" : ""}
                          {row.rebalanceQty.toFixed(2)} · 风险
                          {(row.riskContributionPct * 100).toFixed(2)}%
                        </span>
                      </div>
                    ))}
                    {portfolioPlan.warnings.map((warning) => (
                      <span
                        key={warning}
                        style={{ ...styles.hint, color: "#f59e0b" }}
                      >
                        ⚠ {warning}
                      </span>
                    ))}
                    {portfolioPlan.risk?.stressTests
                      .slice(0, 2)
                      .map((stress) => (
                        <span
                          key={stress.scenario}
                          style={{
                            ...styles.hint,
                            color:
                              stress.lossAmount > 0 ? "#f59e0b" : "#22c55e",
                          }}
                        >
                          压力 {stress.scenario}：
                          {(stress.portfolioReturnPct * 100).toFixed(2)}% / 损失{" "}
                          {stress.lossAmount.toFixed(2)}
                        </span>
                      ))}
                    {portfolioPlan.risk?.warnings.map((warning) => (
                      <span
                        key={`risk-${warning}`}
                        style={{ ...styles.hint, color: "#f59e0b" }}
                      >
                        ⚠ {warning}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div>
                  <div style={{ ...styles.lab, marginBottom: 6 }}>
                    运行策略（Python 策略库 · 多选）
                  </div>
                  {scriptsErr ? (
                    <p style={{ ...styles.hint, color: "#ef4444" }}>
                      {scriptsErr}
                    </p>
                  ) : null}
                  <div style={styles.scriptList}>
                    {scripts.length === 0 ? (
                      <span
                        style={{
                          fontSize: 12,
                          color: "var(--qb-main-meta, #71717a)",
                        }}
                      >
                        暂无脚本；请先在 IDE 保存策略或写入会话策略库。
                      </span>
                    ) : (
                      scripts.map((s) => (
                        <label key={s.id} style={styles.scriptRow}>
                          <input
                            type="checkbox"
                            checked={traderAgentConfig.strategyScriptIds.includes(
                              s.id,
                            )}
                            onChange={() => toggleTraderStrategyScriptId(s.id)}
                          />
                          <span>
                            <strong
                              style={{ color: "var(--qb-body-fg, #e4e4e7)" }}
                            >
                              {s.name}
                            </strong>
                            <span
                              style={{ color: "var(--qb-main-meta, #52525b)" }}
                            >
                              {" "}
                              · {s.purpose}
                            </span>
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
                    启动
                    {strategyMode === "paper"
                      ? "纸面"
                      : strategyMode === "sim"
                        ? "券商模拟"
                        : "实盘"}
                    策略
                  </button>
                  {runtimeMsg ? (
                    <span style={styles.hint}>{runtimeMsg}</span>
                  ) : null}
                </div>
                {runtimes.length > 0 ? (
                  <div style={styles.scriptList}>
                    {runtimes.slice(0, 5).map((r) => (
                      <div
                        key={r.id}
                        style={{
                          ...styles.scriptRow,
                          justifyContent: "space-between",
                        }}
                      >
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
                            {r.executionMode === "paper" ? (
                              <button
                                type="button"
                                className="qb-btn-ghost qb-btn--compact"
                                disabled={runtimeBusy}
                                onClick={() => void approveLiveById(r.id)}
                              >
                                申请实盘晋级
                              </button>
                            ) : null}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          {surface === "quant" || surface === "risk" ? null : (
            <div className="qb-trade-surface" data-surface={surface}>
              <div className="qb-trade-main-grid" style={styles.mainRow}>
                <div
                  className="qb-trader-module qb-a3d-tilt qb-trade-flow"
                  style={styles.flowCol}
                >
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
                      同步 Agent 信息流
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
                    <button
                      type="button"
                      className="qb-btn-ghost"
                      onClick={clearTraderMarkers}
                    >
                      清空 K 线标记
                    </button>
                  </div>
                  <div style={styles.flowScroll} data-qb-trader-scroll>
                    {flowTab === "decision" ? (
                      traderAgentLog.length === 0 ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--qb-main-meta, #71717a)",
                          }}
                        >
                          暂无决策记录。成交、风控结果与用户操作将显示在此。
                        </div>
                      ) : (
                        <>
                          <div
                            className="qb-decision-rollup"
                            aria-label="决策流摘要"
                          >
                            <div>
                              <span>近期 trace</span>
                              <strong>
                                {Math.min(decisionSummary.total, 16)}
                              </strong>
                            </div>
                            <div>
                              <span>策略评估</span>
                              <strong>{decisionSummary.strategyRuns}</strong>
                            </div>
                            <div
                              data-status={
                                decisionSummary.executions > 0
                                  ? "success"
                                  : "neutral"
                              }
                            >
                              <span>已执行</span>
                              <strong>{decisionSummary.executions}</strong>
                            </div>
                          </div>
                          {decisionBatches.map((batch) => {
                            const newest = batch.rows[0]!;
                            const isExpanded = expandedDecisionBatches.has(
                              batch.id,
                            );
                            const count = batch.rows.length;
                            return (
                              <article
                                key={batch.id}
                                className="qb-decision-batch"
                                data-status={batch.status}
                                data-emphasis={batch.emphasis}
                              >
                                <button
                                  type="button"
                                  className="qb-decision-batch__summary"
                                  aria-expanded={isExpanded}
                                  onClick={() => {
                                    setExpandedDecisionBatches((current) => {
                                      const next = new Set(current);
                                      if (next.has(batch.id))
                                        next.delete(batch.id);
                                      else next.add(batch.id);
                                      return next;
                                    });
                                  }}
                                >
                                  <i aria-hidden="true" />
                                  <span className="qb-decision-batch__main">
                                    <small>
                                      {new Date(newest.ts).toLocaleString()} ·{" "}
                                      {count > 1
                                        ? `策略批次 × ${count}`
                                        : newest.kind}
                                    </small>
                                    <strong>{batch.operation}</strong>
                                    <em>收获：{batch.outcome}</em>
                                  </span>
                                  <span className="qb-decision-batch__toggle">
                                    {isExpanded
                                      ? "收起"
                                      : count > 1
                                        ? `查看 ${count} 条`
                                        : "详情"}
                                  </span>
                                </button>
                                {isExpanded ? (
                                  <div className="qb-decision-batch__events">
                                    {batch.rows.map((row) => (
                                      <div key={row.id}>
                                        <small>
                                          {new Date(
                                            row.ts,
                                          ).toLocaleTimeString()}
                                        </small>
                                        <strong>{row.title}</strong>
                                        <pre>{row.body}</pre>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </>
                      )
                    ) : null}
                    {flowTab === "drivers" ? (
                      traderDrivers.length === 0 ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--qb-main-meta, #71717a)",
                          }}
                        >
                          暂无策略驱动。来源包括：策略运行时评估、定时任务、资讯
                          RSS、外部通信、告警与用户指令。
                        </div>
                      ) : (
                        [...traderDrivers].reverse().map((row) => (
                          <div
                            key={row.id}
                            style={styles.logCard}
                            data-qb-trader-card
                          >
                            <div style={styles.logMeta}>
                              {new Date(row.ts).toLocaleString()}
                              <span style={styles.driverKind}>
                                {row.driverKind}
                              </span>
                            </div>
                            <div style={styles.logTitle}>{row.title}</div>
                            <div style={styles.logBody}>{row.body}</div>
                          </div>
                        ))
                      )
                    ) : null}
                    {flowTab === "messages" ? (
                      traderAgentMessages.length === 0 ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--qb-main-meta, #71717a)",
                          }}
                        >
                          暂无 A2A 消息。工作流内 Agent 间 TASK_ASSIGN /
                          ORDER_INTENT / RISK_BLOCK 等将显示在此。
                        </div>
                      ) : (
                        [...traderAgentMessages].reverse().map((row) => (
                          <div
                            key={row.id}
                            style={styles.logCard}
                            data-qb-trader-card
                          >
                            <div style={styles.logMeta}>
                              {new Date(row.ts).toLocaleString()}
                              <span style={styles.msgType}>
                                {row.messageType}
                              </span>
                            </div>
                            <div style={styles.logTitle}>
                              {row.senderRole} → {row.receiverRole ?? "—"}
                            </div>
                            <div style={styles.logBody}>{row.summary}</div>
                            <div
                              style={{
                                ...styles.logBody,
                                marginTop: 4,
                                fontSize: 11,
                                opacity: 0.85,
                              }}
                            >
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
                      disabled={
                        engine.busy || !engine.session || !userCmd.trim()
                      }
                      onClick={() => void submitUserCmd()}
                    >
                      执行
                    </button>
                  </div>
                </div>

                <div
                  className="qb-trader-module qb-a3d-tilt qb-trade-execution"
                  style={styles.rightCol}
                >
                  <div style={styles.klineSlot}>
                    <div style={styles.klineToolbar} data-qb-trader-bar>
                      <label style={styles.lab}>
                        代码
                        <input
                          style={styles.field}
                          value={chartSpec.symbol}
                          onChange={(e) =>
                            setChartSpec({ symbol: e.target.value })
                          }
                          placeholder="600000"
                        />
                      </label>
                      <div style={styles.lab}>
                        <span>市场</span>
                        <ChartMarketSelect
                          style={styles.field}
                          value={chartSpec.exchange}
                          onChange={(exchange) => setChartSpec({ exchange })}
                        />
                      </div>
                      <label style={styles.lab}>
                        周期
                        <select
                          style={styles.field}
                          value={chartSpec.timeframe}
                          onChange={(e) =>
                            setChartSpec({ timeframe: e.target.value })
                          }
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
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <KlinePanel embedded linkTraderMarkers />
                    </div>
                  </div>
                  <div style={styles.tradeSlot}>
                    <IdeQuickTradePanel
                      variant="trader"
                      traderLinked
                      traderBusy={engine.busy}
                      executionMode={executionMode}
                      lastOrderIntentId={lastOrderIntentId}
                      onPlaceOrder={async (side, qty, orderKind, price) => {
                        const data = await engine.placeOrder({
                          side,
                          qty,
                          orderType: orderKind,
                          price,
                          executionMode,
                        });
                        if (data?.orderIntentId)
                          setLastOrderIntentId(data.orderIntentId);
                        void refreshExecutionIntents();
                      }}
                      onPlaceBracket={async (
                        side,
                        qty,
                        orderKind,
                        takeProfitPrice,
                        stopLossPrice,
                        entryLimitPrice,
                      ) => {
                        const data = await engine.placeBracketOrder({
                          side,
                          qty,
                          entryOrderType: orderKind,
                          takeProfitPrice,
                          stopLossPrice,
                          ...(entryLimitPrice !== undefined
                            ? { entryLimitPrice }
                            : {}),
                          executionMode,
                        });
                        setLastOrderIntentId(data.entry.orderIntentId);
                        void refreshExecutionIntents();
                      }}
                      onCancelLast={
                        lastOrderIntentId
                          ? async () => {
                              await engine.cancelOrder(lastOrderIntentId);
                              setLastOrderIntentId(null);
                              void refreshExecutionIntents();
                            }
                          : undefined
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
