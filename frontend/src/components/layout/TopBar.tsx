import type { CSSProperties, FC } from "react";
import { PALETTE_LABELS, STYLE_LABELS } from "../../theme/appearance";
import { useAppStore, UI_PALETTE_IDS, UI_STYLE_IDS, type UiPaletteId, type UiStyleId } from "../../store";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  const uiPalette = useAppStore((s) => s.uiPalette);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const setUiPalette = useAppStore((s) => s.setUiPalette);
  const setUiStyle = useAppStore((s) => s.setUiStyle);
  const paletteLocked = uiStyle !== "default";

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
      <div style={styles.spacer} />
      <div className="qb-appearance-controls">
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
          title={paletteLocked ? "切换回「默认」风格后可改配色" : "配色（默认风格）"}
          aria-label="配色"
          disabled={paletteLocked}
          onChange={(e) => setUiPalette(e.target.value as UiPaletteId)}
        >
          {UI_PALETTE_IDS.map((id) => (
            <option key={id} value={id}>
              {PALETTE_LABELS[id]}
            </option>
          ))}
        </select>
      </div>
      <span className="qb-topbar__divider" aria-hidden />
      <StatusDot connected={connected} />
    </header>
  );
};

const StatusDot: FC<{ connected: boolean }> = ({ connected }) => (
  <div
    className="qb-status-pill"
    title={connected ? "后端健康检查通过，可正常调用 API" : "后端未响应：请检查本机是否已启动开发服务"}
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
    height: 52,
    padding: "0 22px",
    gap: 10,
    flexShrink: 0,
    minWidth: 0,
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
  spacer: { flex: 1, minWidth: 0 },
};
