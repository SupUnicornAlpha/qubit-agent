/**
 * W3（2026-06-11）：AutoInstaller 集成 safety-scan + dry-run 路径覆盖。
 *
 * 思路：
 *   - 在 mcp_catalog 里 seed 两个候选：一个 source='registry' 命令含 `rm -rf`（应被 safety block），
 *     一个 source='registry' 干净命令但 mock dry-runner 返回 ok=false（应被 dry-run block）。
 *   - 验证 actions log 里出现 safety_blocked / dry_run_failed，proposal 落 no_candidate。
 *   - 第三个 case：第一个候选 safety reject、第二个候选干净 → 拿第二个 propose。
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import type { DryRunFn } from "../dry-run-sandbox";
import { AutoInstaller } from "../installer";

let projectId = "";

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
  const tmp = join("/tmp", `qubit-w3-installer-${Date.now()}-${randomUUID().slice(0, 8)}`);
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

  await db
    .insert(mcpCatalog)
    .values([
      {
        id: "c_evil",
        slug: "evil-mcp",
        name: "Evil MCP (registry)",
        description: "fake registry pkg with rm -rf",
        source: "registry",
        riskLevel: "low",
        transport: "stdio",
        command: "npx -y evil-mcp && rm -rf /tmp/x",
        defaultToolName: "evil_tool",
        defaultCapabilitiesJson: ["evil"],
      },
      {
        id: "c_dryrun_fail",
        slug: "dryrun-fail",
        name: "Dryrun Fail",
        description: "registry pkg whose dry-run fails",
        source: "registry",
        riskLevel: "low",
        transport: "stdio",
        command: "npx -y @good/mcp",
        defaultToolName: "dryrun_fail_tool",
        defaultCapabilitiesJson: ["dryrun"],
      },
      {
        id: "c_clean_registry",
        slug: "clean-registry",
        name: "Clean Registry",
        description: "registry pkg that passes both safety & dry-run",
        source: "registry",
        riskLevel: "low",
        transport: "stdio",
        command: "npx -y @clean/mcp",
        defaultToolName: "clean_tool",
        defaultCapabilitiesJson: ["clean"],
      },
      // builtin 候选用于对照：跳过 safety / dry-run
      {
        id: "c_builtin",
        slug: "builtin-good",
        name: "Builtin Good",
        description: "builtin pkg",
        source: "builtin",
        riskLevel: "low",
        transport: "stdio",
        command: "npx -y @builtin/mcp",
        defaultToolName: "builtin_tool",
        defaultCapabilitiesJson: ["builtin"],
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

describe("AutoInstaller · W3 safety-scan + dry-run 集成", () => {
  test("唯一候选含 rm -rf → safety blocked → proposal(no_candidate) + actions 留痕", async () => {
    const gapId = await seedOpenGap("mcp:evil-mcp/evil_tool");
    const installer = new AutoInstaller({
      // dryRunner 不应被调到（safety 已经 block）；如果调到就报错
      dryRunner: async () => {
        throw new Error("dryRunner should not be called when safety blocks");
      },
    });
    const out = await installer.runOnce({ projectId, emitMetrics: false });

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

    const run = await db
      .select()
      .from(autoInstallerRun)
      .where(eq(autoInstallerRun.id, out.runId))
      .all();
    const actions = run[0]!.actionsJson as Array<{ action: string; blockers?: string[] }>;
    expect(actions.some((a) => a.action === "safety_blocked")).toBe(true);
    const blocked = actions.find((a) => a.action === "safety_blocked")!;
    expect(blocked.blockers?.some((b) => b.includes("rm_recursive"))).toBe(true);
  });

  test("dryRunner 返回 ok=false → dry_run_failed → proposal(no_candidate)", async () => {
    await seedOpenGap("mcp:dryrun-fail/dryrun_fail_tool");
    const dry: DryRunFn = async () => ({
      ok: false,
      reason: "spawn timed out",
      executed: true,
      elapsedMs: 10_001,
    });
    const installer = new AutoInstaller({ dryRunner: dry });
    const out = await installer.runOnce({ projectId, emitMetrics: false });

    expect(out.proposalsCreated).toBe(0);
    expect(out.proposalsNoCandidate).toBe(1);

    const db = await getDb();
    const run = await db
      .select()
      .from(autoInstallerRun)
      .where(eq(autoInstallerRun.id, out.runId))
      .all();
    const actions = run[0]!.actionsJson as Array<{ action: string; reason?: string }>;
    expect(actions.some((a) => a.action === "dry_run_failed")).toBe(true);
    const failed = actions.find((a) => a.action === "dry_run_failed")!;
    expect(failed.reason).toContain("spawn timed out");
  });

  test("registry 候选通过 safety + dry-run → 正常 propose(install_mcp_external)", async () => {
    const gapId = await seedOpenGap("mcp:clean-registry/clean_tool");
    const installer = new AutoInstaller(); // 默认 dryRunner = ok=true 占位
    const out = await installer.runOnce({ projectId, emitMetrics: false });

    expect(out.proposalsCreated).toBe(1);
    expect(out.proposalsNoCandidate).toBe(0);
    const db = await getDb();
    const props = await db
      .select()
      .from(autoInstallProposal)
      .where(eq(autoInstallProposal.gapLogId, gapId))
      .all();
    expect(props[0]!.state).toBe("pending_review");
    expect(props[0]!.proposalKind).toBe("install_mcp_external");
    expect(props[0]!.targetSlug).toBe("clean-registry");
  });

  test("builtin 候选完全跳过 safety/dry-run（命令含 rm -rf 也不 block）", async () => {
    const db = await getDb();
    // 临时把 builtin 候选 command 改成含 rm -rf —— 验证 W3 不会误伤 builtin
    await db
      .update(mcpCatalog)
      .set({ command: "npx -y @builtin/mcp && rm -rf /tmp/x" })
      .where(eq(mcpCatalog.id, "c_builtin"));

    await seedOpenGap("mcp:builtin-good/builtin_tool");
    const installer = new AutoInstaller({
      // 即使 dryRunner 失败也不该被调到（builtin 路径 short-circuit）
      dryRunner: async () => {
        throw new Error("dryRunner should not be called for builtin");
      },
    });
    const out = await installer.runOnce({ projectId, emitMetrics: false });
    expect(out.proposalsCreated).toBe(1);

    // 还原 builtin command 防干扰其它测
    await db
      .update(mcpCatalog)
      .set({ command: "npx -y @builtin/mcp" })
      .where(eq(mcpCatalog.id, "c_builtin"));
  });
});
