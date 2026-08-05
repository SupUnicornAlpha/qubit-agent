import type { FC } from "react";
import { useEffect, useRef } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { MainContent } from "../../components/layout/MainContent";
import { Sidebar } from "../../components/layout/Sidebar";
import { TopBar } from "../../components/layout/TopBar";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { ProAgentPanel } from "./ProAgentPanel";
import { ProStatusBar } from "./ProStatusBar";

const WORKBENCH_LAYOUT_ID = "qubit:pro-workbench-v1";

/**
 * 专业 IDE 壳：TopBar + 可拖拽三栏（Side / Editor / Agent）+ StatusBar。
 * 分割库：react-resizable-panels（02 §9.4 / O-U2）；布局经 autoSaveId 持久化。
 */
export const ProWorkbench: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const explorerOpen = useAppStore((s) => s.explorerOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const setAgentPanelWidthPx = useAppStore((s) => s.setAgentPanelWidthPx);
  const { t } = useTranslation();
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);

  const showChatPlaceholder = activeView === "chat" && agentPanelOpen;

  useEffect(() => {
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (explorerOpen) {
      if (panel.isCollapsed()) panel.expand();
    } else if (!panel.isCollapsed()) {
      panel.collapse();
    }
  }, [explorerOpen]);

  return (
    <div className="qb-pro-workbench">
      <TopBar />
      <div className="qb-pro-workbench__body">
        <PanelGroup
          direction="horizontal"
          autoSaveId={WORKBENCH_LAYOUT_ID}
          className="qb-pro-panel-group"
        >
          <Panel
            id="sidebar"
            order={1}
            ref={sidebarPanelRef}
            defaultSize={20}
            minSize={12}
            maxSize={36}
            collapsible
            collapsedSize={4}
            onCollapse={() => setExplorerOpen(false)}
            onExpand={() => setExplorerOpen(true)}
            className="qb-pro-panel qb-pro-panel--sidebar"
          >
            <Sidebar fill />
          </Panel>
          <PanelResizeHandle
            className="qb-pro-resize-handle"
            aria-label={t("proShell.resize.sideCenter")}
          />
          <Panel
            id="center"
            order={2}
            defaultSize={agentPanelOpen ? 52 : 80}
            minSize={28}
            className="qb-pro-panel qb-pro-panel--center"
          >
            <div className="qb-pro-workbench__center">
              {showChatPlaceholder ? (
                <main className="qb-pro-chat-placeholder">
                  <div>{t("proShell.chat.movedToAgent")}</div>
                  <button type="button" onClick={() => setAgentPanelOpen(true)}>
                    {t("proShell.chat.focusAgent")}
                  </button>
                  <button type="button" onClick={() => setAgentPanelOpen(false)}>
                    {t("proShell.chat.showCenterChat")}
                  </button>
                </main>
              ) : (
                <MainContent />
              )}
            </div>
          </Panel>
          {agentPanelOpen ? (
            <>
              <PanelResizeHandle
                className="qb-pro-resize-handle"
                aria-label={t("proShell.resize.centerAgent")}
              />
              <Panel
                id="agent"
                order={3}
                defaultSize={28}
                minSize={16}
                maxSize={48}
                onResize={(size) => {
                  if (typeof window === "undefined" || size <= 0) return;
                  setAgentPanelWidthPx(Math.round((window.innerWidth * size) / 100));
                }}
                className="qb-pro-panel qb-pro-panel--agent"
              >
                <ProAgentPanel fill />
              </Panel>
            </>
          ) : null}
        </PanelGroup>
      </div>
      <ProStatusBar />
    </div>
  );
};
