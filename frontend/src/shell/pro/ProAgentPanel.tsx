import { type FC, useEffect, useRef } from "react";
import { ChatPanel } from "../../components/layout/MainContent";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { useAgentDock } from "./AgentDockContext";

/**
 * 右侧 Agent 栏。
 * `fill`：宽度由 react-resizable-panels 控制（专业壳）；
 * 非 fill：像素宽 + 自行显隐（兼容旧嵌入）。
 */
export const ProAgentPanel: FC<{ fill?: boolean }> = ({ fill = false }) => {
  const open = useAppStore((s) => s.agentPanelOpen);
  const width = useAppStore((s) => s.agentPanelWidthPx);
  const setOpen = useAppStore((s) => s.setAgentPanelOpen);
  const { hostEl, setHostEl, source } = useAgentDock();
  const { t } = useTranslation();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => setHostEl(null);
  }, [setHostEl]);

  if (!fill && !open) return null;

  const title =
    source === "team" ? t("proShell.agent.teamTitle") : t("proShell.agent.title");

  return (
    <aside
      className="qb-pro-agent-panel"
      style={fill ? styles.fill : { width }}
      aria-label={title}
    >
      <div className="qb-pro-agent-panel__header">
        <strong>{title}</strong>
        {source ? <span className="qb-pro-agent-panel__source">{source}</span> : null}
        <button type="button" onClick={() => setOpen(false)}>
          {t("proShell.agent.hide")}
        </button>
      </div>
      <div
        className="qb-pro-agent-panel__body"
        ref={(el) => {
          bodyRef.current = el;
          if (el !== hostEl) setHostEl(el);
        }}
      >
        {!source ? <ChatPanel displayMode="standard" /> : null}
      </div>
    </aside>
  );
};

const styles = {
  fill: {
    width: "100%",
    height: "100%",
    minWidth: 0,
  } as const,
};
