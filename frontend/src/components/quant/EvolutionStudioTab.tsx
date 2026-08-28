import type { CSSProperties, FC } from "react";
import { GenomeEvolutionPanel } from "./GenomeEvolutionPanel";
import { useDefaultProject } from "./useDefaultProject";

/** 独立入口：不必先选中一条回测结果，也能审计和操作策略基因池。 */
export const EvolutionStudioTab: FC = () => {
  const { scopeProjectId, defaultProjectId, scopeAllProjects, loading, error } = useDefaultProject();
  const evolutionProjectId = scopeProjectId ?? defaultProjectId;

  if (loading) return <div style={styles.state}>正在加载 project…</div>;
  if (error) return <div style={styles.state}>无法加载基因池：{error}</div>;
  if (!evolutionProjectId) {
    return (
      <div style={styles.state}>
        {scopeAllProjects
          ? "基因池按 project 隔离：请在顶部数据范围中选择一个具体 project。"
          : "未找到 project，请切换数据范围。"}
      </div>
    );
  }

  return (
    <div className="qb-quant-tab-root qb-quant-tab-root--evolution" style={styles.root}>
      <div style={styles.intro}>
        <div>
          <div style={styles.title}>评估与自进化</div>
          <div style={styles.subtitle}>
            回测不是只看
            Sharpe。这里审计每一代策略是否已完成全维评估，并且只让通过准入的个体成为下一代父本。
          </div>
        </div>
        <div style={styles.gateNote}>
          准入：样本 ≥ 60 · Sharpe ≥ 0.3 · MDD ≤ 30% · CVaR 95% ≤ 8% · 正收益期 ≥ 40%
        </div>
      </div>
      <GenomeEvolutionPanel projectId={evolutionProjectId} />
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    minHeight: "100%",
    maxWidth: 1120,
    margin: "0 auto",
    padding: "20px 24px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  intro: {
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 20,
    paddingBottom: 14,
    borderBottom: "1px solid var(--qb-border-subtle)",
  },
  title: { fontSize: 20, fontWeight: 700 },
  subtitle: {
    maxWidth: 660,
    marginTop: 6,
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--qb-text-muted)",
  },
  gateNote: {
    maxWidth: 340,
    padding: "8px 10px",
    borderLeft: "2px solid var(--qb-quant-accent-5)",
    color: "var(--qb-text-muted)",
    fontSize: 10,
    lineHeight: 1.5,
  },
  state: { padding: 24, color: "var(--qb-text-muted)", fontSize: 12 },
};
