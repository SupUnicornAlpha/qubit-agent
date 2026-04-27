import { create } from "zustand";
import type { AgentSummary, AgentsConfigResponse, StepStreamEvent } from "../api/types";

interface AppState {
  backendConnected: boolean;
  setBackendConnected: (v: boolean) => void;
  activeView: "monitor" | "config";
  setActiveView: (view: "monitor" | "config") => void;
  agents: AgentSummary[];
  setAgents: (agents: AgentSummary[]) => void;
  streamEvents: StepStreamEvent[];
  pushStreamEvent: (event: StepStreamEvent) => void;
  clearStreamEvents: () => void;
  configData: AgentsConfigResponse | null;
  setConfigData: (v: AgentsConfigResponse | null) => void;
  reloadSummary: { before: number; after: number } | null;
  setReloadSummary: (v: { before: number; after: number } | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  backendConnected: false,
  setBackendConnected: (v) => set({ backendConnected: v }),
  activeView: "monitor",
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
}));
