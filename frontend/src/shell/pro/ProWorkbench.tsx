import type { FC } from "react";
import { MainContent } from "../../components/layout/MainContent";
import { Sidebar } from "../../components/layout/Sidebar";
import { TopBar } from "../../components/layout/TopBar";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { ProAgentPanel } from "./ProAgentPanel";
import { ProStatusBar } from "./ProStatusBar";

/**
 * 专业 IDE 壳：TopBar（矮）+ Activity/Explorer + 页面宿主 + 右侧 Agent + StatusBar。
 * 中栏经 MainContent → pages/PageHost 按 activeView 挂载注册表页面。
 */
export const ProWorkbench: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const { t } = useTranslation();

  const showChatPlaceholder = activeView === "chat" && agentPanelOpen;

  return (
    <div className="qb-pro-workbench">
      <TopBar />
      <div className="qb-pro-workbench__body">
        <Sidebar />
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
        <ProAgentPanel />
      </div>
      <ProStatusBar />
    </div>
  );
};
