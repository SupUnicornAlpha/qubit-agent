import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { geneGeneration, strategyGenome } from "../../db/sqlite/schema";

export interface InitGenePoolInput {
  projectId: string;
  populationSize?: number;
  mutationRate?: number;
}

export async function initGenePool(input: InitGenePoolInput) {
  const db = await getDb();
  const populationSize = Math.max(3, Math.min(20, input.populationSize ?? 8));
  const mutationRate = Math.max(0.01, Math.min(0.5, input.mutationRate ?? 0.12));

  const generationId = randomUUID();
  await db.insert(geneGeneration).values({
    id: generationId,
    projectId: input.projectId,
    generationNumber: 1,
    populationSize,
    mutationRate,
    bestSharpe: null,
  });

  for (let i = 0; i < populationSize; i++) {
    const snapshot = {
      factorWeightMomentum: Number((0.3 + Math.random() * 0.4).toFixed(3)),
      factorWeightValue: Number((0.2 + Math.random() * 0.4).toFixed(3)),
      stopLossPct: Number((0.04 + Math.random() * 0.1).toFixed(3)),
      takeProfitPct: Number((0.08 + Math.random() * 0.2).toFixed(3)),
    };
    await db.insert(strategyGenome).values({
      id: randomUUID(),
      projectId: input.projectId,
      generationId,
      name: `gen1-${i + 1}`,
      genesSnapshotJson: snapshot,
      isActive: i === 0,
    });
  }

  return { generationId, generationNumber: 1, populationSize };
}

export async function applyBacktestResult(input: {
  genomeId: string;
  backtestRunId?: string;
  sharpeRatio: number;
  maxDrawdown: number;
  totalReturn: number;
}) {
  const db = await getDb();
  await db
    .update(strategyGenome)
    .set({
      sharpeRatio: input.sharpeRatio,
      maxDrawdown: input.maxDrawdown,
      totalReturn: input.totalReturn,
      backtestRunId: input.backtestRunId ?? null,
    })
    .where(eq(strategyGenome.id, input.genomeId));

  const rows = await db
    .select({
      generationId: strategyGenome.generationId,
      sharpeRatio: strategyGenome.sharpeRatio,
    })
    .from(strategyGenome)
    .where(eq(strategyGenome.id, input.genomeId))
    .limit(1);
  const generationId = rows[0]?.generationId;
  if (!generationId) return { ok: true };

  const best = await db
    .select({ bestSharpe: sql<number>`MAX(${strategyGenome.sharpeRatio})` })
    .from(strategyGenome)
    .where(eq(strategyGenome.generationId, generationId));

  await db
    .update(geneGeneration)
    .set({ bestSharpe: best[0]?.bestSharpe ?? null })
    .where(eq(geneGeneration.id, generationId));

  // 自动周期演化：当本代已完成回测数量 >= populationSize 时，自动触发下一代
  const generationRow = await db
    .select()
    .from(geneGeneration)
    .where(eq(geneGeneration.id, generationId))
    .limit(1);
  const cur = generationRow[0];
  if (!cur) return { ok: true };

  const evaluated = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(strategyGenome)
    .where(eq(strategyGenome.generationId, generationId));
  const evaluatedCnt = Number(evaluated[0]?.cnt ?? 0);
  const nextExist = await db
    .select({ id: geneGeneration.id })
    .from(geneGeneration)
    .where(
      sql`${geneGeneration.projectId} = ${cur.projectId} AND ${geneGeneration.generationNumber} = ${cur.generationNumber + 1}`
    )
    .limit(1);

  let autoEvolved = false;
  let autoNextGenerationNumber: number | null = null;
  if (evaluatedCnt >= cur.populationSize && !nextExist[0]) {
    const evolved = await evolveFromGeneration(cur.id);
    autoEvolved = true;
    autoNextGenerationNumber = evolved.generationNumber;
  }

  return { ok: true, autoEvolved, autoNextGenerationNumber };
}

export async function evolveNextGeneration(input: { projectId: string }) {
  const db = await getDb();
  const latestGeneration = await db
    .select()
    .from(geneGeneration)
    .where(eq(geneGeneration.projectId, input.projectId))
    .orderBy(desc(geneGeneration.generationNumber))
    .limit(1);
  if (!latestGeneration[0]) {
    throw new Error("No generation found. Call init first.");
  }
  return evolveFromGeneration(latestGeneration[0].id);
}

