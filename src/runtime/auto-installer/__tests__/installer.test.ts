/**
 * P8 AutoInstaller worker + lifecycle 集成测：
 *   1) runOnce：无 gap → 0；有 gap with 候选 → proposal(pending_review) + gap→proposed
 *   2) runOnce：gap 无候选 → proposal(no_candidate) + gap 维持 open
 *   3) runOnce：同 gap 重跑 → skipped_existing
 *   4) emit maintenance_run/auto_installer event
 *   5) approveProposal：proposal→approved + gap→installed
 *   6) rejectProposal：proposal→rejected + gap(proposed→rejected)
 *   7) reject 在 no_candidate 上：proposal→rejected，gap 不动（仍 open）
 *   8) approve 非 pending_review → throw ProposalStateError
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
  project,
  toolGapLog,
  workspace,
} from "../../../db/sqlite/schema";
import { getExperienceBus } from "../../experience/experience-bus";
import type { ExperienceEvent } from "../../experience/experience-bus";
import { AutoInstaller } from "../installer";
import { approveProposal, ProposalStateError, rejectProposal } from "../lifecycle";

let projectId = "";

async function seedOpenGap(signature: string, kind: "unknown_tool" | "reflective_mention" = "unknown_tool"): Promise<string> {
  const db = await getDb();
  const id = `gap_${randomUUID()}`;
  await db
    .insert(toolGapLog)
    .values({
      id,
      projectId,
      detectionKind: kind,
      gapSignature: signature,
      status: "open",
    })
    .run();
  return id;
}

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p8-installer-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();

  const db = await getDb();
  const workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();
  // Seed mcp_catalog
  await db
    .insert(mcpCatalog)
    .values([
      {
        id: "c_slack",
        slug: "slack",
        name: "Slack",
        description: "Slack chat",
        transport: "stdio",
        riskLevel: "medium",
        defaultToolName: "post_message",
        defaultCapabilitiesJson: ["slack", "chat"],
      },
    ])
    .run();
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(autoInstallProposal).where(eq(autoInstallProposal.projectId, projectId));
  await db.delete(autoInstallerRun).where(eq(autoInstallerRun.projectId, projectId));
  await db.delete(toolGapLog).where(eq(toolGapLog.projectId, projectId));
});

describe("AutoInstaller.runOnce", () => {
  test("无 gap → summary 全 0", async () => {
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.gapsScanned).toBe(0);
    expect(out.proposalsCreated).toBe(0);
    expect(out.status).toBe("completed");
  });

  test("有候选 gap → 写 proposal(pending_review)，gap→proposed", async () => {
    const gapId = await seedOpenGap("mcp:slack/post_message");
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.gapsScanned).toBe(1);
    expect(out.proposalsCreated).toBe(1);
    expect(out.proposalsNoCandidate).toBe(0);

    const db = await getDb();
    const props = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    expect(props.length).toBe(1);
    expect(props[0]!.state).toBe("pending_review");
    expect(props[0]!.proposalKind).toBe("install_mcp_catalog");
    expect(props[0]!.targetSlug).toBe("slack");
    expect(props[0]!.matchScore).toBeGreaterThanOrEqual(0.3);

    const gap = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId)).all();
    expect(gap[0]!.status).toBe("proposed");
    expect(gap[0]!.statusBy).toBe("auto_installer");
  });

  test("无候选 gap → proposal(no_candidate)，gap 维持 open", async () => {
    const gapId = await seedOpenGap("tool:send_email_via_xyz_unknown");
    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.gapsScanned).toBe(1);
    expect(out.proposalsCreated).toBe(0);
    expect(out.proposalsNoCandidate).toBe(1);

    const db = await getDb();
    const props = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    expect(props.length).toBe(1);
    expect(props[0]!.state).toBe("no_candidate");
    expect(props[0]!.proposalKind).toBe("no_candidate");
    const gap = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId)).all();
    expect(gap[0]!.status).toBe("open");
  });

  test("已有 pending_review proposal → skipped_existing", async () => {
    const gapId = await seedOpenGap("mcp:slack/post_message");
    const db = await getDb();
    // 先手插一个 pending_review proposal，再把 gap 回退到 open 模拟"重跑"
    await db
      .insert(autoInstallProposal)
      .values({
        id: "prop_existing",
        projectId,
        gapLogId: gapId,
        proposalKind: "install_mcp_catalog",
        state: "pending_review",
        targetKind: "mcp_catalog",
        targetId: "c_slack",
        targetSlug: "slack",
      })
      .run();
    await db.update(toolGapLog).set({ status: "open" }).where(eq(toolGapLog.id, gapId));

    const out = await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    expect(out.gapsScanned).toBe(1);
    expect(out.proposalsSkippedExisting).toBe(1);
    expect(out.proposalsCreated).toBe(0);

    const props = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    expect(props.length).toBe(1);
  });

  test("emit maintenance_run/auto_installer", async () => {
    await seedOpenGap("mcp:slack/post_message");
    const bus = getExperienceBus();
    const events: ExperienceEvent[] = [];
    const off = bus.subscribe("maintenance_run", (e) => {
      events.push(e);
    });
    try {
      await new AutoInstaller().runOnce({ projectId });
      await bus.awaitIdle();
    } finally {
      off();
    }
    const ev = events.find((e) => e.type === "maintenance_run" && e.kind === "auto_installer");
    expect(ev).toBeDefined();
    expect((ev as { summary: Record<string, unknown> }).summary["proposalsCreated"]).toBe(1);
  });
});

describe("lifecycle approve/reject", () => {
  test("approve：proposal→approved + gap→installed", async () => {
    const gapId = await seedOpenGap("mcp:slack/post_message");
    await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    const db = await getDb();
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    const r = await approveProposal({ proposalId: p!.id, actor: "tester" });
    expect(r.toState).toBe("approved");
    expect(r.gapStatusChanged).toBe(true);

    const [p2] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.id, p!.id))
      .all();
    expect(p2!.state).toBe("approved");
    expect(p2!.stateBy).toBe("tester");

    const [g2] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId)).all();
    expect(g2!.status).toBe("installed");
  });

  test("reject pending_review：proposal→rejected + gap→rejected", async () => {
    const gapId = await seedOpenGap("mcp:slack/post_message");
    await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    const db = await getDb();
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    const r = await rejectProposal({ proposalId: p!.id, actor: "tester", reason: "low value" });
    expect(r.toState).toBe("rejected");
    expect(r.gapStatusChanged).toBe(true);

    const [g] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId)).all();
    expect(g!.status).toBe("rejected");
  });

  test("reject no_candidate：proposal→rejected，gap 维持 open", async () => {
    const gapId = await seedOpenGap("tool:unknown_xyz_tool");
    await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    const db = await getDb();
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    expect(p!.state).toBe("no_candidate");
    const r = await rejectProposal({ proposalId: p!.id, actor: "tester" });
    expect(r.toState).toBe("rejected");
    expect(r.gapStatusChanged).toBe(false);

    const [g] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, gapId)).all();
    expect(g!.status).toBe("open");
  });

  test("approve 已 approved → ProposalStateError", async () => {
    const gapId = await seedOpenGap("mcp:slack/post_message");
    await new AutoInstaller().runOnce({ projectId, emitMetrics: false });
    const db = await getDb();
    const [p] = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    await approveProposal({ proposalId: p!.id, actor: "tester" });
    await expect(approveProposal({ proposalId: p!.id, actor: "tester" })).rejects.toThrow(
      ProposalStateError
    );
  });
});
