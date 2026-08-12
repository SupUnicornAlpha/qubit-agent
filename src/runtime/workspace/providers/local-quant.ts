/**
 * builtin.local_quant — 将工坊因子/策略版本投影到 Workspace FS。
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { factorDefinition, strategy, strategyVersion } from "../../../db/sqlite/schema";
import type { DecisionEngineProvider } from "./resolve";

function slugFile(name: string, id: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${base || "item"}-${id.slice(0, 8)}`;
}

export function createLocalQuantDecisionProvider(): DecisionEngineProvider {
  return {
    kind: "builtin.local_quant",

    async listStrategies(ws) {
      const tree = await ws.listTree({ maxDepth: 5 });
      const folder = tree.children
        ?.find((c) => c.name === "decision")
        ?.children?.find((c) => c.name === "strategies");
      return (folder?.children ?? [])
        .filter((n) => n.kind !== "folder")
        .map((n) => ({
          id: n.relPath || n.id,
          name: n.name,
          relPath: n.relPath,
        }));
    },

    async listFactors(ws) {
      const tree = await ws.listTree({ maxDepth: 5 });
      const folder = tree.children
        ?.find((c) => c.name === "research")
        ?.children?.find((c) => c.name === "factors");
      return (folder?.children ?? [])
        .filter((n) => n.kind !== "folder")
        .map((n) => ({
          id: n.relPath || n.id,
          name: n.name,
          relPath: n.relPath,
        }));
    },

    async openStrategy(_ws, id) {
      return { relPath: id.startsWith("decision/") ? id : undefined };
    },

    async syncIntoWorkspace(ws, opts) {
      const db = await getDb();
      let factorCount = 0;
      let strategyCount = 0;
      try {
        const factors = await db
          .select()
          .from(factorDefinition)
          .where(eq(factorDefinition.projectId, opts.projectId))
          .orderBy(desc(factorDefinition.updatedAt))
          .limit(80);

        for (const f of factors) {
          const rel = `research/factors/${slugFile(f.name || f.id, f.id)}.json`;
          await ws.writeJson(rel, {
            schemaVersion: 1,
            id: f.id,
            name: f.name,
            category: f.category,
            expr: f.expr,
            lang: f.lang,
            status: f.status,
            updatedAt: f.updatedAt,
            source: "builtin.local_quant",
          });
          factorCount += 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such table/i.test(msg)) throw e;
      }

      try {
        const versions = await db
          .select({
            id: strategyVersion.id,
            strategyId: strategyVersion.strategyId,
            versionTag: strategyVersion.versionTag,
            createdAt: strategyVersion.createdAt,
            strategyName: strategy.name,
          })
          .from(strategyVersion)
          .innerJoin(strategy, eq(strategy.id, strategyVersion.strategyId))
          .where(eq(strategy.projectId, opts.projectId))
          .orderBy(desc(strategyVersion.createdAt))
          .limit(80);

        for (const v of versions) {
          const label = `${v.strategyName || "strategy"}-${v.versionTag || v.id}`;
          const rel = `decision/strategies/${slugFile(label, v.id)}.json`;
          await ws.writeJson(rel, {
            schemaVersion: 1,
            id: v.id,
            strategyId: v.strategyId,
            strategyName: v.strategyName,
            versionTag: v.versionTag,
            createdAt: v.createdAt,
            source: "builtin.local_quant",
          });
          strategyCount += 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/no such table/i.test(msg)) throw e;
      }

      return { factorCount, strategyCount };
    },
  };
}
