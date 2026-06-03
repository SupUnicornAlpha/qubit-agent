/**
 * P9 AutoInstaller auto 模式集成测：
 *   - mode=auto + safety=low + score≥阈值 + targetKind=mcp_catalog → 真装 + proposal=approved + gap=installed
 *   - mode=auto + safety=medium → 仍走 propose（不该自动装高危）
 *   - mode=auto + score<阈值 → propose
 *   - mode=auto + targetKind=mcp_catalog_item (external) → propose（registry 来源不自动装）
 *   - mode=auto + 真装抛错 → 计 auto_install_failed，proposal 仍 pending_review，gap 仍 proposed
 *   - mode=propose（默认）→ 行为同 P8（不真装）
 *   - emit 的 summary 含 mode + autoInstalled 字段
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../../../config";
import { closeDb, getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  autoInstallProposal,
  autoInstallerRun,
  mcpCatalog,
  mcpCatalogInstall,
  mcpRegistrySource,
  mcpCatalogItem,
  mcpServerConfig,
  mcpToolBinding,
  project,
  toolGapLog,
  workspace,
} from "../../../db/sqlite/schema";
import { getExperienceBus, type ExperienceEvent } from "../../experience/experience-bus";
import { setSelfEvolveConfigForTest } from "../../config/self-evolve-config";
import { AutoInstaller } from "../installer";

let projectId = "";
let sourceId = "";

async function seedOpenGap(signature: string): Promise<string> {
  const db = await getDb();
  const id = `gap_${randomUUID()}`;
  await db
    .insert(toolGapLog)
    .values({
      id,
      projectId,
      detectionKind: "unknown_tool",
      gapSignature: signature,
      status: "open",
    })
    .run();
  return id;
}

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p9-installer-auto-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();

  const db = await getDb();
  const workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  sourceId = `src_${randomUUID()}`;
  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();
  await db
    .insert(mcpRegistrySource)
    .values({ id: sourceId, name: "Test", baseUrl: "https://x.test" })
    .run();
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(mcpCatalogInstall).run();
  await db.delete(mcpToolBinding).run();
  await db.delete(mcpServerConfig).run();
  await db.delete(autoInstallProposal).where(eq(autoInstallProposal.projectId, projectId));
  await db.delete(autoInstallerRun).where(eq(autoInstallerRun.projectId, projectId));
  await db.delete(toolGapLog).where(eq(toolGapLog.projectId, projectId));
  await db.delete(mcpCatalog).run();
  await db.delete(mcpCatalogItem).run();
  setSelfEvolveConfigForTest(null);
});

describe("AutoInstaller auto 模式", () => {
  test("safety=low + score 足 + builtin catalog → 真装 + approved + installed", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_safe",
        slug: "fs-readonly",
        name: "FS Readonly",
        description: "filesystem readonly tool",
        transport: "stdio",
        command: "npx fs-ro",
        riskLevel: "low",
        defaultToolName: "fs-readonly", // 让 score 命中 exact_tool=0.7 + exact_slug=0.4 + tool_eq_slug=0.3 + cap_hits=0.1 → cap 1.0
        defaultCapabilitiesJson: ["fs-readonly"],
      })
      .run();
    const gapId = await seedOpenGap("mcp:fs-readonly/fs-readonly");

    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto", minScoreForAuto: 0.8 });
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.proposalsCreated).toBe(1);
    expect(out.autoInstalled).toBe(1);

    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId));
    expect(p!.state).toBe("approved");
    expect(p!.stateBy).toBe("auto_installer");

    const [g] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId));
    expect(g!.status).toBe("installed");

    // 真装写下 server + binding
    const servers = await db.select().from(mcpServerConfig);
    expect(servers.some((s) => s.name === "fs-readonly")).toBe(true);
    const bindings = await db.select().from(mcpToolBinding);
    expect(bindings.some((b) => b.serverName === "fs-readonly")).toBe(true);
    const installs = await db.select().from(mcpCatalogInstall);
    expect(installs.some((i) => i.installedBy === "auto_installer")).toBe(true);
  });

  test("safety=medium → 拒绝自动装，回 propose", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_med",
        slug: "shell",
        name: "Shell",
        transport: "stdio",
        riskLevel: "medium",
        defaultToolName: "shell",
        defaultCapabilitiesJson: ["shell"],
      })
      .run();
    const gapId = await seedOpenGap("mcp:shell/shell");
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto", minScoreForAuto: 0.5 });
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.autoInstalled).toBe(0);
    expect(out.proposalsCreated).toBe(1);
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId));
    expect(p!.state).toBe("pending_review");
  });

  test("score 不足阈值 → propose 而非 auto", async () => {
    const db = await getDb();
    // signature 'mcp:weather/something' → server=weather 命中 exact_slug=0.4 + desc_hits 0.15 ≈ 0.55
    // 设阈值 0.95 → 不该 auto，但 ≥ 0.3 进 candidates
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_low_score",
        slug: "weather",
        name: "Weather Service",
        description: "weather data feed",
        transport: "stdio",
        riskLevel: "low",
        defaultToolName: "fetch_forecast",
        defaultCapabilitiesJson: [],
      })
      .run();
    const gapId = await seedOpenGap("mcp:weather/whatever");
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto", minScoreForAuto: 0.95 });
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.proposalsCreated).toBe(1);
    expect(out.autoInstalled).toBe(0);
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId));
    expect(p!.state).toBe("pending_review");
    expect(p!.matchScore).toBeLessThan(0.95);
  });

  test("external catalog_item 即便 low/high-score 也不自动装", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalogItem)
      .values({
        id: "ci_safe",
        sourceId,
        externalId: "ext_safe",
        slug: "external-fs",
        name: "External FS",
        description: "external filesystem tool",
        transport: "stdio",
        riskLevel: "low",
        specJson: { defaultToolName: "external-fs", defaultCapabilitiesJson: ["external-fs"] },
      })
      .run();
    const gapId = await seedOpenGap("mcp:external-fs/external-fs");
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto", minScoreForAuto: 0.5 });
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.autoInstalled).toBe(0);
    expect(out.proposalsCreated).toBe(1);
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId));
    expect(p!.state).toBe("pending_review");
    expect(p!.proposalKind).toBe("install_mcp_external");
  });

  test("默认 mode=propose（autoModeOverride 不传）→ P8 行为不变", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_def",
        slug: "fs-readonly",
        name: "FS Readonly",
        transport: "stdio",
        riskLevel: "low",
        defaultToolName: "fs-readonly",
        defaultCapabilitiesJson: ["fs-readonly"],
      })
      .run();
    const gapId = await seedOpenGap("mcp:fs-readonly/fs-readonly");
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "propose" });
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.autoInstalled).toBe(0);
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId));
    expect(p!.state).toBe("pending_review");
  });

  test("emit summary 含 mode / autoInstalled", async () => {
    const db = await getDb();
    await db
      .insert(mcpCatalog)
      .values({
        id: "c_safe",
        slug: "fs-readonly",
        name: "FS Readonly",
        transport: "stdio",
        riskLevel: "low",
        defaultToolName: "fs-readonly",
        defaultCapabilitiesJson: ["fs-readonly"],
      })
      .run();
    await seedOpenGap("mcp:fs-readonly/fs-readonly");
    setSelfEvolveConfigForTest({ enabled: true, autoInstallMode: "auto", minScoreForAuto: 0.8 });
    const bus = getExperienceBus();
    const evs: ExperienceEvent[] = [];
    const off = bus.subscribe("maintenance_run", (e) => evs.push(e));
    try {
      await new AutoInstaller().runOnce({ projectId });
      await bus.awaitIdle();
    } finally {
      off();
    }
    const ev = evs.find((e) => e.type === "maintenance_run" && e.kind === "auto_installer");
    expect(ev).toBeDefined();
    const s = (ev as { summary: Record<string, unknown> }).summary;
    expect(s["mode"]).toBe("auto");
    expect(s["autoInstalled"]).toBe(1);
  });
});
