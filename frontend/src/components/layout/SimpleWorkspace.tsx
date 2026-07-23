import { Bell, Brain, CheckSquare2, Files, SlidersHorizontal } from "lucide-react";
import { type FC, useEffect, useState } from "react";
import { getOrCreateDefaultProject } from "../../api/backend";
import { useTranslation } from "../../i18n";
import { UI_STYLE_IDS, type UiStyleId, useAppStore } from "../../store";
import { ChatPanel } from "./MainContent";
import {
  SimpleAlertsPage,
  SimpleArtifactsPage,
  SimpleMemoryPage,
  SimpleTasksPage,
} from "./SimpleWorkspacePanels";

type SimplePage = "chat" | "tasks" | "alerts" | "memory" | "artifacts";

const SIMPLE_NAV: Array<{
  id: SimplePage;
  icon: typeof CheckSquare2;
  key: "chat" | "tasks" | "alerts" | "memory" | "files";
}> = [
  { id: "chat", icon: CheckSquare2, key: "chat" },
  { id: "tasks", icon: CheckSquare2, key: "tasks" },
  { id: "alerts", icon: Bell, key: "alerts" },
  { id: "memory", icon: Brain, key: "memory" },
  { id: "artifacts", icon: Files, key: "files" },
];

export const SimpleWorkspace: FC = () => {
  const connected = useAppStore((state) => state.backendConnected);
  const setInterfaceMode = useAppStore((state) => state.setInterfaceMode);
  const uiStyle = useAppStore((state) => state.uiStyle);
  const setUiStyle = useAppStore((state) => state.setUiStyle);
  const selectedSessionId = useAppStore((state) => state.selectedSessionId);
  const setSelectedSessionId = useAppStore((state) => state.setSelectedSessionId);
  const { t } = useTranslation();
  const [page, setPage] = useState<SimplePage>("chat");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    let disposed = false;
    void getOrCreateDefaultProject()
      .then((project) => {
        if (disposed) return;
        setProjectId(project.id);
      })
      .catch(() => {
        if (disposed) return;
        setProjectId("");
      });
    return () => {
      disposed = true;
    };
  }, []);

  const openTaskConversation = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setPage("chat");
  };

  return (
    <div className="qb-simple-shell">
      <header className="qb-simple-header">
        <button className="qb-simple-brand" type="button" aria-label="Qubit">
          <img src="/icon.png" alt="" width={24} height={24} />
          <span>Qubit</span>
        </button>
        <nav className="qb-simple-nav" aria-label={t("simpleMode.navigationLabel")}>
          {SIMPLE_NAV.map((item) => {
            const Icon = item.icon;
            const active = page === item.id;
            return (
              <button
                key={item.id}
                className={active ? "qb-simple-nav__active" : undefined}
                type="button"
                aria-current={active ? "page" : undefined}
                title={t(`simpleMode.nav.${item.key}`)}
                onClick={() => setPage(item.id)}
              >
                {item.id === "chat" ? <span className="qb-simple-nav__chat-dot" /> : <Icon size={15} />}
                <span>{t(`simpleMode.nav.${item.key}`)}</span>
              </button>
            );
          })}
        </nav>
        <div className="qb-simple-header__actions">
          <span className={`qb-simple-status${connected ? " qb-simple-status--online" : ""}`}>
            {connected ? t("simpleMode.online") : t("simpleMode.offline")}
          </span>
          <select
            className="qb-simple-style-select"
            value={uiStyle}
            aria-label={t("topbar.style.label")}
            onChange={(event) => setUiStyle(event.target.value as UiStyleId)}
          >
            {UI_STYLE_IDS.map((styleId) => (
              <option key={styleId} value={styleId}>
                {t(`theme.styles.${styleId}`)}
              </option>
            ))}
          </select>
          <button className="qb-simple-advanced-btn" type="button" onClick={() => setInterfaceMode("advanced")}>
            <SlidersHorizontal size={15} />
            <span>{t("simpleMode.advanced")}</span>
          </button>
        </div>
      </header>
      <main className="qb-simple-main">
        {page === "chat" ? <ChatPanel displayMode="simple" /> : null}
        {page === "tasks" ? (
          <SimpleTasksPage
            projectId={projectId}
            sessionId={selectedSessionId}
            onOpenConversation={openTaskConversation}
          />
        ) : null}
        {page === "alerts" ? <SimpleAlertsPage /> : null}
        {page === "memory" ? <SimpleMemoryPage projectId={projectId} /> : null}
        {page === "artifacts" ? <SimpleArtifactsPage projectId={projectId} /> : null}
      </main>
      <footer className="qb-simple-footer">{t("simpleMode.disclaimer")}</footer>
    </div>
  );
};
