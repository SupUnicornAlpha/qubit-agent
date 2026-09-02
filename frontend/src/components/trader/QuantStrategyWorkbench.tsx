import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { listStrategyRuntimeLogs } from "../../api/backend";
import type { StrategyRuntimeRecord } from "../../api/backend";
import type { BrokerAccountRecord, IndicatorStrategyScriptRecord } from "../../api/types";
import { CHART_TIMEFRAMES, chartControlStyle } from "../../lib/chartSpec";
import type { TraderMarkerRecord } from "../../store";
import { useAppStore } from "../../store";
import { ChartMarketSelect } from "../chart/ChartMarketSelect";
import { KlinePanel } from "../chart/KlinePanel";

type InspectorTab = "logic" | "parameters" | "activity";

type RuntimeLog = {
  id: string;
  level: string;
  message: string;
  createdAt: string;
  payloadJson?: Record<string, unknown>;
};

export type QuantStrategyWorkbenchProps = {
  scripts: IndicatorStrategyScriptRecord[];
  runtimes: StrategyRuntimeRecord[];
  runtimeBusy: boolean;
  runtimeMsg: string | null;
  tradingModuleEnabled: boolean;
  strategyMode: "paper" | "shadow" | "sim" | "live";
  setStrategyMode: (mode: "paper" | "shadow" | "sim" | "live") => void;
  brokerAccounts: BrokerAccountRecord[];
  brokerAccountId: string;
  setBrokerAccountId: (id: string) => void;
  onStart: (scriptId: string, paperCapital: number, orderQty: number) => void;
  onStop: (runtimeId: string) => void;
  onEvaluatePaper: (runtimeId: string) => void;
  onEvaluateShadow: (runtimeId: string) => void;
  onApproveLive: (runtimeId: string) => void;
};

function parseSnapshot(script: IndicatorStrategyScriptRecord): Record<string, unknown> {
  const raw = script.chartSnapshotJson;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getManifest(script: IndicatorStrategyScriptRecord): Record<string, unknown> | null {
  const manifest = parseSnapshot(script).manifest;
  return manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>)
    : null;
}

function getInstrument(
  script: IndicatorStrategyScriptRecord
): { symbol: string; market: string } | null {
  const universe = getManifest(script)?.universe as { instruments?: unknown[] } | undefined;
  const first = Array.isArray(universe?.instruments) ? universe.instruments[0] : null;
  if (!first || typeof first !== "object") return null;
  const instrument = first as Record<string, unknown>;
  const instrumentId = String(instrument.instrumentId ?? instrument.symbol ?? "").trim();
  if (!instrumentId) return null;
  const [prefix, rest] = instrumentId.split(":", 2);
  return {
    market: String(instrument.market ?? (rest ? prefix : "US")).toUpperCase(),
    symbol: (rest ?? instrumentId).toUpperCase(),
  };
}