async function evolveFromGeneration(generationId: string) {
  const db = await getDb();
  const currentRows = await db.select().from(geneGeneration).where(eq(geneGeneration.id, generationId)).limit(1);
  const cur = currentRows[0];
  if (!cur) throw new Error("generation not found");
  const genomes = await db
    .select()
    .from(strategyGenome)
    .where(eq(strategyGenome.generationId, cur.id))
    .orderBy(desc(strategyGenome.sharpeRatio));
  if (genomes.length < 2) throw new Error("Need at least 2 genomes to evolve.");

  const top = genomes.slice(0, Math.max(2, Math.floor(genomes.length / 2)));
  const nextGenerationId = randomUUID();
  await db.insert(geneGeneration).values({
    id: nextGenerationId,
    projectId: cur.projectId,
    generationNumber: cur.generationNumber + 1,
    populationSize: cur.populationSize,
    mutationRate: cur.mutationRate,
  });

  for (let i = 0; i < cur.populationSize; i++) {
    // 交叉繁殖：从 top 中挑选父本A/B，按基因位随机继承并做轻微平均融合
    const parentA = top[i % top.length];
    const parentB = top[(i + 1 + Math.floor(Math.random() * top.length)) % top.length];
    const genesA = parentA.genesSnapshotJson as Record<string, number>;
    const genesB = parentB.genesSnapshotJson as Record<string, number>;
    const snapshot: Record<string, number> = {};
    const keys = Array.from(new Set([...Object.keys(genesA), ...Object.keys(genesB)]));
    for (const k of keys) {
      const a = Number(genesA[k] ?? 0);
      const b = Number(genesB[k] ?? a);
      const inherit = Math.random() < 0.5 ? a : b;
      const blend = (a + b) / 2;
      snapshot[k] = Number(((inherit * 0.7 + blend * 0.3)).toFixed(3));
    }
    // 变异
    for (const k of keys) {
      if (Math.random() < cur.mutationRate) {
        const v = Number(snapshot[k]);
        const delta = (Math.random() - 0.5) * 0.1;
        snapshot[k] = Number(Math.max(0.01, Math.min(1.2, v + delta)).toFixed(3));
      }
    }
    await db.insert(strategyGenome).values({
      id: randomUUID(),
      projectId: cur.projectId,
      generationId: nextGenerationId,
      name: `gen${cur.generationNumber + 1}-${i + 1}`,
      genesSnapshotJson: snapshot,
      parentAId: parentA.id,
      parentBId: parentB.id,
      mutationLog: `crossover+mutated@rate=${cur.mutationRate}`,
      isActive: i === 0,
    });
  }
  return { generationId: nextGenerationId, generationNumber: cur.generationNumber + 1 };
}

export async function listGeneGenerations(projectId: string) {
  const db = await getDb();
  return db
    .select()
    .from(geneGeneration)
    .where(eq(geneGeneration.projectId, projectId))
    .orderBy(desc(geneGeneration.generationNumber));
}

export async function listGenomesByGeneration(generationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(strategyGenome)
    .where(eq(strategyGenome.generationId, generationId))
    .orderBy(desc(strategyGenome.sharpeRatio));
}

export async function listGenerationTrends(projectId: string) {
  const db = await getDb();
  const gens = await db
    .select()
    .from(geneGeneration)
    .where(eq(geneGeneration.projectId, projectId))
    .orderBy(geneGeneration.generationNumber);

  const trends = [];
  for (const g of gens) {
    const agg = await db
      .select({
        avgDrawdown: sql<number>`AVG(${strategyGenome.maxDrawdown})`,
        avgSharpe: sql<number>`AVG(${strategyGenome.sharpeRatio})`,
      })
      .from(strategyGenome)
      .where(eq(strategyGenome.generationId, g.id));
    trends.push({
      generationId: g.id,
      generationNumber: g.generationNumber,
      bestSharpe: g.bestSharpe ?? null,
      avgSharpe: agg[0]?.avgSharpe ?? null,
      avgDrawdown: agg[0]?.avgDrawdown ?? null,
      populationSize: g.populationSize,
      createdAt: g.createdAt,
    });
  }
  return trends;
}
