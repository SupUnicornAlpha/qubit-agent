/**
 * Wave-1（2026-06-10）：auto-skill-execution-hook 单元测试。
 *
 * 两层覆盖：
 *   1. buildSearchTokens 纯函数 —— 无 DB 依赖，覆盖 token 拆分与最小长度过滤
 *   2. autoMarkRecalledSkillsAsExecuted DB 集成 —— 用真实 sqlite + runMigrations
 *      初始化最小数据，验证：
 *        - 命中 → skill_recall_log.executed 翻 true + agent_skill_run 写入
 *        - 不命中 → 不动
 *        - 多个 pending → 按命中逐个翻
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { skillService } from "../skill-service";
import {
  autoMarkRecalledSkillsAsExecuted,
  buildSearchTokens,
  matchRecommendedTool,
  parseRecommendedToolsJson,
} from "../auto-skill-execution-hook";

const SANDBOX_ID = "sb-auto-hook-test";
let projectId: string;
let workspaceId: string;
let workflowRunId: string;

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db
    .insert(schema.sandboxPolicy)
    .values({ id: SANDBOX_ID, name: "auto-hook-sb", description: "" })
    .onConflictDoNothing();
});

beforeEach(async () => {
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  workflowRunId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: `ws_${workspaceId.slice(0, 8)}`,
    owner: "test",
    createdAt: "2026-06-10T00:00:00.000Z",
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: `proj_${projectId.slice(0, 8)}`,
    marketScope: "CN-A",
    createdAt: "2026-06-10T00:00:00.000Z",
  });
  /**
   * workflow_run 行：autoMark 不直接读它（只读 skill_recall_log），但生产链路里
   * workflowRunId 一定来自真实 workflow_run。这里建一条以保持 FK 完整性。
   */
  await db.insert(schema.workflowRun).values({
    id: workflowRunId,
    projectId,
    goal: "auto-hook test workflow",
    mode: "research",
    source: "user",
    status: "running",
    loopKind: "react",
  });
});

async function insertRecall(skillId: string, opts: { rank?: number; score?: number } = {}) {
  const db = await getDb();
  await db.insert(schema.skillRecallLog).values({
    id: randomUUID(),
    workflowRunId,
    skillId,
    recallRank: opts.rank ?? 1,
    score: opts.score ?? 5,
    executed: false,
  });
}

describe("buildSearchTokens", () => {
  test("拆分 builtin tool 名 (factor.register) → 全名 + 子段", () => {
    const tokens = buildSearchTokens("factor.register");
    expect(tokens).toContain("factor.register");
    expect(tokens).toContain("factor");
    expect(tokens).toContain("register");
  });

  test("拆分 connector 名 (qubit-data/fetch_klines) → 全名 + 子段", () => {
    const tokens = buildSearchTokens("qubit-data/fetch_klines");
    expect(tokens).toContain("qubit-data/fetch_klines");
    expect(tokens).toContain("qubit-data");
    expect(tokens).toContain("fetch_klines");
  });

  test("mcpServerName 单独加入", () => {
    const tokens = buildSearchTokens("treasury_rates", "publicfinance");
    expect(tokens).toContain("treasury_rates");
    expect(tokens).toContain("publicfinance");
  });

  test("长度 < 4 的子段被过滤（避免 'tool'/'data' 等通用词全命中）", () => {
    const tokens = buildSearchTokens("a.b.factor");
    expect(tokens).not.toContain("a");
    expect(tokens).not.toContain("b");
    expect(tokens).toContain("factor");
  });

  test("token 自动小写", () => {
    const tokens = buildSearchTokens("PublicFinance.Treasury_Rates");
    expect(tokens.every((t) => t === t.toLowerCase())).toBe(true);
  });
});

