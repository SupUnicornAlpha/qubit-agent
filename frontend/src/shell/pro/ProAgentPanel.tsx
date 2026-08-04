import {
  type FC,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { ChatPanel } from "../../components/layout/MainContent";
import { useTranslation } from "../../i18n";
import { useAppStore } from "../../store";
import { useAgentDock } from "./AgentDockContext";

export const ProAgentPanel: FC = () => {
  const open = useAppStore((s) => s.agentPanelOpen);
  const width = useAppStore((s) => s.agentPanelWidthPx);
  const setWidth = useAppStore((s) => s.setAgentPanelWidthPx);
  const setOpen = useAppStore((s) => s.setAgentPanelOpen);
  const { hostEl, setHostEl, source } = useAgentDock();
  const { t } = useTranslation();
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = drag.startX - event.clientX;
      setWidth(drag.startW + delta);
    },
    [setWidth]
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      setHostEl(null);
    };
  }, [onPointerMove, onPointerUp, setHostEl]);

  if (!open) return null;

  const onResizeStart = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startW: width };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const title =
    source === "team" ? t("proShell.agent.teamTitle") : t("proShell.agent.title");

  return (
    <>
      <button
        type="button"
        className="qb-pro-agent-resize"
        aria-label={t("proShell.agent.resizeAria")}
        onMouseDown={onResizeStart}
      />
      <aside className="qb-pro-agent-panel" style={{ width }} aria-label={title}>
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
    </>
  );
};
