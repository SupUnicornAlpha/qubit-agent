import { create } from "zustand";
import type {
  AgentSummary,
  AgentsConfigResponse,
  ChatMessage,
  ChatSession,
  StepStreamEvent,
} from "../api/types";
import { coerceChartMarketExchange, persistChartSpec, readPersistedChartSpec } from "../lib/chartSpec";
import { DEFAULT_IDE_STRATEGY_SOURCE, DEFAULT_PYTHON_SIGNAL_STRATEGY } from "../lib/ideDefaults";

export interface ChartContextPayload {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
  summary?: string;
  fetchedAt: string;
}

export type ActiveView =
  | "ide"
  | "chart"
  | "chat"
  | "team"
  | "trader"
  | "quant"
  | "monitor"
  | "broker"
  | "config";

/** 量化工作台 tab */
export type QuantTab = "factor" | "discovery" | "backtest";

import {
  applyUiAppearance,
  coercePaletteForStyle,
  persistUiAppearance,
  readUiAppearance,
  type UiAppearance,
  type UiPaletteId,
  type UiStyleId,
  UI_PALETTE_IDS,
  UI_STYLE_IDS,
  type UiThemeId,
} from "../theme/appearance";

export { UI_PALETTE_IDS, UI_STYLE_IDS, type UiPaletteId, type UiStyleId, type UiThemeId };
export const UI_THEME_IDS = UI_PALETTE_IDS;

export type ChartOverlayKey = "sma20" | "ema20" | "rsi14" | "macd" | "bb20";

export interface ChartSpecState {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
}

export interface ChartOverlaysState {
  sma20: boolean;
  ema20: boolean;
  rsi14: boolean;
  macd: boolean;
  bb20: boolean;
}

export interface TraderMarkerRecord {
  id: string;
  side: "buy" | "sell";
  text: string;
  source: "agent" | "manual" | "strategy";
  /** ISO 时间或 K 线 bar 时间，用于在图上定位 */
  barTime?: string;
  orderIntentId?: string;
}

export interface TraderAgentLogRecord {
  id: string;
  ts: number;
  kind: "info" | "decision" | "ingest" | "user" | "strategy";
  title: string;
  body: string;
}

/** 驱动作业输入（策略 / 定时 / 资讯 / 通信 / 告警等） */
export interface TraderDriverRecord {
  id: string;
  ts: number;
  driverKind: string;
  title: string;
  body: string;
}

/** Agent 总线 A2A 消息 */
export interface TraderAgentMessageRecord {
  id: string;
  ts: number;
  messageType: string;
  senderRole: string;
  receiverRole: string | null;
  workflowRunId: string;
  summary: string;
  body: string;
}

export type TraderTriggerMode = "manual" | "interval" | "strategy_signal";

export interface TraderAgentConfigState {
  triggerMode: TraderTriggerMode;
  intervalSec: number;
  /** 选中的策略脚本 id（来自会话 strategy-scripts） */
  strategyScriptIds: string[];
}

export interface IdePanelsState {
  left: boolean;
  chart: boolean;
  backtest: boolean;
}


/** 配置中心左侧 / 顶部分类（与 ConfigPanel 条件渲染一致） */
export type ConfigSubPage =
  | "llm"
  | "datasources"
  | "mcp"
  | "skills"
  | "agent"
  | "integration"
  | "schedule"
  | "providers";

