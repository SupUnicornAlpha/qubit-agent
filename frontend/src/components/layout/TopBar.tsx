import type { CSSProperties, FC } from "react";
import { useAppStore, UI_THEME_IDS, type UiThemeId } from "../../store";

const THEME_LABELS: Record<UiThemeId, string> = {
  "dark-purple": "深色 · 黑紫",
  "dark-gray": "深色 · 黑灰",
  "light-white": "亮色 · 白",
  "light-sky": "亮色 · 天蓝",
  "light-mint": "亮色 · 浅绿",
};

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  const uiTheme = useAppStore((s) => s.uiTheme);
  const setUiTheme = useAppStore((s) => s.setUiTheme);
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
      <label className="qb-visually-hidden" htmlFor="qb-ui-theme">
        界面主题
      </label>
      <select
        id="qb-ui-theme"
        className="qb-theme-select"
        value={uiTheme}
        title="界面主题"
        aria-label="界面主题"
        onChange={(e) => setUiTheme(e.target.value as UiThemeId)}
      >
        {UI_THEME_IDS.map((id) => (
          <option key={id} value={id}>
            {THEME_LABELS[id]}
          </option>
        ))}
      </select>
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
