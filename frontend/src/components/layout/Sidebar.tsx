import type { FC } from "react";

const NAV_ITEMS = [
  { label: "工作流", icon: "⚡", href: "#workflow" },
  { label: "策略研究", icon: "🔬", href: "#research" },
  { label: "回测", icon: "📈", href: "#backtest" },
  { label: "仿真", icon: "🧪", href: "#simulation" },
  { label: "风控", icon: "🛡️", href: "#risk" },
  { label: "执行", icon: "🚀", href: "#execution" },
  { label: "记忆库", icon: "🧠", href: "#memory" },
  { label: "审计日志", icon: "📋", href: "#audit" },
];

export const Sidebar: FC = () => {
  return (
    <nav style={styles.nav}>
      {NAV_ITEMS.map((item) => (
        <a key={item.href} href={item.href} style={styles.item}>
          <span style={styles.icon}>{item.icon}</span>
          <span style={styles.label}>{item.label}</span>
        </a>
      ))}
    </nav>
  );
};

const styles: Record<string, React.CSSProperties> = {
  nav: {
    width: 200,
    background: "#18181b",
    borderRight: "1px solid #27272a",
    display: "flex",
    flexDirection: "column",
    padding: "12px 0",
    flexShrink: 0,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    textDecoration: "none",
    color: "#a1a1aa",
    fontSize: 14,
    transition: "background 0.15s, color 0.15s",
    borderRadius: 6,
    margin: "1px 8px",
  },
  icon: { fontSize: 16, width: 20, textAlign: "center" },
  label: {},
};