export interface AppState {
  backendConnected: boolean;
  setBackendConnected: (v: boolean) => void;
  backendHint: string | null;
  setBackendHint: (v: string | null) => void;
  /** 默认风格下的配色（`html[data-qb-theme]`） */
  uiPalette: UiPaletteId;
  setUiPalette: (palette: UiPaletteId) => void;
  /** 视觉风格（`html[data-qb-style]`，与配色正交） */
  uiStyle: UiStyleId;
  setUiStyle: (style: UiStyleId) => void;
  /** @deprecated 使用 uiPalette */
  uiTheme: UiPaletteId;
  /** @deprecated 使用 setUiPalette */
  setUiTheme: (palette: UiPaletteId) => void;
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  /** 侧栏 Explorer 面板（导航树）是否展开 */
  explorerOpen: boolean;
  setExplorerOpen: (open: boolean) => void;
  toggleExplorerOpen: () => void;
  chartContext: ChartContextPayload | null;
  setChartContext: (v: ChartContextPayload | null) => void;
  configSubPage: ConfigSubPage;
  setConfigSubPage: (page: ConfigSubPage) => void;
  quantTab: QuantTab;
  setQuantTab: (tab: QuantTab) => void;
  /** 图表请求版本号，供 IDE 内嵌 K 线监听刷新 */
  chartReloadNonce: number;
  requestChartReload: () => void;
  chartSpec: ChartSpecState;
  setChartSpec: (patch: Partial<ChartSpecState>) => void;
  chartOverlays: ChartOverlaysState;
  toggleChartOverlay: (key: ChartOverlayKey) => void;
  idePanels: IdePanelsState;
  toggleIdePanelVisible: (key: keyof IdePanelsState) => void;
  ideIndicatorLabel: string;
  setIdeIndicatorLabel: (v: string) => void;
  ideQuickTradeOpen: boolean;
  setIdeQuickTradeOpen: (v: boolean) => void;
  ideStrategySource: string;
  setIdeStrategySource: (v: string) => void;
  /** 与底部坞「代码策略」共用：Python 输出 buy/sell 供 /market/backtests/python */
  ideSignalPythonCode: string;
  setIdeSignalPythonCode: (v: string) => void;
  /** 当前已保存到 DB 的策略稿 id；null 表示仅本地草稿 */
  ideActiveStrategyScriptId: string | null;
  setIdeActiveStrategyScriptId: (v: string | null) => void;
  ideAiPrompt: string;
  setIdeAiPrompt: (v: string) => void;
  ideLeftTab: "chat" | "indicator";
  setIdeLeftTab: (v: "chat" | "indicator") => void;
  chatDraftPrefill: string | null;
  setChatDraftPrefill: (v: string | null) => void;
  agents: AgentSummary[];
  setAgents: (agents: AgentSummary[]) => void;
  streamEvents: StepStreamEvent[];
  pushStreamEvent: (event: StepStreamEvent) => void;
  clearStreamEvents: () => void;
  configData: AgentsConfigResponse | null;
  setConfigData: (v: AgentsConfigResponse | null) => void;
  reloadSummary: { before: number; after: number } | null;
  setReloadSummary: (v: { before: number; after: number } | null) => void;
  chatSessions: ChatSession[];
  setChatSessions: (sessions: ChatSession[]) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  chatMessages: ChatMessage[];
  setChatMessages: (messages: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  /** 实时交易页：K 线标记（与快捷交易 / Agent 演示联动） */
  traderMarkers: TraderMarkerRecord[];
  pushTraderMarker: (m: Omit<TraderMarkerRecord, "id"> & { id?: string }) => void;
  clearTraderMarkers: () => void;
  /** 实时交易页：Agent 决策与信息流 */
  traderAgentLog: TraderAgentLogRecord[];
  pushTraderAgentLog: (e: Omit<TraderAgentLogRecord, "id" | "ts"> & { id?: string; ts?: number }) => void;
  clearTraderAgentLog: () => void;
  traderDrivers: TraderDriverRecord[];
  pushTraderDriver: (e: Omit<TraderDriverRecord, "id" | "ts"> & { id?: string; ts?: number }) => void;
  clearTraderDrivers: () => void;
  traderAgentMessages: TraderAgentMessageRecord[];
  pushTraderAgentMessage: (e: Omit<TraderAgentMessageRecord, "id" | "ts"> & { id?: string; ts?: number }) => void;
  clearTraderAgentMessages: () => void;
  traderAgentConfig: TraderAgentConfigState;
  setTraderAgentConfig: (patch: Partial<TraderAgentConfigState>) => void;
  toggleTraderStrategyScriptId: (id: string) => void;
}

const defaultChartOverlays: ChartOverlaysState = {
  sma20: false,
  ema20: false,
  rsi14: false,
  macd: false,
  bb20: false,
};

const TRADER_CFG_KEY = "qubit-trader-agent-config-v1";
const EXPLORER_OPEN_LS = "qubit:explorerOpen";

function readExplorerOpen(): boolean {
  try {
    return localStorage.getItem(EXPLORER_OPEN_LS) !== "0";
  } catch {
    return true;
  }
}

function persistExplorerOpen(open: boolean) {
  try {
    localStorage.setItem(EXPLORER_OPEN_LS, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function loadTraderConfig(): TraderAgentConfigState {
  try {
    const raw = sessionStorage.getItem(TRADER_CFG_KEY);
    if (!raw) {
      return { triggerMode: "manual", intervalSec: 60, strategyScriptIds: [] };
    }
    const j = JSON.parse(raw) as Partial<TraderAgentConfigState>;
    return {
      triggerMode:
        j.triggerMode === "interval" || j.triggerMode === "strategy_signal" || j.triggerMode === "manual"
          ? j.triggerMode
          : "manual",
      intervalSec: typeof j.intervalSec === "number" && j.intervalSec >= 10 ? j.intervalSec : 60,
      strategyScriptIds: Array.isArray(j.strategyScriptIds)
        ? j.strategyScriptIds.filter((x): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { triggerMode: "manual", intervalSec: 60, strategyScriptIds: [] };
  }
}

function persistTraderConfig(cfg: TraderAgentConfigState) {
  try {
    sessionStorage.setItem(TRADER_CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export const useAppStore = create<AppState>((set) => ({
  backendConnected: false,
  setBackendConnected: (v) => set({ backendConnected: v }),
  backendHint: null,
  setBackendHint: (v) => set({ backendHint: v }),
  ...(() => {
    const initial = readUiAppearance();
    applyUiAppearance(initial);
    return {
      uiPalette: initial.palette,
      uiStyle: initial.style,
      uiTheme: initial.palette,
    };
  })(),
  setUiPalette: (palette) => {
    const { uiStyle } = useAppStore.getState();
    const next: UiAppearance = { palette, style: uiStyle };
    persistUiAppearance(next);
    applyUiAppearance(next);
    set({ uiPalette: palette, uiTheme: palette });
  },
  setUiStyle: (style) => {
    const { uiPalette } = useAppStore.getState();
    const palette = coercePaletteForStyle(style, uiPalette);
    const next: UiAppearance = { palette, style };
    persistUiAppearance(next);
    applyUiAppearance(next);
    set({ uiStyle: style, uiPalette: palette, uiTheme: palette });
  },
  setUiTheme: (palette) => {
    useAppStore.getState().setUiPalette(palette);
  },
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),
  explorerOpen: readExplorerOpen(),
  setExplorerOpen: (explorerOpen) => {
    persistExplorerOpen(explorerOpen);
    set({ explorerOpen });
  },
  toggleExplorerOpen: () => {
    const next = !useAppStore.getState().explorerOpen;
    persistExplorerOpen(next);
    set({ explorerOpen: next });
  },
  chartContext: null,
  setChartContext: (chartContext) => set({ chartContext }),
  configSubPage: "llm",
  setConfigSubPage: (configSubPage) => set({ configSubPage }),
  quantTab: "factor",
  setQuantTab: (quantTab) => set({ quantTab }),
  chartReloadNonce: 0,
  requestChartReload: () => set((s) => ({ chartReloadNonce: s.chartReloadNonce + 1 })),
  chartSpec: readPersistedChartSpec(),
  setChartSpec: (patch) =>
    set((s) => {
      const chartSpec = { ...s.chartSpec, ...patch };
      if (patch.exchange !== undefined) {
        chartSpec.exchange = coerceChartMarketExchange(chartSpec.exchange);
      }
      persistChartSpec(chartSpec);
      return { chartSpec };
    }),
  chartOverlays: { ...defaultChartOverlays },
  toggleChartOverlay: (key) =>
    set((s) => {
      const next = { ...s.chartOverlays, [key]: !s.chartOverlays[key] };
      if (key === "rsi14" && next.rsi14) next.macd = false;
      if (key === "macd" && next.macd) next.rsi14 = false;
      return { chartOverlays: next };
    }),
  idePanels: { left: true, chart: true, backtest: true },
  toggleIdePanelVisible: (key) =>
    set((s) => ({ idePanels: { ...s.idePanels, [key]: !s.idePanels[key] } })),
  ideIndicatorLabel: "（未选指标）",
  setIdeIndicatorLabel: (v) => set({ ideIndicatorLabel: v }),
  ideQuickTradeOpen: false,
  setIdeQuickTradeOpen: (v) => set({ ideQuickTradeOpen: v }),
  ideStrategySource: DEFAULT_IDE_STRATEGY_SOURCE,
  setIdeStrategySource: (v) => set({ ideStrategySource: v }),
  ideSignalPythonCode: DEFAULT_PYTHON_SIGNAL_STRATEGY,
  setIdeSignalPythonCode: (v) => set({ ideSignalPythonCode: v }),
  ideActiveStrategyScriptId: null,
  setIdeActiveStrategyScriptId: (v) => set({ ideActiveStrategyScriptId: v }),
  ideAiPrompt: "",
  setIdeAiPrompt: (v) => set({ ideAiPrompt: v }),
  ideLeftTab: "chat",
  setIdeLeftTab: (v) => set({ ideLeftTab: v }),
  chatDraftPrefill: null,
  setChatDraftPrefill: (v) => set({ chatDraftPrefill: v }),
  agents: [],
  setAgents: (agents) => set({ agents }),
  streamEvents: [],
  pushStreamEvent: (event) => set((s) => ({ streamEvents: [...s.streamEvents, event] })),
  clearStreamEvents: () => set({ streamEvents: [] }),
  configData: null,
  setConfigData: (v) => set({ configData: v }),
  reloadSummary: null,
  setReloadSummary: (v) => set({ reloadSummary: v }),
  chatSessions: [],
  setChatSessions: (chatSessions) => set({ chatSessions }),
  selectedSessionId: null,
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  chatMessages: [],
  setChatMessages: (chatMessages) =>
    set((state) => ({
      chatMessages: typeof chatMessages === "function" ? chatMessages(state.chatMessages) : chatMessages,
    })),
  traderMarkers: [],
  pushTraderMarker: (m) =>
    set((s) => {
      const row: TraderMarkerRecord = {
        id: m.id ?? newId(),
        side: m.side,
        text: m.text,
        source: m.source,
        barTime: m.barTime,
        orderIntentId: m.orderIntentId,
      };
      return { traderMarkers: [...s.traderMarkers, row].slice(-24) };
    }),
  clearTraderMarkers: () => set({ traderMarkers: [] }),
  traderAgentLog: [],
  pushTraderAgentLog: (e) =>
    set((s) => {
      const row: TraderAgentLogRecord = {
        id: e.id ?? newId(),
        ts: e.ts ?? Date.now(),
        kind: e.kind,
        title: e.title,
        body: e.body,
      };
      return { traderAgentLog: [...s.traderAgentLog, row].slice(-200) };
    }),
  clearTraderAgentLog: () => set({ traderAgentLog: [] }),
  traderDrivers: [],
  pushTraderDriver: (e) =>
    set((s) => {
      const row: TraderDriverRecord = {
        id: e.id ?? newId(),
        ts: e.ts ?? Date.now(),
        driverKind: e.driverKind,
        title: e.title,
        body: e.body,
      };
      return { traderDrivers: [...s.traderDrivers, row].slice(-200) };
    }),
  clearTraderDrivers: () => set({ traderDrivers: [] }),
  traderAgentMessages: [],
  pushTraderAgentMessage: (e) =>
    set((s) => {
      const row: TraderAgentMessageRecord = {
        id: e.id ?? newId(),
        ts: e.ts ?? Date.now(),
        messageType: e.messageType,
        senderRole: e.senderRole,
        receiverRole: e.receiverRole ?? null,
        workflowRunId: e.workflowRunId,
        summary: e.summary,
        body: e.body,
      };
      return { traderAgentMessages: [...s.traderAgentMessages, row].slice(-200) };
    }),
  clearTraderAgentMessages: () => set({ traderAgentMessages: [] }),
  traderAgentConfig: loadTraderConfig(),
  setTraderAgentConfig: (patch) =>
    set((s) => {
      const next = { ...s.traderAgentConfig, ...patch };
      persistTraderConfig(next);
      return { traderAgentConfig: next };
    }),
  toggleTraderStrategyScriptId: (id) =>
    set((s) => {
      const cur = s.traderAgentConfig.strategyScriptIds;
      const has = cur.includes(id);
      const strategyScriptIds = has ? cur.filter((x) => x !== id) : [...cur, id];
      const next = { ...s.traderAgentConfig, strategyScriptIds };
      persistTraderConfig(next);
      return { traderAgentConfig: next };
    }),
}));
