import type { CSSProperties, FC } from "react";
import { useState } from "react";
import { getHealth } from "../../api/backend";
import { PACKAGED_BACKEND_URL } from "../../api/packaged-backend";
import { isTauriEnv, tauriRestartBackend } from "../../api/tauri";
import { PALETTE_LABELS, palettesForStyle, STYLE_LABELS } from "../../theme/appearance";
import { useAppStore, UI_STYLE_IDS, type UiPaletteId, type UiStyleId } from "../../store";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  const setBackendConnected = useAppStore((s) => s.setBackendConnected);
  const setBackendHint = useAppStore((s) => s.setBackendHint);
  const uiPalette = useAppStore((s) => s.uiPalette);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiPalette = useAppStore((s) => s.setUiPalette);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const [restarting, setRestarting] = useState(false);
  const inTauri = isTauriEnv();
  const paletteLocked =
    uiStyle !== "default" && uiStyle !== "glass-holographic" && uiStyle !== "biophilic";
  const paletteOptions = palettesForStyle(uiStyle);

  const onRestartBackend = async () => {
    if (!inTauri || restarting) return;
    setRestarting(true);
    setBackendHint("正在重启内置后端…");
    try {
      await tauriRestartBackend();
      await new Promise((r) => setTimeout(r, 800));
      await getHealth();
      setBackendConnected(true);
      setBackendHint(null);
    } catch {
      setBackendConnected(false);
      setBackendHint(`重启失败，请确认本机未占用 ${PACKAGED_BACKEND_URL} 对应端口。`);
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
        量化研究 Agent 平台
      </span>
      {backendHint ? <span style={styles.hint}>{backendHint}</span> : null}
      <div className="qb-appearance-controls" style={styles.appearance}>
        <label className="qb-visually-hidden" htmlFor="qb-ui-style">
          界面风格
        </label>
        <select
          id="qb-ui-style"
          className="qb-style-select"
          value={uiStyle}
          title="界面风格"
          aria-label="界面风格"
          onChange={(e) => setUiStyle(e.target.value as UiStyleId)}
        >
          {UI_STYLE_IDS.map((id) => (
            <option key={id} value={id}>
              {STYLE_LABELS[id]}
            </option>
          ))}
        </select>
        <label className="qb-visually-hidden" htmlFor="qb-ui-palette">
          配色
        </label>
        <select
          id="qb-ui-palette"
          className="qb-theme-select"
          value={uiPalette}
          title={
            paletteLocked
              ? "切换回「默认」、Glass Holographic 或 Biophilic 风格后可改配色"
              : uiStyle === "glass-holographic"
                ? "Glass 底色（冷 / 暖 / 彩虹）"
                : uiStyle === "biophilic"
                  ? "亲自然配色（绿植绿涨 / 柔和红涨）"
                  : "配色"
          }
          aria-label="配色"
          disabled={paletteLocked}
          onChange={(e) => setUiPalette(e.target.value as UiPaletteId)}
        >
          {paletteOptions.map((id) => (
            <option key={id} value={id}>
              {PALETTE_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      <span className="qb-topbar__divider" aria-hidden />
      <StatusDot connected={connected} inTauri={inTauri} />
      {inTauri ? (
        <button
          type="button"
          className="qb-backend-restart-btn"
          style={styles.restartBtn}
          disabled={restarting}
          title={`重启内置后端（${PACKAGED_BACKEND_URL}）`}
          onClick={() => void onRestartBackend()}
        >
          {restarting ? "重启中…" : "重启后端"}
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

const StatusDot: FC<{ connected: boolean; inTauri: boolean }> = ({ connected, inTauri }) => (
  <div
    className="qb-status-pill"
    title={
      connected
        ? inTauri
          ? "内置后端已连接（127.0.0.1:17385）"
          : "后端健康检查通过，可正常调用 API"
        : inTauri
          ? "内置后端未响应，可点击「重启后端」"
          : "后端未响应：请检查本机是否已启动开发服务"
    }
    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#a1a1aa" }}
  >
    <span
      className={`qb-status-dot ${connected ? "qb-status-dot--ok qb-status-dot--live" : "qb-status-dot--off"}`}
      aria-hidden
    />
    {connected ? "Backend Connected" : "Backend Offline"}
  </div>
);

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
