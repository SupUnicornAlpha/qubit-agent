import { useEffect, useRef, useState, type FC, type FormEvent } from "react";
import { ArrowUp, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import {
  createChatSession,
  createConversationTurn,
  getOrCreateDefaultProject,
  listChatSessions,
} from "../api/backend";
import { getCurrentWindow } from "@tauri-apps/api/window";

type LatestSession = { id: string; title: string | null };

async function closeQuickChat() {
  try {
    await invoke("hide_menu_bar_quick_chat");
  } catch {
    // 浏览器预览 / 老版本桌面端继续保留前端窗口 API 兜底。
    await getCurrentWindow().hide().catch(() => window.close());
  }
}

/** macOS 菜单栏唤起的轻量输入窗：只投递到默认项目的最新会话。 */
export const MenuBarQuickChat: FC = () => {
  const [session, setSession] = useState<LatestSession | null>(null);
  const [projectId, setProjectId] = useState("");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("正在连接最近会话…");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.body.classList.add("qb-menu-bar-quick-chat-body");
    inputRef.current?.focus();
    return () => document.body.classList.remove("qb-menu-bar-quick-chat-body");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closeQuickChat();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let disposed = false;
    const loadLatestSession = async () => {
      try {
        const project = await getOrCreateDefaultProject();
        const sessions = await listChatSessions({
          workspaceId: project.workspaceId,
          projectId: project.id,
        });
        const latest =
          sessions[0] ??
          (await createChatSession({
            workspaceId: project.workspaceId,
            projectId: project.id,
            title: "菜单栏对话",
          }));
        if (disposed) return;
        setProjectId(project.id);
        setSession({ id: latest.id, title: latest.title });
        setStatus("");
        requestAnimationFrame(() => inputRef.current?.focus());
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : "无法加载最近会话");
      }
    };
    void loadLatestSession();
    return () => {
      disposed = true;
    };
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || !session || !projectId || sending) return;
    setSending(true);
    setStatus("正在发送…");
    try {
      await createConversationTurn({
        sessionId: session.id,
        projectId,
        message,
        workflowMode: "research",
        turnMode: "continue_goal",
        reuseSessionWorkflow: true,
        loopKind: "native",
        hitlMode: "ai",
        agentMode: "agent",
      });
      setInput("");
      setStatus("已发送到最近会话");
      window.setTimeout(() => void closeQuickChat(), 500);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "发送失败");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="qb-menu-bar-quick-chat" aria-label="快速对话">
      <form onSubmit={onSubmit}>
        <div className="qb-menu-bar-quick-chat__meta">
          <span>发送到最近会话{session?.title ? ` · ${session.title}` : ""}</span>
          <button
            type="button"
            onClick={() => void closeQuickChat()}
            aria-label="关闭快速对话"
            title="关闭（Esc）"
          >
            <X size={15} aria-hidden />
          </button>
        </div>
        <div className="qb-menu-bar-quick-chat__composer">
          <input
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入任务，按 Enter 直接发送…"
            disabled={!session || sending}
          />
          <button type="submit" aria-label="发送" title="发送" disabled={!input.trim() || !session || sending}>
            <ArrowUp size={16} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
        {status ? <p className="qb-menu-bar-quick-chat__status">{status}</p> : null}
      </form>
    </main>
  );
};
