import type { FC } from "react";
import { useAppStore } from "../../store";

export const TopBar: FC = () => {
  const connected = useAppStore((s) => s.backendConnected);
  return (
    <header style={styles.bar}>
      <span style={styles.logo}>QUBIT</span>
      <span style={styles.subtitle}>量化研究 Agent 平台</span>
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
    background: "#18181b",
    borderBottom: "1px solid #27272a",
    gap: 12,
    flexShrink: 0,
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
  spacer: { flex: 1 },
};
