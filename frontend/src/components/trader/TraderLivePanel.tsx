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
import { CHART_MARKET_OPTIONS, CHART_TIMEFRAMES, coerceChartMarketExchange } from "../../lib/chartSpec";
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
    background: "var(--qb-bg-root, #09090b)",
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
  const clearTraderMarkers = useAppStore((s) => s.clearTraderMarkers);
  const pushTraderMarker = useAppStore((s) => s.pushTraderMarker);
  const traderAgentConfig = useAppStore((s) => s.traderAgentConfig);
  const setTraderAgentConfig = useAppStore((s) => s.setTraderAgentConfig);
  const toggleTraderStrategyScriptId = useAppStore((s) => s.toggleTraderStrategyScriptId);

  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [runtimes, setRuntimes] = useState<StrategyRuntimeRecord[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null);
  const [scriptsErr, setScriptsErr] = useState<string | null>(null);
  const booted = useRef(false);

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
        const rows = await listStrategyScripts(session.id);
        setScripts(rows);
        const rt = await listStrategyRuntimes({ sessionId: session.id });
        setRuntimes(rt);
        pushTraderAgentLog({
          kind: "ingest",
          title: "会话与策略库已连接",
          body: `sessionId=${session.id}\n已加载 ${rows.length} 条策略脚本（IDE 生成或手写 Python 入库后可在此勾选）。`,
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

  const simulateAgentTick = () => {
    const spec = useAppStore.getState().chartSpec;
    const cfg = useAppStore.getState().traderAgentConfig;
    const names = cfg.strategyScriptIds
      .map((id) => scripts.find((s) => s.id === id)?.name)
      .filter(Boolean)
      .join(", ");
    pushTraderAgentLog({
      kind: "ingest",
      title: "观测输入",
      body: `标的 ${spec.symbol}；启用策略: ${names || "（未勾选，使用内置占位推理）"}`,
    });
    pushTraderAgentLog({
      kind: "decision",
      title: "决策（演示）",
      body:
        cfg.triggerMode === "interval"
          ? `触发模式=定时轮询（${cfg.intervalSec}s）；生成试探信号并等待风控闸（演示未调用后端）。`
          : cfg.triggerMode === "strategy_signal"
            ? "触发模式=策略信号（占位）：将监听所选 Python 策略输出 buy/sell 事件。"
            : "触发模式=手动：以下标记来自演示按钮或快捷交易面板联动。",
    });
    const side = Math.random() > 0.45 ? "buy" : "sell";
    pushTraderMarker({
      side,
      text: side === "buy" ? "Agent 试探做多" : "Agent 试探做空",
      source: "agent",
    });
    pushTraderAgentLog({
      kind: "decision",
      title: "执行意图（演示）",
      body: `已在 K 线末根叠加 ${side === "buy" ? "绿色↑" : "红色↓"} 标记；与下方快捷交易共用同一 chartSpec。`,
    });
  };

  return (
    <div style={styles.root}>
      <details style={styles.details}>
        <summary style={styles.summary}>交易 Agent 配置</summary>
        <div style={styles.configBody}>
          <p style={styles.hint}>
            触发方式与策略选择在会话内持久化（sessionStorage）。K 线与快捷交易共用全局{" "}
            <code style={{ fontSize: 11 }}>chartSpec</code>，修改任一侧品种/周期会联动另一侧。
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
                <option value="manual">手动（快捷交易 + 演示按钮）</option>
                <option value="interval">定时轮询 Agent（占位）</option>
                <option value="strategy_signal">策略信号触发（Python 输出，占位）</option>
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
          <div style={styles.flowHead}>Agent 对话与决策流</div>
          <div style={styles.flowActions}>
            <button type="button" className="qb-btn-primary-brand" onClick={simulateAgentTick}>
              模拟 Agent 一轮（演示）
            </button>
            <button type="button" className="qb-btn-ghost" onClick={clearTraderAgentLog}>
              清空日志
            </button>
            <button type="button" className="qb-btn-ghost" onClick={clearTraderMarkers}>
              清空 K 线标记
            </button>
          </div>
          <div style={styles.flowScroll}>
            {traderAgentLog.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--qb-main-meta, #71717a)" }}>暂无事件。点击「模拟 Agent」或在下方面板做演示标记以查看联动。</div>
            ) : (
              [...traderAgentLog].reverse().map((row) => (
                <div key={row.id} style={styles.logCard}>
                  <div style={styles.logMeta}>
                    {new Date(row.ts).toLocaleString()} · {row.kind}
                  </div>
                  <div style={styles.logTitle}>{row.title}</div>
                  <div style={styles.logBody}>{row.body}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={styles.rightCol}>
          <div style={styles.klineSlot}>
            <div style={styles.klineToolbar}>
              <label style={styles.lab}>
                代码
                <input
                  style={styles.inp}
                  value={chartSpec.symbol}
                  onChange={(e) => setChartSpec({ symbol: e.target.value })}
                  placeholder="600000"
                />
              </label>
              <label style={styles.lab}>
                市场
                <select
                  style={styles.select}
                  value={coerceChartMarketExchange(chartSpec.exchange)}
                  onChange={(e) => setChartSpec({ exchange: e.target.value })}
                >
                  {CHART_MARKET_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={styles.lab}>
                周期
                <select
                  style={styles.select}
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
            <IdeQuickTradePanel variant="trader" traderLinked />
          </div>
        </div>
      </div>
    </div>
  );
};