function getHighlights(code: string): string[] {
  const useful = code
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("#") &&
        /(get_history|order_|context\.set_|context\.subscribe|buy\[|sell\[)/.test(line)
    );
  return useful.slice(0, 5);
}

function runtimeStatus(runtime: StrategyRuntimeRecord | undefined): string {
  if (!runtime) return "未部署";
  if (runtime.status === "running") return "运行中";
  if (runtime.status === "error") return "异常";
  return "已停止";
}

function markerFromLog(log: RuntimeLog): TraderMarkerRecord | null {
  const message = log.message.toLowerCase();
  if (!/(target_executed|buy_signal_executed|sell_signal_executed)/.test(message)) return null;
  const payload = log.payloadJson ?? {};
  const targetQty = Number(payload.targetQty ?? 0);
  const currentQty = Number(payload.currentQty ?? 0);
  const side = message.includes("sell") || targetQty < currentQty ? "sell" : "buy";
  return {
    id: `strategy-log-${log.id}`,
    side,
    source: "strategy",
    barTime: String(payload.barTime ?? log.createdAt),
    orderIntentId: typeof payload.orderIntentId === "string" ? payload.orderIntentId : undefined,
    text: side === "buy" ? "B · strategy signal" : "S · strategy signal",
  };
}

function compactTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString([], {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : value;
}

export const QuantStrategyWorkbench: FC<QuantStrategyWorkbenchProps> = ({
  scripts,
  runtimes,
  runtimeBusy,
  runtimeMsg,
  tradingModuleEnabled,
  strategyMode,
  setStrategyMode,
  brokerAccounts,
  brokerAccountId,
  setBrokerAccountId,
  onStart,
  onStop,
  onEvaluatePaper,
  onEvaluateShadow,
  onApproveLive,
}) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const [selectedScriptId, setSelectedScriptId] = useState<string>("");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("logic");
  const [paperCapital, setPaperCapital] = useState(100_000);
  const [orderQty, setOrderQty] = useState(100);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLog[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);

  const eligibleBrokerAccounts = useMemo(
    () =>
      brokerAccounts.filter((account) => {
        if (!account.enabled) return false;
        if (strategyMode === "live") return account.mode === "live";
        if (strategyMode === "sim") {
          return account.mode === "sandbox" || account.mode === "mock";
        }
        return true;
      }),
    [brokerAccounts, strategyMode]
  );

  const changeStrategyMode = (mode: "paper" | "shadow" | "sim" | "live") => {
    if (!tradingModuleEnabled && mode !== "shadow") return;
    setStrategyMode(mode);
    const currentAccount = brokerAccounts.find((account) => account.id === brokerAccountId);
    const accountMatchesMode =
      currentAccount?.enabled &&
      (mode === "paper" ||
        mode === "shadow" ||
        (mode === "live" && currentAccount.mode === "live") ||
        (mode === "sim" && (currentAccount.mode === "sandbox" || currentAccount.mode === "mock")));
    if (!accountMatchesMode) setBrokerAccountId("");
  };

  useEffect(() => {
    if (!selectedScriptId && scripts[0]?.id) setSelectedScriptId(scripts[0].id);
    if (selectedScriptId && !scripts.some((script) => script.id === selectedScriptId)) {
      setSelectedScriptId(scripts[0]?.id ?? "");
    }
  }, [scripts, selectedScriptId]);

  const selectedScript = scripts.find((script) => script.id === selectedScriptId) ?? scripts[0];
  const selectedRuntime = selectedScript
    ? runtimes.find((runtime) => runtime.strategyScriptId === selectedScript.id)
    : undefined;
  const signalMarkers = useMemo(
    () =>
      runtimeLogs.flatMap((log) => {
        const marker = markerFromLog(log);
        return marker ? [marker] : [];
      }),
    [runtimeLogs]
  );
  const code = selectedScript?.ideCode?.trim() || selectedScript?.signalCode?.trim() || "";
  const manifest = selectedScript ? getManifest(selectedScript) : null;
  const highlights = useMemo(() => getHighlights(code), [code]);
  const activeAccount = brokerAccounts.find((account) => account.id === brokerAccountId);

  useEffect(() => {
    if (!selectedRuntime) {
      setRuntimeLogs([]);
      setLogsError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        setLogsError(null);
        const logs = await listStrategyRuntimeLogs(selectedRuntime.id, 30);
        if (!cancelled) setRuntimeLogs(logs);
      } catch (error) {
        if (!cancelled) setLogsError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRuntime?.id]);

  const chooseScript = (script: IndicatorStrategyScriptRecord) => {
    setSelectedScriptId(script.id);
    const instrument = getInstrument(script);
    if (instrument) {
      setChartSpec({ symbol: instrument.symbol, exchange: instrument.market });
      requestChartReload();
    }
  };

  return (
    <section className="qb-strategy-workbench" aria-label="量化策略工作台">
      <header className="qb-strategy-workbench__header">
        <div>
          <p>STRATEGY DESK</p>
          <h2>量化策略工作台</h2>
          <span>把策略逻辑、已收盘 K 线信号和运行状态放在同一个执行面。</span>
        </div>
        <div className="qb-strategy-workbench__metrics" aria-label="策略指标">
          <div>
            <span>策略库</span>
            <strong>{scripts.length}</strong>
          </div>
          <div>
            <span>运行中</span>
            <strong className="is-positive">
              {runtimes.filter((r) => r.status === "running").length}
            </strong>
          </div>
          <div>
            <span>当前信号</span>
            <strong>{signalMarkers.length ? `${signalMarkers.length} B/S` : "等待"}</strong>
          </div>
          <div>
            <span>图表标的</span>
            <strong>{chartSpec.symbol || "—"}</strong>
          </div>
        </div>
      </header>

      <div className="qb-strategy-workbench__canvas">
        <aside className="qb-strategy-book">
          <div className="qb-strategy-section-title">
            <span>策略库</span>
            <small>{scripts.length} scripts</small>
          </div>
          <div className="qb-strategy-book__list">
            {scripts.length === 0 ? (
              <div className="qb-strategy-empty">
                暂无策略脚本。请先在 IDE 或研究工作流中保存策略。
              </div>
            ) : (
              scripts.map((script) => {
                const runtime = runtimes.find((row) => row.strategyScriptId === script.id);
                const isActive = script.id === selectedScript?.id;
                const instrument = getInstrument(script);
                return (
                  <button
                    key={script.id}
                    type="button"
                    className="qb-strategy-book__item"
                    data-active={isActive ? "true" : "false"}
                    onClick={() => chooseScript(script)}
                  >
                    <span className="qb-strategy-book__name">{script.name}</span>
                    <span className="qb-strategy-book__meta">
                      {instrument?.symbol ?? "MULTI"} · {script.purpose}
                    </span>
                    <span className="qb-strategy-status" data-status={runtime?.status ?? "stopped"}>
                      <i />
                      {runtimeStatus(runtime)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="qb-strategy-book__footer">
            <span>选择策略会切换到脚本主标的。</span>
            <span>脚本版本随工作流留档。</span>
          </div>
        </aside>

        <main className="qb-strategy-chart">
          <div className="qb-strategy-chart__bar">
            <div>
              <span className="qb-strategy-eyebrow">SIGNAL CHART</span>
              <strong>{chartSpec.symbol || "未选择标的"}</strong>
              <small>
                {chartSpec.exchange} · {chartSpec.timeframe} · {selectedScript?.name ?? "选择策略"}
              </small>
            </div>
            <div className="qb-strategy-chart__controls">
              <ChartMarketSelect
                style={chartControlStyle}
                value={chartSpec.exchange}
                onChange={(exchange) => setChartSpec({ exchange })}
              />
              <select
                style={chartControlStyle}
                value={chartSpec.timeframe}
                onChange={(event) => setChartSpec({ timeframe: event.target.value })}
                aria-label="K线周期"
              >
                {CHART_TIMEFRAMES.map((timeframe) => (
                  <option key={timeframe} value={timeframe}>
                    {timeframe}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="qb-btn-ghost qb-btn--compact"
                onClick={requestChartReload}
              >
                刷新
              </button>
            </div>
          </div>
          <div className="qb-strategy-chart__legend">
            <span>
              <i className="is-buy" />B 买入 / 提高目标仓位
            </span>
            <span>
              <i className="is-sell" />S 卖出 / 降低目标仓位
            </span>
            <span>
              <i className="is-strategy" />
              策略 runtime 信号
            </span>
            <small>
              {signalMarkers.length
                ? `已加载 ${signalMarkers.length} 个运行日志信号`
                : "暂无已执行的策略信号"}
            </small>
          </div>
          <div className="qb-strategy-chart__panel">
            <KlinePanel embedded linkTraderMarkers strategyMarkers={signalMarkers} />
          </div>
          <div className="qb-strategy-chart__events">
            {runtimeLogs.filter((log) => markerFromLog(log)).length === 0 ? (
              <span>策略尚未对当前 K 线产生可执行 B/S 信号。</span>
            ) : (
              runtimeLogs
                .filter((log) => markerFromLog(log))
                .slice(0, 3)
                .map((log) => {
                  const marker = markerFromLog(log)!;
                  return (
                    <span key={log.id} data-side={marker.side}>
                      {marker.side === "buy" ? "B" : "S"} · {compactTime(marker.barTime)} ·{" "}
                      {String(log.payloadJson?.reason ?? "strategy signal")}
                    </span>
                  );
                })
            )}
          </div>
        </main>

        <aside className="qb-strategy-inspector">
          <div className="qb-strategy-inspector__title">
            <div>
              <span className="qb-strategy-eyebrow">INSPECTOR</span>
              <strong>{selectedScript?.name ?? "选择策略"}</strong>
            </div>
            <span className="qb-strategy-mode-tag">
              {manifest ? "Strategy API V2" : (selectedScript?.purpose ?? "—")}
            </span>
          </div>
          <div className="qb-strategy-inspector__tabs">
            {(["logic", "parameters", "activity"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                data-active={inspectorTab === tab}
                onClick={() => setInspectorTab(tab)}
              >
                {tab === "logic" ? "表达式" : tab === "parameters" ? "参数" : "运行"}
              </button>
            ))}
          </div>
          {inspectorTab === "logic" ? (
            <div className="qb-strategy-inspector__body">
              <div className="qb-strategy-expression-summary">
                {highlights.length ? (
                  highlights.map((line) => <code key={line}>{line}</code>)
                ) : (
                  <span>未识别到可展示的表达式。</span>
                )}
              </div>
              <pre className="qb-strategy-code">{code || "# 暂无策略源码"}</pre>
            </div>
          ) : null}
          {inspectorTab === "parameters" ? (
            <div className="qb-strategy-inspector__body qb-strategy-parameters">
              <div>
                <span>状态</span>
                <strong data-status={selectedRuntime?.status ?? "stopped"}>
                  {runtimeStatus(selectedRuntime)}
                </strong>
              </div>
              <div>
                <span>运行模式</span>
                <strong>{selectedRuntime?.executionMode ?? strategyMode}</strong>
              </div>
              <div>
                <span>标的 / 周期</span>
                <strong>
                  {selectedRuntime
                    ? `${selectedRuntime.symbol} · ${selectedRuntime.timeframe}`
                    : "尚未部署"}
                </strong>
              </div>
              <div>
                <span>最后处理 Bar</span>
                <strong>{compactTime(selectedRuntime?.lastBarTime)}</strong>
              </div>
              <div>
                <span>脚本参数</span>
                <strong>{manifest ? "见 Strategy API Manifest" : "Indicator / Script"}</strong>
              </div>
            </div>
          ) : null}
          {inspectorTab === "activity" ? (
            <div className="qb-strategy-inspector__body qb-strategy-activity">
              {logsError ? <span className="is-error">{logsError}</span> : null}
              {runtimeLogs.length === 0 && !logsError ? <span>暂无运行日志。</span> : null}
              {runtimeLogs.slice(0, 7).map((log) => (
                <div key={log.id}>
                  <i data-level={log.level} /> <strong>{log.message}</strong>
                  <small>{compactTime(log.createdAt)}</small>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>

      <footer className="qb-strategy-deploy">
        <div className="qb-strategy-deploy__context">
          <div>
            <span>部署策略</span>
            <strong>{selectedScript?.name ?? "请先选择策略"}</strong>
          </div>
          <label>
            环境
            <select
              value={strategyMode}
              onChange={(event) =>
                changeStrategyMode(event.target.value as "paper" | "shadow" | "sim" | "live")
              }
            >
              <option disabled={!tradingModuleEnabled} value="paper">
                纸面
              </option>
              <option value="shadow">影子观测（零下单）</option>
              <option disabled={!tradingModuleEnabled} value="sim">
                券商模拟
              </option>
              <option disabled={!tradingModuleEnabled} value="live">
                实盘
              </option>
            </select>
          </label>
          <label>
            账户
            <select
              value={brokerAccountId}
              onChange={(event) => setBrokerAccountId(event.target.value)}
            >
              <option value="">自动选择</option>
              {eligibleBrokerAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.provider} · {account.accountRef} · {account.mode}
                </option>
              ))}
            </select>
          </label>
          <label>
            纸本金
            <input
              min={1}
              type="number"
              value={paperCapital}
              onChange={(event) => setPaperCapital(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
          <label>
            单笔股数
            <input
              min={1}
              type="number"
              value={orderQty}
              onChange={(event) => setOrderQty(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
        </div>
        <div className="qb-strategy-deploy__actions">
          {selectedRuntime?.status === "running" ? (
            <button
              type="button"
              className="qb-btn-ghost"
              disabled={runtimeBusy}
              onClick={() => onStop(selectedRuntime.id)}
            >
              停止 runtime
            </button>
          ) : (
            <button
              type="button"
              className="qb-btn-primary-brand"
              disabled={
                runtimeBusy ||
                !selectedScript ||
                (!tradingModuleEnabled && strategyMode !== "shadow")
              }
              onClick={() => selectedScript && onStart(selectedScript.id, paperCapital, orderQty)}
            >
              {strategyMode === "sim"
                ? "部署到模拟盘"
                : strategyMode === "live"
                  ? "提交实盘部署"
                  : strategyMode === "shadow"
                    ? "启动影子观测"
                    : "启动纸面策略"}
            </button>
          )}
          {selectedRuntime?.executionMode === "paper" && selectedRuntime.status !== "running" ? (
            <button
              type="button"
              className="qb-btn-ghost"
              disabled={runtimeBusy}
              onClick={() => onEvaluatePaper(selectedRuntime.id)}
            >
              评估 Paper
            </button>
          ) : null}
          {selectedRuntime?.executionMode === "shadow" && selectedRuntime.status !== "running" ? (
            <button
              type="button"
              className="qb-btn-ghost"
              disabled={runtimeBusy}
              onClick={() => onEvaluateShadow(selectedRuntime.id)}
            >
              审计 Shadow 观测
            </button>
          ) : null}
          {selectedRuntime?.executionMode === "paper" && selectedRuntime.status !== "running" ? (
            <button
              type="button"
              className="qb-btn-ghost"
              disabled={runtimeBusy}
              onClick={() => onApproveLive(selectedRuntime.id)}
            >
              申请晋级
            </button>
          ) : null}
        </div>
        <div className="qb-strategy-deploy__note">
          {runtimeMsg ??
            (strategyMode === "sim"
              ? `模拟账户：${activeAccount ? `${activeAccount.provider} · ${activeAccount.accountRef}` : "自动解析 sandbox / mock"}`
              : strategyMode === "shadow"
                ? "影子模式只记录已确认 K 线上的信号与目标仓位；不创建订单、执行任务或券商请求，也不构成策略晋级证据。"
                : "策略信号仅在已收盘 K 线确认后入场。")}
        </div>
      </footer>
    </section>
  );
};
