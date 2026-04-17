import { create } from "zustand";

interface AppState {
  wsConnected: boolean;
  setWsConnected: (v: boolean) => void;
  activeView: string;
  setActiveView: (view: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  wsConnected: false,
  setWsConnected: (v) => set({ wsConnected: v }),
  activeView: "workflow",
  setActiveView: (view) => set({ activeView: view }),
}));
