import type { CSSProperties, FC } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createProject,
  createStrategyRuntime,
  createWorkspace,
  getDefaultProjectSession,
  listProjects,
  listStrategyRuntimes,
  listStrategyScripts,
  listWorkspaces,
  stopStrategyRuntime,
} from "../../api/backend";
import type { StrategyRuntimeRecord } from "../../api/backend";
import type { IndicatorStrategyScriptRecord } from "../../api/types";
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
  lab: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
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
  const [flowTab, setFlowTab] = useState<"decision" | "drivers" | "messages">("decision");
  const booted = useRef(false);

  const engine = useTraderAgentEngine(projectId, sessionId);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void (async () => {
      try {
        const workspaces = await listWorkspaces();
        let wsId = workspaces[0]?.id;
        if (!wsId) {
          const created = await createWorkspace({ name: "QUBIT Default Workspace", owner: "local-user" });
          wsId = created.data.id;
        }
        const projects = await listProjects(wsId);
        let pid = projects[0]?.id;
        if (!pid) {
          const created = await createProject({
            workspaceId: wsId,
            name: "QUBIT Default Project",
            marketScope: "CN-A",
          });
          pid = created.data.id;
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
      <details style={styles.details} data-qb-trader-bar>
        <summary style={styles.summary}>交易 Agent 配置</summary>
        <div style={styles.configBody}>
          <p style={styles.hint}>
            触发方式持久化于 sessionStorage。策略信号由后台 worker 评估并下单；定时/资讯由 Agent 轮询 feed
            写入左侧流；用户可在下方输入「买入 100」「撤单 &lt;intentId&gt;」等指令。
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
                  onChange={(e) => setTraderAgentConfig({ intervalSec: Number(e.target.value) || 60 })}
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
          <div>
            <div style={{ ...styles.lab, marginBottom: 6 }}>运行策略（Python 策略库 · 多选）</div>
            {scriptsErr ? <p style={{ ...styles.hint, color: "#ef4444" }}>{scriptsErr}</p> : null}
            <div style={styles.scriptList}>
              {scripts.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>暂无脚本；请先在 IDE 保存策略或写入会话策略库。</span>
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
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>

      <div style={styles.mainRow}>
        <div style={styles.flowCol}>
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
                  暂无策略驱动。来源包括：策略运行时评估、定时任务、资讯 RSS、外部通信、告警与用户指令。
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
                  暂无 A2A 消息。工作流内 Agent 间 TASK_ASSIGN / ORDER_INTENT / RISK_BLOCK 等将显示在此。
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

        <div style={styles.rightCol}>
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
              <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={() => requestChartReload()}>
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
