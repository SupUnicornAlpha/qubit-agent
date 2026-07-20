import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { PACKAGED_BACKEND_URL } from "../../api/packaged-backend";
import { isTauriEnv, tauriRestartBackend, waitForTauriBackendHealth } from "../../api/tauri";
import { LanguageSwitcher, useTranslation } from "../../i18n";
import { UI_STYLE_IDS, type UiStyleId, useAppStore } from "../../store";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);
  const inTauri = isTauriEnv();

  const onRestartBackend = async () => {
    if (!inTauri || restarting) return;
    setRestarting(true);
    setBackendHint(t("topbar.restart.progress"));
    try {
      const status = await tauriRestartBackend();
      if (!status.running) {
        throw new Error(status.error ?? "内置后端进程启动失败");
      }
      const health = await waitForTauriBackendHealth();
      setBackendConnected(true);
      setBackendHint(
        health.status === "degraded"
          ? `后端在线 · 行情降级：${health.marketData?.message ?? "readiness 未通过"}`
          : null
      );
    } catch (error) {
      setBackendConnected(false);
      const detail = error instanceof Error ? error.message : String(error);
      setBackendHint(t("topbar.restart.failure", { url: PACKAGED_BACKEND_URL, detail }));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <header className="qb-topbar" style={styles.bar}>
      <div style={styles.brand}>
        <img
          src="/icon.png"
          alt="QUBIT"
          width={28}
          height={28}
          className="qb-brand-mark"
          style={styles.mark}
        />
        <span className="qb-logo-text" style={styles.logo}>
          QUBIT
        </span>
      </div>
      <span className="qb-topbar__divider" aria-hidden />
      <span className="qb-topbar__subtitle" style={styles.subtitleWrap}>
        {t("topbar.brandSubtitle")}
      </span>
      {backendHint ? <span style={styles.hint}>{backendHint}</span> : null}
      <div className="qb-appearance-controls" style={styles.appearance}>
        <button
          type="button"
          className="qb-interface-mode-btn"
          onClick={() => setInterfaceMode("simple")}
        >
          {t("topbar.mode.simple")}
        </button>
        <label className="qb-visually-hidden" htmlFor="qb-ui-style">
          {t("topbar.style.label")}
        </label>
        <select
          id="qb-ui-style"
          className="qb-style-select"
          value={uiStyle}
          title={t("topbar.style.label")}
          aria-label={t("topbar.style.label")}
          onChange={(e) => setUiStyle(e.target.value as UiStyleId)}
        >
          {UI_STYLE_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`theme.styles.${id}`)}
            </option>
          ))}
        </select>
        <LanguageSwitcher />
      </div>
      <span className="qb-topbar__divider" aria-hidden />
      <StatusDot connected={connected} inTauri={inTauri} />
      {inTauri ? (
        <button
          type="button"
          className="qb-backend-restart-btn"
          style={styles.restartBtn}
          disabled={restarting}
          aria-busy={restarting}
          title={t("topbar.restart.title", { url: PACKAGED_BACKEND_URL })}
          onClick={() => void onRestartBackend()}
        >
          {restarting ? t("topbar.restart.running") : t("topbar.restart.button")}
        </button>
      ) : null}
    </header>
  );
};

const StatusDot: FC<{ connected: boolean; inTauri: boolean }> = ({ connected, inTauri }) => {
  const { t } = useTranslation();
  return (
    <div
      className="qb-status-pill"
      title={
        connected
          ? inTauri
            ? t("topbar.status.connectedTauri")
            : t("topbar.status.connectedWeb")
          : inTauri
            ? t("topbar.status.offlineTauri")
            : t("topbar.status.offlineWeb")
      }
      style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#a1a1aa" }}
    >
      <span
        className={`qb-status-dot ${connected ? "qb-status-dot--ok qb-status-dot--live" : "qb-status-dot--off"}`}
        aria-hidden
      />
      {connected ? t("common.backend.connected") : t("common.backend.offline")}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "nowrap",
    height: 52,
    padding: "0 22px",
    gap: 10,
    flexShrink: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  mark: {
    display: "block",
    width: 28,
    height: 28,
    borderRadius: 7,
    objectFit: "cover",
  },
  logo: {
    fontWeight: 700,
    fontSize: 16,
    letterSpacing: "0.05em",
  },
  subtitleWrap: {
    flexShrink: 0,
    maxWidth: 280,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  hint: {
    fontSize: 12,
    color: "#f59e0b",
    maxWidth: 440,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  appearance: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginLeft: "auto",
    flexShrink: 0,
    minWidth: 0,
  },
  restartBtn: {
    flexShrink: 0,
    fontSize: 11,
    padding: "4px 10px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#d4d4d8",
    cursor: "pointer",
  },
};
