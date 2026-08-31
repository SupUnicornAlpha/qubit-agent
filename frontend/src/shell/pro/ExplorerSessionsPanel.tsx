import { type FC, useEffect, useState } from "react";
import {
  createChatSession,
  deleteChatSession,
  getOrCreateDefaultProject,
  listChatSessions,
} from "../../api/backend";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";

/**
 * 左侧 Explorer「会话」分区：专业壳把 session 列表从右侧 Agent 挪到这里。
 */
export const ExplorerSessionsPanel: FC = () => {
  const chatSessions = useAppStore((s) => s.chatSessions);
  const setChatSessions = useAppStore((s) => s.setChatSessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (chatSessions.length > 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const project = await getOrCreateDefaultProject();
        const sessions = await listChatSessions({
          workspaceId: project.workspaceId,
          projectId: project.id,
          limit: 100,
        });
        if (cancelled) return;
        setChatSessions(sessions);
        if (sessions.length === 0) {
          const created = await createChatSession({
            workspaceId: project.workspaceId,
            projectId: project.id,
            title: t("chat.sidebar.newSession"),
          });
          if (cancelled) return;
          setChatSessions([created]);
          setSelectedSessionId(created.id);
        } else if (!selectedSessionId || !sessions.some((s) => s.id === selectedSessionId)) {
          setSelectedSessionId(sessions[0].id);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatSessions.length, selectedSessionId, setChatSessions, setSelectedSessionId, t]);

  const onCreate = async () => {
    try {
      const project = await getOrCreateDefaultProject();
      const created = await createChatSession({
        workspaceId: project.workspaceId,
        projectId: project.id,
        title: `会话 ${chatSessions.length + 1}`,
      });
      setChatSessions([created, ...chatSessions]);
      setSelectedSessionId(created.id);
      setAgentPanelOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onSelect = (id: string) => {
    setSelectedSessionId(id);
    setAgentPanelOpen(true);
    // 不强制切 chat 视图，便于团队页共用会话上下文
  };

  const onDelete = async (id: string, title: string) => {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      window.setTimeout(() => {
        setPendingDeleteId((cur) => (cur === id ? null : cur));
      }, 2500);
      return;
    }
    try {
      await deleteChatSession(id, { hard: true });
      const remaining = chatSessions.filter((s) => s.id !== id);
      setChatSessions(remaining);
      if (selectedSessionId === id) {
        setSelectedSessionId(remaining[0]?.id ?? "");
      }
      setPendingDeleteId(null);
      void title;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="qb-explorer-assets">
      <div className="qb-explorer-assets__meta">{t("proShell.sessions.hint")}</div>
      <button type="button" className="qb-explorer-assets__row" onClick={() => void onCreate()}>
        <span>{t("chat.sidebar.newSession")}</span>
      </button>
      <button
        type="button"
        className="qb-explorer-assets__row"
        onClick={() => {
          setActiveView("team");
          setAgentPanelOpen(true);
        }}
      >
        <span>{t("proShell.sessions.focusAgent")}</span>
      </button>
      {error ? <div className="qb-explorer-assets__meta">{error}</div> : null}
      {chatSessions.length === 0 ? (
        <div className="qb-explorer-assets__meta">{t("proShell.sessions.empty")}</div>
      ) : (
        chatSessions.map((session) => {
          const active = session.id === selectedSessionId;
          return (
            <div
              key={session.id}
              style={{
                display: "flex",
                alignItems: "stretch",
                gap: 2,
                borderRadius: 2,
                background: active ? "rgba(55,148,255,0.14)" : "transparent",
              }}
            >
              <button
                type="button"
                className="qb-explorer-assets__row"
                style={{ flex: 1 }}
                title={session.title}
                onClick={() => onSelect(session.id)}
              >
                <span>
                  {session.title}
                  <span style={{ display: "block", opacity: 0.6, fontSize: 11 }}>
                    {new Date(session.updatedAt).toLocaleString()}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="qb-explorer-assets__row"
                style={{
                  width: 28,
                  justifyContent: "center",
                  color: pendingDeleteId === session.id ? "#fecaca" : undefined,
                  background: pendingDeleteId === session.id ? "#7f1d1d" : "transparent",
                }}
                title={
                  pendingDeleteId === session.id
                    ? t("chat.sidebar.confirmDeleteTitle")
                    : t("chat.sidebar.deleteSessionTitle")
                }
                onClick={() => void onDelete(session.id, session.title)}
              >
                <span>{pendingDeleteId === session.id ? "!" : "×"}</span>
              </button>
            </div>
          );
        })
      )}
    </div>
  );
};