describe("autoMarkRecalledSkillsAsExecuted", () => {
  test("命中：skill bodyMd 包含 toolName → executed 翻 true + agent_skill_run 写入", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "test-skill-pead",
      description: "PEAD signal skill",
      bodyMd:
        "## Step 1\n调用 `factor.register({ name: 'pead' })` 注册因子\n## Step 2\n调用 `factor.compute(...)` 计算",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
      outcome: "success",
    });
    expect(res.scanned).toBe(1);
    expect(res.matched).toEqual([skill.id]);
    expect(res.recorded).toBe(1);

    const db = await getDb();
    const recallRow = await db
      .select()
      .from(schema.skillRecallLog)
      .where(
        and(
          eq(schema.skillRecallLog.workflowRunId, workflowRunId),
          eq(schema.skillRecallLog.skillId, skill.id)
        )
      )
      .limit(1);
    expect(recallRow[0]?.executed).toBe(true);

    const runRow = await db
      .select()
      .from(schema.agentSkillRun)
      .where(eq(schema.agentSkillRun.skillId, skill.id));
    expect(runRow.length).toBe(1);
    expect(runRow[0]?.outcome).toBe("success");
  });

  test("不命中：skill bodyMd 与 toolName 无关 → 不动", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "test-skill-unrelated",
      description: "完全不相关的 skill",
      bodyMd: "## Step 1\n吃饭睡觉打豆豆\n## Step 2\n继续吃饭",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
      outcome: "success",
    });
    expect(res.scanned).toBe(1);
    expect(res.matched).toEqual([]);
    expect(res.recorded).toBe(0);

    const db = await getDb();
    const recallRow = await db
      .select()
      .from(schema.skillRecallLog)
      .where(eq(schema.skillRecallLog.skillId, skill.id))
      .limit(1);
    expect(recallRow[0]?.executed).toBe(false);
  });

  test("多 pending：只命中一个 → 只翻一个", async () => {
    const skillHit = await skillService.create({
      projectId,
      definitionId: null,
      name: "test-skill-hit",
      description: "提到 publicfinance",
      bodyMd: "Step 调用 publicfinance.treasury_rates 拿收益曲线",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
    });
    const skillMiss = await skillService.create({
      projectId,
      definitionId: null,
      name: "test-skill-miss",
      description: "无关 skill",
      bodyMd: "吃饭睡觉打豆豆",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
    });
    await insertRecall(skillHit.id);
    await insertRecall(skillMiss.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "treasury_rates",
      mcpServerName: "publicfinance",
      outcome: "success",
    });
    expect(res.scanned).toBe(2);
    expect(res.matched).toEqual([skillHit.id]);
    expect(res.recorded).toBe(1);
  });

  test("没有 pending recall 时不报错且 recorded=0", async () => {
    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
    });
    expect(res.scanned).toBe(0);
    expect(res.matched).toEqual([]);
    expect(res.recorded).toBe(0);
  });

  test("mcpServerName 通过 server 名命中（即使 toolName 不在 body 里）", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "test-skill-by-server",
      description: "通过 server 名匹配",
      bodyMd: "## 步骤\n用 publicfinance MCP 取最新数据",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "treasury_rates",
      mcpServerName: "publicfinance",
    });
    expect(res.matched).toEqual([skill.id]);
  });
});

/**
 * W2（2026-06-11）：recommended_tools_json 显式白名单优先于子串匹配。
 */
