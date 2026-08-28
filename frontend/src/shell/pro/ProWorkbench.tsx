import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { MainContent } from "../../components/layout/MainContent";
import { Sidebar } from "../../components/layout/Sidebar";
import { TopBar } from "../../components/layout/TopBar";
import { WorkspaceBottomPanel } from "../../components/workspace/WorkspaceBottomPanel";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { ProAgentPanel } from "./ProAgentPanel";
import { ProStatusBar } from "./ProStatusBar";

const WORKBENCH_LAYOUT_ID = "qubit:pro-workbench-v1";
const CENTER_LAYOUT_ID = "qubit:pro-workbench-center-v1";
/** 与 Sidebar Activity Bar 同宽；收起时 Panel 百分比 ≈ 52px，减少无内容留白 */
const SIDEBAR_ACTIVITY_BAR_PX = 52;

/**
 * 专业 IDE 壳：TopBar + 可拖拽三栏（Side / Editor / Agent）+ 下置工程面板 + StatusBar。
 * 分割库：react-resizable-panels（02 §9.4 / O-U2）；布局经 autoSaveId 持久化。
 */
export const ProWorkbench: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const explorerOpen = useAppStore((s) => s.explorerOpen);
  const setExplorerOpen = useAppStore((s) => s.setExplorerOpen);
  const setAgentPanelWidthPx = useAppStore((s) => s.setAgentPanelWidthPx);
  const proBottomPanelOpen = useAppStore((s) => s.proBottomPanelOpen);
  const setProBottomPanelOpen = useAppStore((s) => s.setProBottomPanelOpen);
  const toggleProBottomPanelOpen = useAppStore((s) => s.toggleProBottomPanelOpen);
  const { t } = useTranslation();
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const [bottomMaximized, setBottomMaximized] = useState(false);
  const [sidebarCollapsedPct, setSidebarCollapsedPct] = useState(3);

  useEffect(() => {
    const sync = () => {
      const pct = (SIDEBAR_ACTIVITY_BAR_PX / Math.max(window.innerWidth, 640)) * 100;
      setSidebarCollapsedPct(Math.min(5, Math.max(2.5, pct)));
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    if (activeView === "chat") setActiveView("team");
  }, [activeView, setActiveView]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "`") {
        e.preventDefault();
        toggleProBottomPanelOpen();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleProBottomPanelOpen]);

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
            collapsedSize={sidebarCollapsedPct}
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
              {proBottomPanelOpen ? (
                <PanelGroup
                  direction="vertical"
                  autoSaveId={CENTER_LAYOUT_ID}
                  className="qb-pro-panel-group--vertical"
                >
                  {!bottomMaximized ? (
                    <>
                      <Panel
                        id="main-stage"
                        order={1}
                        defaultSize={70}
                        minSize={25}
                        className="qb-pro-panel qb-pro-panel--stage"
                      >
                        <MainContent />
                      </Panel>
                      <PanelResizeHandle
                        className="qb-pro-resize-handle qb-pro-resize-handle--vertical"
                        aria-label="调整底部面板高度"
                      />
                    </>
                  ) : null}
                  <Panel
                    id="bottom-dock"
                    order={2}
                    defaultSize={bottomMaximized ? 100 : 30}
                    minSize={15}
                    maxSize={bottomMaximized ? 100 : 75}
                    className="qb-pro-panel qb-pro-panel--bottom"
                  >
                    <WorkspaceBottomPanel
                      maximized={bottomMaximized}
                      onToggleMaximize={() => setBottomMaximized(!bottomMaximized)}
                      onClose={() => setProBottomPanelOpen(false)}
                    />
                  </Panel>
                </PanelGroup>
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
