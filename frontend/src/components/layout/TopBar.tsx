import type { FC } from "react";
import { useAppStore } from "../../store";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  const backendHint = useAppStore((s) => s.backendHint);
  return (
    <header style={styles.bar}>
      <div style={styles.brand}>
        <img src="/icon.png" alt="QUBIT" width={28} height={28} style={styles.mark} />
        <span style={styles.logo}>QUBIT</span>
      </div>
      <span style={styles.subtitle}>量化研究 Agent 平台</span>
      {backendHint ? <span style={styles.hint}>{backendHint}</span> : null}
      <div style={styles.spacer} />
      <StatusDot connected={connected} />
    </header>
  );
};

const StatusDot: FC<{ connected: boolean }> = ({ connected }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#71717a" }}>
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: connected ? "#22c55e" : "#ef4444",
        display: "inline-block",
      }}
    />
    {connected ? "Backend Connected" : "Backend Offline"}
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    height: 48,
    padding: "0 20px",
    background: "#0d0d0f",
    borderBottom: "1px solid #27272a",
    gap: 12,
    flexShrink: 0,
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
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.45)",
  },
  logo: {
    fontWeight: 700,
    fontSize: 16,
    letterSpacing: "0.05em",
    color: "#a78bfa",
  },
  subtitle: {
    fontSize: 12,
    color: "#52525b",
  },
  hint: {
    fontSize: 12,
    color: "#f59e0b",
    maxWidth: 440,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  spacer: { flex: 1 },
};
