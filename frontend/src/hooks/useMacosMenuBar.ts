import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { flattenMonitorWorkflowRows, listMonitorWorkflows, listStrategyRuntimes } from "../api/backend";
import {
  isMacosTauriEnv,
  tauriUpdateMenuBarSummary,
  type TauriMenuBarSummary,
} from "../api/tauri";
import { useAppStore } from "../store";

type MenuBarAction = {
  action: "show" | "quick-chat" | "trading" | "monitoring" | "workflow";
  workflowId?: string | null;
};

function toWorkflowSummary(row: unknown): { id: string; goal: string } | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : "";
  if (!id) return null;
  const goal = typeof value.goal === "string" && value.goal.trim() ? value.goal.trim() : id;
  return { id, goal };
}

/**
 * macOS 菜单栏是桌面应用窗口不在前台时仍可访问的运行入口。
 * 这里保持一个极小摘要，同步给原生 Tray，而不在菜单栏复制整个监控页。
 */
export function useMacosMenuBar(): void {
  const backendConnected = useAppStore((s) => s.backendConnected);
  const traderAgentLog = useAppStore((s) => s.traderAgentLog);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const setMonitorWorkflowFocus = useAppStore((s) => s.setMonitorWorkflowFocus);

  useEffect(() => {
    if (!isMacosTauriEnv()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<MenuBarAction>("qubit:menu-bar-action", (event) => {
      if (disposed) return;
      if (event.payload.action === "quick-chat") {
        setActiveView("ide");
        setAgentPanelOpen(true);
      }
      if (event.payload.action === "trading") setActiveView("trader");
      if (event.payload.action === "monitoring") setActiveView("monitor");
      if (event.payload.action === "workflow" && event.payload.workflowId) {
        setMonitorWorkflowFocus(event.payload.workflowId);
        setActiveView("monitor");
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setActiveView, setAgentPanelOpen, setMonitorWorkflowFocus]);

  useEffect(() => {
    if (!isMacosTauriEnv()) return;
    let disposed = false;
    const latestTradeMessage = traderAgentLog[traderAgentLog.length - 1]?.title ?? null;

    const publish = async () => {
      let summary: TauriMenuBarSummary = {
        backendConnected,
        runningWorkflows: [],
        runningStrategies: 0,
        latestTradeMessage,
      };
      if (backendConnected) {
        const [workflows, strategies] = await Promise.allSettled([
          listMonitorWorkflows({ status: "running" }),
          listStrategyRuntimes({ status: "running" }),
        ]);
        if (workflows.status === "fulfilled") {
          const rows = flattenMonitorWorkflowRows(workflows.value);
          summary = {
            ...summary,
            runningWorkflows: rows
              .map(toWorkflowSummary)
              .filter((workflow): workflow is { id: string; goal: string } => workflow !== null)
              .slice(0, 3),
          };
        }
        if (strategies.status === "fulfilled") {
          summary = { ...summary, runningStrategies: strategies.value.length };
        }
      }
      if (!disposed) await tauriUpdateMenuBarSummary(summary).catch(() => undefined);
    };

    void publish();
    const timer = window.setInterval(() => void publish(), 20_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [backendConnected, traderAgentLog]);
}
