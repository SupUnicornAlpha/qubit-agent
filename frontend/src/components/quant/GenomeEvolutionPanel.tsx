import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  evolveGenePool,
  initGenePool,
  listGeneGenerations,
  listGeneTrends,
  listGenomes,
} from "../../api/backend";
import type { GeneGenerationRecord, GeneTrendPoint, StrategyGenomeRecord } from "../../api/types";

const numberFrom = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const evaluationOf = (genome: StrategyGenomeRecord) => {
  const raw = genome.evaluationJson;
  const failedGates = Array.isArray(raw?.failedGates)
    ? raw.failedGates.filter((item): item is string => typeof item === "string")
    : [];
  return {
    eligible: raw?.eligible === true,
    failedGates,
    sampleSize: numberFrom(raw?.sampleSize),
  };
};

const percent = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;

/**
 * 基因池是策略自进化的审计面：显示实际适应度、准入状态和拒绝原因，而不是把 Sharpe
 * 误当作唯一的进化依据。它没有绕过后端准入规则；手动进化失败也会保留原因。
 */
export const GenomeEvolutionPanel: FC<{ projectId: string }> = ({ projectId }) => {
  const [generations, setGenerations] = useState<GeneGenerationRecord[]>([]);
  const [trends, setTrends] = useState<GeneTrendPoint[]>([]);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [genomes, setGenomes] = useState<StrategyGenomeRecord[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"init" | "evolve" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [generationRows, trendRows] = await Promise.all([
      listGeneGenerations(projectId),
      listGeneTrends(projectId),
    ]);
    setGenerations(generationRows);
    setTrends(trendRows);
    setGenerationId((current) => {
      if (current && generationRows.some((generation) => generation.id === current)) return current;
      return generationRows[0]?.id ?? null;
    });
  }, [projectId]);

  useEffect(() => {
    void reload().catch((reason) =>
      setError(reason instanceof Error ? reason.message : "gene_pool_load_failed")
    );
  }, [reload]);

  useEffect(() => {
    if (!generationId) {
      setGenomes([]);
      return;
    }
    void listGenomes(generationId)
      .then(setGenomes)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "genome_load_failed"));
  }, [generationId]);

  const selectedGeneration =
    generations.find((generation) => generation.id === generationId) ?? null;
  const selectedTrend = trends.find((trend) => trend.generationId === generationId) ?? null;
  const eligibleCount = useMemo(
    () => genomes.filter((genome) => evaluationOf(genome).eligible).length,
    [genomes]
  );

  const initialize = async () => {
    setBusy("init");
    setError(null);
    try {
      const created = await initGenePool({ projectId, populationSize: 8, mutationRate: 0.12 });
      await reload();
      setGenerationId(created.generationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "gene_pool_init_failed");
    } finally {
      setBusy(null);
    }
  };

  const evolve = async () => {
    setBusy("evolve");
    setError(null);
    try {
      const created = await evolveGenePool(projectId);
      await reload();
      setGenerationId(created.generationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "gene_evolution_blocked");
    } finally {
      setBusy(null);
    }
  };

  if (generations.length === 0) {
    return (
      <section className="qb-quant-hero-card" style={styles.panel}>
        <div style={styles.header}>
          <div>
            <strong>自进化 / 基因池</strong>
            <div className="qb-quant-detail-meta" style={styles.meta}>
              只有完成全维回测并通过准入的策略才会参与父本选择。
            </div>
          </div>
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--primary"
            onClick={() => void initialize()}
            disabled={busy !== null}
          >
            {busy === "init" ? "初始化中…" : "初始化 8 个体"}
          </button>
        </div>
        {error ? <div style={styles.error}>{error}</div> : null}
      </section>
    );
  }

  return (
    <section className="qb-quant-hero-card" style={styles.panel}>
      <div style={styles.header}>
        <div>
          <strong>自进化 / 基因池</strong>
          <div className="qb-quant-detail-meta" style={styles.meta}>
            适应度由收益、风险调整收益、尾部风险、稳定性、基准相对表现和容量共同决定。
          </div>
        </div>
        <button
          type="button"
          className="qb-quant-btn qb-quant-btn--primary"
          onClick={() => void evolve()}
          disabled={busy !== null || eligibleCount < 2}
          title={
            eligibleCount < 2
              ? "当前代至少需要 2 个通过多维准入的策略"
              : "仅从通过准入的父本生成下一代"
          }
        >
          {busy === "evolve" ? "进化中…" : "生成下一代"}
        </button>
      </div>

      <div style={styles.summary}>
        <label style={styles.selectLabel}>
          当前世代
          <select
            value={generationId ?? ""}
            onChange={(event) => setGenerationId(event.target.value || null)}
            style={styles.select}
          >
            {generations.map((generation) => (
              <option key={generation.id} value={generation.id}>
                Gen {generation.generationNumber} · {generation.populationSize} 个体
              </option>
            ))}
          </select>
        </label>
        <EvolutionStat
          label="通过准入"
          value={`${eligibleCount}/${genomes.length}`}
          tone="success"
        />
        <EvolutionStat
          label="最佳适应度"
          value={selectedGeneration?.bestFitness?.toFixed(1) ?? "—"}
        />
        <EvolutionStat label="平均适应度" value={selectedTrend?.avgFitness?.toFixed(1) ?? "—"} />
        <EvolutionStat
          label="最佳 Sharpe"
          value={selectedGeneration?.bestSharpe?.toFixed(2) ?? "—"}
        />
      </div>

      {error ? <div style={styles.error}>{error}</div> : null}
      <div style={styles.list}>
        {genomes.map((genome) => {
          const evaluation = evaluationOf(genome);
          const expanded = expandedId === genome.id;
          return (
            <div key={genome.id} style={styles.row}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : genome.id)}
                style={styles.rowButton}
                aria-expanded={expanded}
              >
                <span style={styles.name}>{genome.name}</span>
                <span
                  style={{
                    ...styles.status,
                    color: evaluation.eligible
                      ? "var(--qb-success, #36ad6a)"
                      : "var(--qb-warning, #d99a32)",
                  }}
                >
                  {evaluation.eligible ? "可进化" : genome.evaluationJson ? "未准入" : "待回测"}
                </span>
                <span style={styles.score}>{genome.fitnessScore?.toFixed(1) ?? "—"}</span>
                <span style={styles.miniMetric}>S {genome.sharpeRatio?.toFixed(2) ?? "—"}</span>
                <span style={styles.miniMetric}>DD {percent(genome.maxDrawdown)}</span>
              </button>
              {expanded ? (
                <div style={styles.detail}>
                  <span>样本 {evaluation.sampleSize ?? "—"}</span>
                  <span>总收益 {percent(genome.totalReturn)}</span>
                  {evaluation.failedGates.length > 0 ? (
                    <span title={evaluation.failedGates.join(" · ")}>
                      阻断：{evaluation.failedGates.join(" · ")}
                    </span>
                  ) : (
                    <span>已满足多维准入门槛</span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
};

const EvolutionStat: FC<{ label: string; value: string; tone?: "success" }> = ({
  label,
  value,
  tone,
}) => (
  <div style={styles.stat}>
    <span style={styles.statLabel}>{label}</span>
    <strong style={{ color: tone === "success" ? "var(--qb-success, #36ad6a)" : undefined }}>
      {value}
    </strong>
  </div>
);

const styles: Record<string, CSSProperties> = {
  panel: { display: "flex", flexDirection: "column", gap: 10 },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  meta: { marginTop: 4 },
  summary: {
    display: "grid",
    gridTemplateColumns: "minmax(160px, 1.3fr) repeat(4, minmax(88px, 1fr))",
    gap: 6,
  },
  selectLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 10,
    color: "var(--qb-text-muted)",
  },
  select: {
    fontSize: 11,
    padding: "5px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  stat: {
    padding: "7px 8px",
    borderLeft: "2px solid var(--qb-border-subtle)",
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  statLabel: { color: "var(--qb-text-muted)", fontSize: 10 },
  list: { borderTop: "1px solid var(--qb-border-subtle)" },
  row: { borderBottom: "1px solid var(--qb-border-subtle)" },
  rowButton: {
    width: "100%",
    display: "grid",
    gridTemplateColumns: "minmax(110px, 1.4fr) 66px 52px 64px 70px",
    gap: 8,
    alignItems: "center",
    border: 0,
    padding: "8px 2px",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 11,
  },
  name: { fontFamily: "var(--qb-font-mono, ui-monospace, monospace)" },
  status: { fontWeight: 600, fontSize: 10 },
  score: { fontFamily: "var(--qb-font-mono, ui-monospace, monospace)", textAlign: "right" },
  miniMetric: {
    color: "var(--qb-text-muted)",
    fontFamily: "var(--qb-font-mono, ui-monospace, monospace)",
    textAlign: "right",
  },
  detail: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px 12px",
    padding: "0 2px 8px",
    color: "var(--qb-text-muted)",
    fontSize: 10,
  },
  error: { color: "var(--qb-danger, #dc5d62)", fontSize: 11, padding: "6px 0" },
};
