import type { CSSProperties, FC, ReactNode } from "react";
import { useEffect, useState } from "react";
import { type ResearchIntegrityReviewDto, fetchResearchIntegrityReview } from "../../api/backend";
import { GenomeEvolutionPanel } from "./GenomeEvolutionPanel";
import { useDefaultProject } from "./useDefaultProject";

/** 独立入口：不必先选中一条回测结果，也能审计和操作策略基因池。 */
export const EvolutionStudioTab: FC = () => {
  const { scopeProjectId, defaultProjectId, scopeAllProjects, loading, error } =
    useDefaultProject();
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
      <IntegrityReviewPanel projectId={evolutionProjectId} />
      <GenomeEvolutionPanel projectId={evolutionProjectId} />
    </div>
  );
};

const IntegrityReviewPanel: FC<{ projectId: string }> = ({ projectId }) => {
  const [data, setData] = useState<ResearchIntegrityReviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void fetchResearchIntegrityReview(projectId)
      .then((next) => !cancelled && setData(next))
      .catch(
        (reason) =>
          !cancelled && setError(reason instanceof Error ? reason.message : "review_load_failed")
      );
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <details style={styles.review} open>
      <summary style={styles.reviewSummary}>
        <span>完整性审阅</span>
        <span style={styles.reviewHint}>只读 · 策略、组件与数据证据</span>
      </summary>
      {error ? <div style={styles.reviewState}>无法加载审阅：{error}</div> : null}
      {!data && !error ? <div style={styles.reviewState}>正在加载审计证据…</div> : null}
      {data ? (
        <div style={styles.reviewGrid}>
          <ReviewColumn title="策略证据" empty="尚无策略评测记录。">
            {data.strategies.map((strategy) => (
              <div
                key={`${strategy.strategyVersionId}:${strategy.comparisonCohortId ?? "unbound"}`}
                style={styles.reviewRow}
              >
                <code style={styles.code}>{strategy.strategyVersionId.slice(0, 12)}</code>
                <span
                  style={styles.cohort}
                  title={strategy.comparisonCohortId ?? "未绑定冻结 cohort"}
                >
                  {strategy.comparisonCohortId ? strategy.comparisonCohortId.slice(-6) : "unbound"}
                </span>
                <span style={styles.stageLine}>
                  {(["backtest", "walk_forward", "holdout", "paper", "live"] as const).map(
                    (stage) => (
                      <span
                        key={stage}
                        style={stageStyle(strategy.stages[stage]?.pass)}
                        title={stage}
                      >
                        {stage === "walk_forward" ? "WF" : stage.slice(0, 2).toUpperCase()}
                      </span>
                    )
                  )}
                </span>
                <span style={styles.statusText}>
                  {strategy.promotionState === "live_approved"
                    ? "已获实盘批准"
                    : strategy.candidateForManualPromotion
                      ? "待人工审核"
                      : strategy.missingStages.length
                        ? `缺 ${strategy.missingStages.join(" / ")}`
                        : "存在未通过前置项"}
                </span>
              </div>
            ))}
          </ReviewColumn>
          <ReviewColumn title="组件证据" empty="尚无冻结组件评测。">
            {data.components.map((component) => (
              <div
                key={`${component.componentKind}:${component.componentId}:${component.comparisonCohortId}`}
                style={styles.reviewRow}
              >
                <span style={styles.kind}>{component.componentKind}</span>
                <code style={styles.code}>{component.componentId}</code>
                <span style={styles.statusText}>
                  {component.promotionState === "manual_review_required"
                    ? "待人工审核"
                    : `待 ${component.evalKinds.includes("offline") ? "shadow/paper" : "offline"}`}
                </span>
              </div>
            ))}
          </ReviewColumn>
        </div>
      ) : null}
    </details>
  );
};

const ReviewColumn: FC<{ title: string; empty: string; children: ReactNode }> = ({
  title,
  empty,
  children,
}) => {
  const entries = Array.isArray(children) ? children : [children];
  return (
    <section style={styles.reviewColumn}>
      <div style={styles.reviewColumnTitle}>{title}</div>
      {entries.length ? entries : <div style={styles.reviewState}>{empty}</div>}
    </section>
  );
};

function stageStyle(pass: boolean | null | undefined): CSSProperties {
  return {
    ...styles.stage,
    color:
      pass === true
        ? "var(--qb-success)"
        : pass === false
          ? "var(--qb-danger)"
          : "var(--qb-text-muted)",
    borderColor:
      pass === true
        ? "var(--qb-success)"
        : pass === false
          ? "var(--qb-danger)"
          : "var(--qb-border-subtle)",
  };
}

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
  review: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 8,
    background: "var(--qb-bg-elevated)",
  },
  reviewSummary: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 650,
  },
  reviewHint: { color: "var(--qb-text-muted)", fontSize: 11, fontWeight: 400 },
  reviewGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    borderTop: "1px solid var(--qb-border-subtle)",
  },
  reviewColumn: { minWidth: 0, padding: 12 },
  reviewColumnTitle: {
    color: "var(--qb-text-muted)",
    fontSize: 10,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    marginBottom: 8,
  },
  reviewRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minHeight: 30,
    borderTop: "1px solid color-mix(in srgb, var(--qb-border-subtle) 65%, transparent)",
    fontSize: 11,
  },
  reviewState: { padding: "10px 12px", color: "var(--qb-text-muted)", fontSize: 11 },
  code: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 10,
    flex: "1 1 auto",
  },
  kind: { color: "var(--qb-quant-accent-2)", fontSize: 10, flex: "0 0 auto" },
  cohort: {
    color: "var(--qb-text-muted)",
    fontFamily: "var(--qb-font-mono)",
    fontSize: 9,
    flex: "0 0 auto",
  },
  stageLine: { display: "flex", gap: 3, flex: "0 0 auto" },
  stage: {
    minWidth: 20,
    padding: "1px 3px",
    border: "1px solid",
    borderRadius: 3,
    fontSize: 8,
    textAlign: "center",
  },
  statusText: {
    color: "var(--qb-text-muted)",
    fontSize: 10,
    flex: "0 1 125px",
    textAlign: "right",
  },
};
