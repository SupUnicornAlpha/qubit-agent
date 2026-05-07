import { create } from "zustand";
import type {
  AgentSummary,
  AgentsConfigResponse,
  ChatMessage,
  ChatSession,
  StepStreamEvent,
} from "../api/types";

interface AppState {
  backendConnected: boolean;
  setBackendConnected: (v: boolean) => void;
  backendHint: string | null;
  setBackendHint: (v: string | null) => void;
  activeView: "monitor" | "config" | "chat" | "team";
  setActiveView: (view: "monitor" | "config" | "chat" | "team") => void;
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

export const useAppStore = create<AppState>((set) => ({
  backendConnected: false,
  setBackendConnected: (v) => set({ backendConnected: v }),
  backendHint: null,
  setBackendHint: (v) => set({ backendHint: v }),
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),
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