describe("matchRecommendedTool / parseRecommendedToolsJson (W2 helpers)", () => {
  test("精确匹配（case-insensitive）", () => {
    expect(matchRecommendedTool(["factor.register"], "factor.register")).toBe(true);
    expect(matchRecommendedTool(["FACTOR.register"], "factor.REGISTER")).toBe(true);
  });

  test("namespace.* 通配命中同 namespace 的所有工具", () => {
    expect(matchRecommendedTool(["factor.*"], "factor.register")).toBe(true);
    expect(matchRecommendedTool(["factor.*"], "factor.compute")).toBe(true);
    expect(matchRecommendedTool(["factor.*"], "factor")).toBe(true);
    expect(matchRecommendedTool(["factor.*"], "strategy.create")).toBe(false);
  });

  test("mcp:<server> 通过 server 名命中", () => {
    expect(
      matchRecommendedTool(["mcp:publicfinance"], "treasury_rates", "publicfinance")
    ).toBe(true);
    expect(matchRecommendedTool(["mcp:publicfinance"], "treasury_rates", "yahoo")).toBe(false);
  });

  test("空白名单永远不命中（让 caller fallback）", () => {
    expect(matchRecommendedTool([], "factor.register")).toBe(false);
  });

  test("parse JSON 字符串 → string[]", () => {
    expect(parseRecommendedToolsJson('["a","b"]')).toEqual(["a", "b"]);
    expect(parseRecommendedToolsJson("[]")).toEqual([]);
    expect(parseRecommendedToolsJson(null)).toEqual([]);
    expect(parseRecommendedToolsJson(undefined)).toEqual([]);
  });

  test("非法 JSON / 非 string 元素全部安全过滤", () => {
    expect(parseRecommendedToolsJson("not-json")).toEqual([]);
    expect(parseRecommendedToolsJson('"single-string"')).toEqual([]);
    expect(parseRecommendedToolsJson('["ok",123,null,"also-ok"]')).toEqual(["ok", "also-ok"]);
  });
});

describe("autoMarkRecalledSkillsAsExecuted · W2 recommended_tools 优先", () => {
  test("白名单精确命中 → 翻 executed=true（即使 bodyMd 完全不提该 tool）", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "w2-skill-explicit",
      description: "依靠白名单精确判定",
      // 注意 body 里完全没有 "factor.register" 这个串，旧路径会 miss
      bodyMd: "## 步骤\n根据 prompt 决定调用哪个工具，无需写明",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
      recommendedTools: ["factor.register", "factor.compute"],
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
      outcome: "success",
    });
    expect(res.matched).toEqual([skill.id]);
    expect(res.recorded).toBe(1);

    const db = await getDb();
    const recall = await db
      .select()
      .from(schema.skillRecallLog)
      .where(eq(schema.skillRecallLog.skillId, skill.id))
      .limit(1);
    expect(recall[0]?.executed).toBe(true);
  });

  test("声明了白名单但 toolName 不在其中 → 不走 fallback 子串匹配（避免误报）", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "w2-skill-strict",
      description: "白名单只授权 factor.compute",
      // body 里写了 "factor.register"，旧的子串匹配会命中；W2 应该不命中
      bodyMd: "## Step 1\n用 factor.register 注册...\n## Step 2\n再 factor.compute",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
      recommendedTools: ["factor.compute"],
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
      outcome: "success",
    });
    expect(res.matched).toEqual([]);
    expect(res.recorded).toBe(0);

    const db = await getDb();
    const recall = await db
      .select()
      .from(schema.skillRecallLog)
      .where(eq(schema.skillRecallLog.skillId, skill.id))
      .limit(1);
    expect(recall[0]?.executed).toBe(false);
  });

  test("namespace.* 白名单覆盖整族工具", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "w2-skill-namespace",
      description: "授权 strategy.* 全族",
      bodyMd: "策略管线：先 create_version，再 push",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
      recommendedTools: ["strategy.*"],
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "strategy.create_version",
      outcome: "success",
    });
    expect(res.matched).toEqual([skill.id]);
    expect(res.recorded).toBe(1);
  });

  test("空白名单 skill 仍走 fallback 子串匹配（不 break 存量行为）", async () => {
    const skill = await skillService.create({
      projectId,
      definitionId: null,
      name: "w2-skill-legacy",
      description: "未声明白名单",
      bodyMd: "Step 调用 factor.register 注册因子",
      category: "quant",
      source: "user_authored",
      createdBy: "test",
      // 不传 recommendedTools → 默认 "[]"
    });
    await insertRecall(skill.id);

    const res = await autoMarkRecalledSkillsAsExecuted({
      workflowRunId,
      toolName: "factor.register",
      outcome: "success",
    });
    expect(res.matched).toEqual([skill.id]);
    expect(res.recorded).toBe(1);
  });
});
