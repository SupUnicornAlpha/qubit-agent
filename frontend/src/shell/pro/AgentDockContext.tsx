import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";

type AgentDockContextValue = {
  /** ProAgentPanel 内可供 createPortal 挂载的 DOM 节点 */
  hostEl: HTMLElement | null;
  setHostEl: (el: HTMLElement | null) => void;
  /** 谁占用了 Agent 栏（如 team）；null 表示显示默认 ChatPanel */
  source: string | null;
  setSource: (source: string | null) => void;
};

const AgentDockContext = createContext<AgentDockContextValue | null>(null);

export const AgentDockProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [hostEl, setHostElState] = useState<HTMLElement | null>(null);
  const [source, setSource] = useState<string | null>(null);

  const setHostEl = useCallback((el: HTMLElement | null) => {
    setHostElState(el);
  }, []);

  const value = useMemo(
    () => ({ hostEl, setHostEl, source, setSource }),
    [hostEl, setHostEl, source]
  );

  return <AgentDockContext.Provider value={value}>{children}</AgentDockContext.Provider>;
};

export function useAgentDock(): AgentDockContextValue {
  const ctx = useContext(AgentDockContext);
  if (!ctx) {
    throw new Error("useAgentDock must be used within AgentDockProvider");
  }
  return ctx;
}

export function useAgentDockOptional(): AgentDockContextValue | null {
  return useContext(AgentDockContext);
}
