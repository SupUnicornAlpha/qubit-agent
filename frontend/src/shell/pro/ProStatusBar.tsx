import type { FC } from "react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";

export type ProAgentLifecycle = "idle" | "running" | "awaiting_hitl";

export const ProStatusBar: FC<{ lifecycle?: ProAgentLifecycle }> = ({
  lifecycle = "idle",
}) => {
  const connected = useAppStore((s) => s.backendConnected);
  const activeView = useAppStore((s) => s.activeView);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const { t } = useTranslation();

  const stateLabel =
    lifecycle === "running"
      ? t("proShell.status.agentRunning")
      : lifecycle === "awaiting_hitl"
        ? t("proShell.status.agentAwaiting")
        : t("proShell.status.agentIdle");

  const dotClass =
    lifecycle === "running"
      ? "qb-pro-statusbar__dot qb-pro-statusbar__dot--run"
      : lifecycle === "awaiting_hitl"
        ? "qb-pro-statusbar__dot qb-pro-statusbar__dot--hitl"
        : connected
          ? "qb-pro-statusbar__dot qb-pro-statusbar__dot--ok"
          : "qb-pro-statusbar__dot";

  return (
    <footer className="qb-pro-statusbar" role="status">
      <div className="qb-pro-statusbar__left">
        <span className={dotClass} aria-hidden />
        <span>
          {connected ? t("common.backend.connected") : t("common.backend.offline")}
        </span>
        <span aria-hidden>·</span>
        <span>{t(`sidebar.nav.${activeView}`)}</span>
        <span aria-hidden>·</span>
        <span>{stateLabel}</span>
      </div>
      <div className="qb-pro-statusbar__right">
        <button type="button" onClick={() => setAgentPanelOpen(!agentPanelOpen)}>
          {agentPanelOpen ? t("proShell.status.hideAgent") : t("proShell.status.showAgent")}
        </button>
        <button type="button" onClick={() => setInterfaceMode("simple")}>
          {t("proShell.status.toSimple")}
        </button>
      </div>
    </footer>
  );
};
