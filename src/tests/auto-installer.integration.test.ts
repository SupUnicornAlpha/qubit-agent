/**
 * P8 后端路由集成测：
 *   GET   /api/v1/monitor/memory/auto-installer/proposals?projectId=&state=
 *   GET   /api/v1/monitor/memory/auto-installer/runs?projectId=
 *   POST  /api/v1/monitor/memory/auto-installer/proposals/:id/approve  body={reason?}
 *   POST  /api/v1/monitor/memory/auto-installer/proposals/:id/reject   body={reason?}
 *
 * Fixture：1 project + 1 mcp_catalog + 2 open gap，跑一次 AutoInstaller 生成
 *   1 proposal(pending_review) + 1 proposal(no_candidate)，再验流转。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  autoInstallProposal,
  mcpCatalog,
  project,
  toolGapLog,
  workspace,
} from "../db/sqlite/schema";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

let app: { request: (req: Request) => Promise<Response> };
let projectId = "";
let withCandidateProposalId = "";
let noCandidateProposalId = "";
let withCandidateGapId = "";
let noCandidateGapId = "";

beforeAll(async () => {
  const tmp = join("/tmp", `qubit-p8-routes-${Date.now()}-${randomUUID().slice(0, 8)}`);
  await mkdir(tmp, { recursive: true });
  (config as { dataDir: string }).dataDir = tmp;
  closeDb();
  await runMigrations();
  const server = await import("../server");
  app = server.app;

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
    .values({
      id: "c_slack",
      slug: "slack",
      name: "Slack",
      description: "Slack chat",
      transport: "stdio",
      defaultToolName: "post_message",
      defaultCapabilitiesJson: ["slack", "chat"],
    })
    .run();
  withCandidateGapId = `gap_${randomUUID()}`;
  noCandidateGapId = `gap_${randomUUID()}`;
  await db
    .insert(toolGapLog)
    .values([
      {
        id: withCandidateGapId,
        projectId,
        detectionKind: "unknown_tool",
        gapSignature: "mcp:slack/post_message",
        status: "open",
      },
      {
        id: noCandidateGapId,
        projectId,
        detectionKind: "reflective_mention",
        gapSignature: "tool:no_match_xyz_unknown",
        status: "open",
      },
    ])
    .run();

  const { AutoInstaller } = await import("../runtime/auto-installer/installer");
  await new AutoInstaller().runOnce({ projectId, emitMetrics: false });

  const allProps = await db
    .select()
    .from(autoInstallProposal)
    .where(eq(autoInstallProposal.projectId, projectId))
    .all();
  withCandidateProposalId = allProps.find((p) => p.gapLogId === withCandidateGapId)!.id;
  noCandidateProposalId = allProps.find((p) => p.gapLogId === noCandidateGapId)!.id;
});

describe("GET /memory/auto-installer/proposals", () => {
  test("默认 state=pending_review 只回 1 条", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals?projectId=${projectId}`
      )
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { ok: boolean; data: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(1);
    expect((body.data.items[0] as Record<string, unknown>).id).toBe(withCandidateProposalId);
  });

  test("state=no_candidate 过滤", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals?projectId=${projectId}&state=no_candidate`
      )
    );
    const body = (await jsonOf(res)) as { ok: boolean; data: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(1);
    expect((body.data.items[0] as Record<string, unknown>).id).toBe(noCandidateProposalId);
  });

  test("state=all 返回全部 2 条", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals?projectId=${projectId}&state=all`
      )
    );
    const body = (await jsonOf(res)) as { ok: boolean; data: { items: unknown[] } };
    expect(body.data.items.length).toBe(2);
  });

  test("缺 projectId → 400", async () => {
    const res = await app.request(
      new Request("http://x/api/v1/monitor/memory/auto-installer/proposals")
    );
    expect(res.status).toBe(400);
  });

  test("非法 state → 400", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals?projectId=${projectId}&state=garbage`
      )
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /memory/auto-installer/runs", () => {
  test("至少 1 条跑批 summary", async () => {
    const res = await app.request(
      new Request(`http://x/api/v1/monitor/memory/auto-installer/runs?projectId=${projectId}`)
    );
    const body = (await jsonOf(res)) as { ok: boolean; data: { items: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    const first = body.data.items[0] as Record<string, unknown>;
    expect(first.proposalsCreated).toBe(1);
    expect(first.proposalsNoCandidate).toBe(1);
  });
});

describe("POST /memory/auto-installer/proposals/:id/approve", () => {
  test("approve pending_review → 200，gap 同步 installed", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals/${withCandidateProposalId}/approve`,
        {
          method: "POST",
          body: JSON.stringify({ actor: "tester", reason: "looks safe" }),
          headers: { "content-type": "application/json" },
        }
      )
    );
    const body = (await jsonOf(res)) as { ok: boolean; data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.toState).toBe("approved");
    expect(body.data.gapStatusChanged).toBe(true);

    const db = await getDb();
    const [gap] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, withCandidateGapId));
    expect(gap!.status).toBe("installed");
  });

  test("approve 已 approved → 400 + ProposalStateError 文案", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals/${withCandidateProposalId}/approve`,
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } }
      )
    );
    expect(res.status).toBe(400);
    const body = (await jsonOf(res)) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("cannot approve");
  });

  test("approve 不存在的 id → 404", async () => {
    const res = await app.request(
      new Request("http://x/api/v1/monitor/memory/auto-installer/proposals/missing_id/approve", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /memory/auto-installer/proposals/:id/reject", () => {
  test("reject no_candidate → 200，gap 维持 open", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals/${noCandidateProposalId}/reject`,
        {
          method: "POST",
          body: JSON.stringify({ actor: "tester" }),
          headers: { "content-type": "application/json" },
        }
      )
    );
    const body = (await jsonOf(res)) as { ok: boolean; data: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.toState).toBe("rejected");
    expect(body.data.gapStatusChanged).toBe(false);

    const db = await getDb();
    const [gap] = await db.select().from(toolGapLog).where(eq(toolGapLog.id, noCandidateGapId));
    expect(gap!.status).toBe("open");
  });

  test("reject 已 approved → 400", async () => {
    const res = await app.request(
      new Request(
        `http://x/api/v1/monitor/memory/auto-installer/proposals/${withCandidateProposalId}/reject`,
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } }
      )
    );
    expect(res.status).toBe(400);
  });
});
