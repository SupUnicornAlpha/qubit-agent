import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, mcpServerConfig, sandboxPolicy } from "../../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "../types";
import {
  getFsiConfigSnapshot,
  isFsiActive,
  resolveEnabledFsiBundles,
  shouldApplyFsiAgentMappings,
  shouldSeedFsiMcpCatalog,
} from "./fsi-config";
import { loadFsiManifest } from "./fsi-manifest-loader";
import { mergeFsiSkillsForRole } from "./fsi-prompt-enricher";

export async function seedFsiSandboxPresets(): Promise<number> {
  const manifest = await loadFsiManifest();
  const db = await getDb();
  let n = 0;
  for (const preset of Object.values(manifest.sandboxPresets)) {
    const existing = await db
      .select()
      .from(sandboxPolicy)
      .where(eq(sandboxPolicy.id, preset.name))
      .limit(1);
    const row = {
      id: preset.name,
      name: preset.name,
      description: preset.description,
      allowedToolsJson: preset.denyWriteTools ? [] : ["read", "grep"],
      allowedMcpServersJson: preset.denyMcp ? [] : ["*"],
      allowedConnectorsJson: [],
      allowedHostsJson: [],
      allowedFsPathsJson: [],
      canWriteMemory: preset.canWriteMemory,
      canReadLiveMarket: preset.canReadLiveMarket,
      canSubmitOrder: preset.canSubmitOrder,
      maxToolCallMs: 30_000,
      maxIterationsPerRun: preset.maxIterationsPerRun,
      maxOutputTokens: preset.maxOutputTokens,
      isolationLevel: preset.isolationLevel,
    };
    if (existing[0]) {
      await db.update(sandboxPolicy).set(row).where(eq(sandboxPolicy.id, preset.name));
    } else {
      await db.insert(sandboxPolicy).values(row);
    }
    n += 1;
  }
  return n;
}

export async function seedFsiMcpCatalog(): Promise<number> {
  if (!shouldSeedFsiMcpCatalog()) return 0;
  const manifest = await loadFsiManifest();
  const db = await getDb();
  let n = 0;
  for (const entry of manifest.mcpCatalog) {
    const url =
      (entry.envVar ? process.env[entry.envVar]?.trim() : undefined) || entry.url || null;
    const existing = await db
      .select()
      .from(mcpServerConfig)
      .where(and(eq(mcpServerConfig.name, entry.name), isNull(mcpServerConfig.projectId)))
      .limit(1);
    const caps = {
      description: entry.description,
      vertical: entry.vertical,
      source: "anthropic-fsi-catalog",
      envVar: entry.envVar,
    };
    if (existing[0]) {
      await db
        .update(mcpServerConfig)
        .set({
          transport: entry.transport,
          url: url ?? existing[0].url,
          command: entry.command ?? existing[0].command,
          capabilitiesJson: caps,
          enabled: false,
        })
        .where(eq(mcpServerConfig.id, existing[0].id));
    } else {
      await db.insert(mcpServerConfig).values({
        id: randomUUID(),
        name: entry.name,
        projectId: null,
        transport: entry.transport,
        command: entry.command ?? null,
        url,
        capabilitiesJson: caps,
        enabled: false,
      });
    }
    n += 1;
  }
  return n;
}

/** 将 FSI bundle 技能合并进内置 agent 的 skillsJson（仅当 FSI 启用且 applyAgentMappings） */
export async function applyFsiAgentSkillMappings(
  definitions: RuntimeAgentDefinition[]
): Promise<void> {
  if (!isFsiActive() || !shouldApplyFsiAgentMappings()) return;
  const db = await getDb();
  const manifest = await loadFsiManifest();

  for (const def of definitions) {
    const merged = await mergeFsiSkillsForRole(def.role, def.skills);
    if (merged.length === def.skills.length && merged.every((s, i) => s === def.skills[i])) {
      continue;
    }
    await db
      .update(agentDefinition)
      .set({ skillsJson: merged, updatedAt: new Date().toISOString() })
      .where(eq(agentDefinition.id, def.id));
  }

  for (const wf of Object.values(manifest.agentWorkflows)) {
    if (!wf.sandboxPreset) continue;
    for (const role of wf.fuseIntoRoles) {
      const defs = definitions.filter((d) => d.role === role);
      for (const d of defs) {
        if (d.sandboxPolicyId === wf.sandboxPreset) continue;
        await db
          .update(agentDefinition)
          .set({
            sandboxPolicyId: wf.sandboxPreset!,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(agentDefinition.id, d.id));
      }
    }
  }
}

export async function runFsiSeedIntegration(
  definitions: RuntimeAgentDefinition[]
): Promise<void> {
  const presets = await seedFsiSandboxPresets();
  const mcps = await seedFsiMcpCatalog();
  if (isFsiActive()) {
    await applyFsiAgentSkillMappings(definitions);
    const snap = getFsiConfigSnapshot();
    const bundles = resolveEnabledFsiBundles();
    console.log(
      `[Seed][FSI] Active bundles: ${bundles.join(", ")}; ` +
        `content: ${snap.contentRootResolved ?? "missing — run scripts/sync-fsi-vendor.sh"}; ` +
        `sandbox presets: ${presets}; MCP catalog: ${mcps} (disabled by default).`
    );
  } else {
    console.log(
      `[Seed][FSI] Disabled (edit content-packs/anthropic-fsi/settings.json or set QUBIT_FSI_DISABLED=true). ` +
        `Registered ${presets} sandbox preset(s), ${mcps} MCP catalog row(s).`
    );
  }
}
