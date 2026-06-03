import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { getHealth } from "../../api/backend";
import { PACKAGED_BACKEND_URL } from "../../api/packaged-backend";
import { isTauriEnv, tauriRestartBackend } from "../../api/tauri";
import { palettesForStyle } from "../../theme/appearance";
import { useAppStore, UI_STYLE_IDS, type UiPaletteId, type UiStyleId } from "../../store";
import { LanguageSwitcher, useTranslation } from "../../i18n";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);
  const uiPalette = useAppStore((s) => s.uiPalette);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiPalette = useAppStore((s) => s.setUiPalette);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);
  const inTauri = isTauriEnv();
  const paletteLocked =
    uiStyle !== "default" && uiStyle !== "glass-holographic" && uiStyle !== "biophilic";
  const paletteOptions = palettesForStyle(uiStyle);

  const onRestartBackend = async () => {
    if (!inTauri || restarting) return;
    setRestarting(true);
    setBackendHint(t("topbar.restart.progress"));
    try {
      await tauriRestartBackend();
      await new Promise((r) => setTimeout(r, 800));
      await getHealth();
      setBackendConnected(true);
      setBackendHint(null);
    } catch {
      setBackendConnected(false);
      setBackendHint(t("topbar.restart.failure", { url: PACKAGED_BACKEND_URL }));
    } finally {
      setRestarting(false);
    }
  };

  return (
    <header className="qb-topbar" style={styles.bar}>
      <div style={styles.brand}>
        <img src="/icon.png" alt="QUBIT" width={28} height={28} className="qb-brand-mark" style={styles.mark} />
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
        <label className="qb-visually-hidden" htmlFor="qb-ui-palette">
          {t("topbar.palette.label")}
        </label>
        <select
          id="qb-ui-palette"
          className="qb-theme-select"
          value={uiPalette}
          title={
            paletteLocked
              ? t("topbar.palette.lockedTitle")
              : uiStyle === "glass-holographic"
                ? t("topbar.palette.glassTitle")
                : uiStyle === "biophilic"
                  ? t("topbar.palette.biophilicTitle")
                  : t("topbar.palette.defaultTitle")
          }
          aria-label={t("topbar.palette.label")}
          disabled={paletteLocked}
          onChange={(e) => setUiPalette(e.target.value as UiPaletteId)}
        >
          {paletteOptions.map((id) => (
            <option key={id} value={id}>
              {t(`theme.palettes.${id}`)}
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
          title={t("topbar.restart.title", { url: PACKAGED_BACKEND_URL })}
          onClick={() => void onRestartBackend()}
        >
          {restarting ? t("topbar.restart.running") : t("topbar.restart.button")}
        </button>
      ) : null}
      {uiStyle === "ambient-3d" ? (
        <span className="qb-topbar__spatial-badge" aria-hidden>
          SPATIAL UI
        </span>
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
