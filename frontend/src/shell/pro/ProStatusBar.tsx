import type { FC } from "react";
import { GitBranch, Terminal as TerminalIcon, AlertCircle } from "lucide-react";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { getPageDescriptor } from "../../pages/registry";

export type ProAgentLifecycle = "idle" | "running" | "awaiting_hitl";

export const ProStatusBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const activeView = useAppStore((s) => s.activeView);
  const agentPanelOpen = useAppStore((s) => s.agentPanelOpen);
  const setAgentPanelOpen = useAppStore((s) => s.setAgentPanelOpen);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const lifecycle = useAppStore((s) => s.proAgentLifecycle);
  const activeFsWorkspaceId = useAppStore((s) => s.activeFsWorkspaceId);
  const chromeDensity = useAppStore((s) => s.chromeDensity);
  const toggleChromeDensity = useAppStore((s) => s.toggleChromeDensity);
  const proBottomPanelOpen = useAppStore((s) => s.proBottomPanelOpen);
  const toggleProBottomPanelOpen = useAppStore((s) => s.toggleProBottomPanelOpen);
  const setProBottomTab = useAppStore((s) => s.setProBottomTab);
  const setProBottomPanelOpen = useAppStore((s) => s.setProBottomPanelOpen);
  const { t } = useTranslation();

  const page = getPageDescriptor(activeView);
  const pageLabel = page ? t(page.titleKey) : t(`sidebar.nav.${activeView}`);

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

  const openProblems = () => {
    setProBottomTab("problems");
    setProBottomPanelOpen(true);
  };

  return (
    <footer className="qb-pro-statusbar" role="status">
      <div className="qb-pro-statusbar__left">
        <span className={dotClass} aria-hidden />
        <span>
          {connected ? t("common.backend.connected") : t("common.backend.offline")}
        </span>
        <span aria-hidden>·</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          <GitBranch size={11} /> main
        </span>
        <span aria-hidden>·</span>
        <span>{pageLabel}</span>
        {activeFsWorkspaceId ? (
          <>
            <span aria-hidden>·</span>
            <span title={activeFsWorkspaceId}>
              WS {activeFsWorkspaceId.slice(0, 8)}…
            </span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span>{stateLabel}</span>
      </div>
      <div className="qb-pro-statusbar__right">
        <button
          type="button"
          title="Problems 诊断 (0 错误)"
          onClick={openProblems}
          style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
        >
          <AlertCircle size={11} /> 0
        </button>
        <button
          type="button"
          title="切换下置工程面板 (⌘` / Ctrl+`)"
          onClick={() => toggleProBottomPanelOpen()}
          style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
        >
          <TerminalIcon size={11} /> {proBottomPanelOpen ? "隐藏面板" : "工程面板"}
        </button>
        <span>UTF-8</span>
        <span>Spaces: 2</span>
        <button
          type="button"
          title="⌘K / Ctrl+K"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("qb:open-command-palette"));
          }}
        >
          ⌘K
        </button>
        <button
          type="button"
          title={t("proShell.status.densityHint")}
          onClick={() => toggleChromeDensity()}
        >
          {chromeDensity === "compact"
            ? t("proShell.status.densityCompact")
            : t("proShell.status.densityDefault")}
        </button>
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
