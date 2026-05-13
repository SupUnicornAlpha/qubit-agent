import { create } from "zustand";
import type {
  AgentSummary,
  AgentsConfigResponse,
  ChatMessage,
  ChatSession,
  StepStreamEvent,
} from "../api/types";
import { DEFAULT_CHART_SPEC } from "../lib/chartSpec";
import { DEFAULT_IDE_STRATEGY_SOURCE, DEFAULT_PYTHON_SIGNAL_STRATEGY } from "../lib/ideDefaults";

export interface ChartContextPayload {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
  summary?: string;
  fetchedAt: string;
}

export type ActiveView = "ide" | "chart" | "chat" | "team" | "trader" | "monitor" | "config";

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

export interface IdePanelsState {
  left: boolean;
  chart: boolean;
  backtest: boolean;
}

/** 配置中心左侧 / 顶部分类（与 ConfigPanel 条件渲染一致） */
export type ConfigSubPage = "llm" | "datasources" | "mcp" | "agent" | "integration" | "schedule";

export interface AppState {
  backendConnected: boolean;
  setBackendConnected: (v: boolean) => void;
  backendHint: string | null;
  setBackendHint: (v: string | null) => void;
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  chartContext: ChartContextPayload | null;
  setChartContext: (v: ChartContextPayload | null) => void;
  configSubPage: ConfigSubPage;
  setConfigSubPage: (page: ConfigSubPage) => void;
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
}

const defaultChartOverlays: ChartOverlaysState = {
  sma20: false,
  ema20: false,
  rsi14: false,
  macd: false,
  bb20: false,
};

export const useAppStore = create<AppState>((set) => ({
  backendConnected: false,
  setBackendConnected: (v) => set({ backendConnected: v }),
  backendHint: null,
  setBackendHint: (v) => set({ backendHint: v }),
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),
  chartContext: null,
  setChartContext: (chartContext) => set({ chartContext }),
  configSubPage: "llm",
  setConfigSubPage: (configSubPage) => set({ configSubPage }),
  chartReloadNonce: 0,
  requestChartReload: () => set((s) => ({ chartReloadNonce: s.chartReloadNonce + 1 })),
  chartSpec: { ...DEFAULT_CHART_SPEC },
  setChartSpec: (patch) => set((s) => ({ chartSpec: { ...s.chartSpec, ...patch } })),
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
}));
