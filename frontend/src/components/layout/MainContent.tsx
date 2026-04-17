import type { FC } from "react";

export const MainContent: FC = () => {
  return (
    <main style={styles.main}>
      <div style={styles.placeholder}>
        <h2 style={styles.title}>QUBIT 平台</h2>
        <p style={styles.desc}>
          多 Agent 量化研究平台骨架已搭建完成。
          <br />
          选择左侧模块开始工作。
        </p>
        <ModuleGrid />
      </div>
    </main>
  );
};

const MODULES = [
  { name: "Orchestrator", desc: "任务拆解与调度" },
  { name: "Market Data", desc: "行情数据采集" },
  { name: "News/Event", desc: "新闻事件抽取" },
  { name: "Research", desc: "因子研究与策略生成" },
  { name: "Backtest", desc: "回测编排与评估" },
  { name: "Simulation", desc: "仿真交易" },
  { name: "Risk", desc: "风控裁决（一票否决）" },
  { name: "Execution", desc: "订单路由与回报" },
  { name: "Memory", desc: "分层记忆系统" },
  { name: "Audit", desc: "全链路审计" },
];

const ModuleGrid: FC = () => (
  <div style={styles.grid}>
    {MODULES.map((m) => (
      <div key={m.name} style={styles.card}>
        <div style={styles.cardName}>{m.name}</div>
        <div style={styles.cardDesc}>{m.desc}</div>
      </div>
    ))}
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  main: {
    flex: 1,
    overflow: "auto",
    padding: 32,
  },
  placeholder: {
    maxWidth: 800,
    margin: "0 auto",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "#e4e4e7",
    margin: "0 0 8px",
  },
  desc: {
    color: "#71717a",
    fontSize: 14,
    lineHeight: 1.6,
    margin: "0 0 32px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 16,
  },
  cardName: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a78bfa",
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 12,
    color: "#71717a",
  },
};
