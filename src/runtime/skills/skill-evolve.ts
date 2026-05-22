/**
 * SkillEvolver — M11.D1 GEPA-lite 文本演化（不训权重，纯 prompt mutation）
 *
 * 灵感来源：Hermes Agent self-evolution（dspy + GEPA），但简化为：
 *   1. 拿 base skill 的 description + bodyMd
 *   2. 让 aux LLM 产 N 个 candidate 变体（不同 mutation strategy）
 *   3. 对每个 candidate 用 evaluateSkillCandidate 打分（offline deterministic 评分；
 *      若提供 datasetId，可选地附加 LLM pairwise 评比加权）
 *   4. 取 best；如果 best > baseline + min_gain，落一条新 agent_skill（parent_skill_id=base）
 *   5. 写一条 skill_evolution_run 留痕（含每个 candidate 的得分）
 *
 * 设计原则：
 *   - 离线评分先行 — 不需要联网/付费就能跑 dry run；datasetId / aux LLM 都是可选增强
 *   - 永不覆盖 base — 总是写新版本，base 保持原样（即便胜出也由用户/curator 决定要不要 archive base）
 *   - 总 token 上界：candidates × iterations × budget；每条 candidate body ≤ 16KB（与 skill-service 一致）
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, skillEvolutionRun } from "../../db/sqlite/schema";
import type { AgentSkill } from "../../types/entities";
import { invokeWithFallback } from "../llm/llm-router";
import { loadModelConfig } from "../config/model-config";
import { skillService } from "./skill-service";

const DEFAULT_ITERATIONS = 3;
const DEFAULT_CANDIDATES_PER_ITER = 3;
const MIN_GAIN_TO_PROMOTE = 0.05; // 5%
const MAX_BODY_BYTES = 16 * 1024;

const MUTATION_STRATEGIES = [
  {
    key: "tighten_steps",
    instruction:
      "压缩冗余步骤，把 ≥ 2 处的相邻同 tool 合并描述；保留所有验收门槛与 fallback。目标：清晰度 +，长度 -10%~-30%。",
  },
  {
    key: "add_failure_modes",
    instruction:
      "增加「常见失败模式 + 应对动作」一节，列举 3-5 个；如果原文已有则强化（每条要有触发信号 + 回退到哪一步）。",
  },
  {
    key: "sharpen_when_to_use",
    instruction:
      "把「## 适用场景」收紧：明确「什么样的目标该用」、「什么样的目标别用」两段，各 ≤ 80 字，禁止模糊措辞。",
  },
  {
    key: "tool_chain_explicit",
    instruction:
      "把关键工具链显式编号 1.→2.→3.→…，每步标注：(a) 输入；(b) 输出；(c) 失败重试策略。这是程序性记忆的硬骨架。",
  },
];

const MUTATOR_SYSTEM_PROMPT = `你是 **Skill Mutator**。给定一条 Agent skill（程序性记忆）与一种突变策略，请产出 *改进后* 的 skill bodyMd。

强约束：
- 仅输出新 bodyMd 全文，**不要**包 markdown 代码块、**不要**额外解释、**不要**用 \`\`\`md 包裹。
- 总长度 ≤ 16KB；过长会被拒。
- 保留原 skill 的核心目标与适用场景；**禁止**添加未经过原 skill 验证的工具名 / 数字 / 阈值。
- 不要在 body 里写当前日期 / commit SHA / PR 号；那些不属于 skill。`;

export interface EvolveSkillInput {
  projectId: string;
  baseSkillId: string;
  datasetId?: string | null;
  iterations?: number;
  candidatesPerIteration?: number;
  triggeredBy?: string;
  /** 强制使用某 model（否则 default） */
  llmProvider?: string;
  /** 当无 LLM 可用时，是否回退到「shuffle + heuristic mutation」（用于离线 dry run） */
  allowOfflineMutation?: boolean;
}

export interface CandidateRecord {
  iteration: number;
  strategy: string;
  bodyPreview: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  fromOffline: boolean;
}

export interface EvolveSkillResult {
  evolutionRunId: string;
  status: "completed" | "failed";
  baselineScore: number;
  bestScore: number;
  winningSkillId: string | null;
  winningCandidate: CandidateRecord | null;
  candidates: CandidateRecord[];
  promoted: boolean;
  errorMessage?: string;
}

export class SkillEvolver {
  async evolve(input: EvolveSkillInput): Promise<EvolveSkillResult> {
    const projectId = input.projectId;
    const baseSkillId = input.baseSkillId;
    if (!projectId || !baseSkillId) {
      throw new Error("SkillEvolver.evolve: projectId and baseSkillId are required");
    }
    const iterations = Math.min(Math.max(input.iterations ?? DEFAULT_ITERATIONS, 1), 8);
    const candidatesPerIter = Math.min(
      Math.max(input.candidatesPerIteration ?? DEFAULT_CANDIDATES_PER_ITER, 1),
      MUTATION_STRATEGIES.length
    );

    const base = await skillService.findById(baseSkillId);
    if (!base) throw new Error(`base skill not found: ${baseSkillId}`);
    if (base.projectId !== projectId) {
      throw new Error("base skill projectId mismatch");
    }
    if (base.state === "archived") {
      throw new Error("cannot evolve an archived skill; restore it first");
    }

    const baselineScore = scoreSkillBody({ description: base.description, bodyMd: base.bodyMd });

    const db = await getDb();
    const runId = randomUUID();
    await db.insert(skillEvolutionRun).values({
      id: runId,
      projectId,
      baseSkillId,
      datasetId: input.datasetId ?? null,
      iterations,
      candidatesEvaluated: 0,
      baselineScore,
      status: "running",
      triggeredBy: input.triggeredBy ?? "user",
    });

    const candidates: CandidateRecord[] = [];
    const cfg = await loadModelConfig();
    const llmAvailable = cfg != null;
    const allowOffline = input.allowOfflineMutation !== false;

    try {
      let bestBody = base.bodyMd;
      let bestDesc = base.description;
      let bestScore = baselineScore;
      let bestRecord: CandidateRecord | null = null;

      for (let iter = 0; iter < iterations; iter++) {
        const pickedStrategies = MUTATION_STRATEGIES.slice(0, candidatesPerIter);
        for (const strategy of pickedStrategies) {
          let candidateBody: string | null = null;
          let fromOffline = false;
          if (llmAvailable && cfg) {
            try {
              candidateBody = await this.mutateViaLlm({
                base: { description: bestDesc, bodyMd: bestBody, name: base.name, category: base.category },
                instruction: strategy.instruction,
                llmConfig: cfg,
              });
            } catch (err) {
              console.warn(
                `[SkillEvolver] LLM mutation (${strategy.key}) failed; ${
                  allowOffline ? "falling back to offline" : "skipping"
                }: ${err instanceof Error ? err.message : err}`
              );
            }
          }
          if (!candidateBody && allowOffline) {
            candidateBody = offlineMutate(bestBody, strategy.key);
            fromOffline = true;
          }
          if (!candidateBody) continue;
          // 限长
          if (Buffer.byteLength(candidateBody, "utf-8") > MAX_BODY_BYTES) {
            candidateBody = candidateBody.slice(0, MAX_BODY_BYTES - 64) + "\n...(truncated)";
          }
          const { score, breakdown } = scoreSkillBodyDetailed({
            description: bestDesc,
            bodyMd: candidateBody,
          });
          const record: CandidateRecord = {
            iteration: iter + 1,
            strategy: strategy.key,
            bodyPreview: candidateBody.slice(0, 320),
            score,
            scoreBreakdown: breakdown,
            fromOffline,
          };
          candidates.push(record);

          if (score > bestScore) {
            bestScore = score;
            bestBody = candidateBody;
            bestRecord = record;
          }
        }
      }

      // 是否落新版本
      let winningSkillId: string | null = null;
      let promoted = false;
      if (bestRecord && bestScore >= baselineScore + MIN_GAIN_TO_PROMOTE) {
        const newName = nextEvolutionName(base.name);
        const created = await skillService.create({
          projectId,
          definitionId: base.definitionId,
          name: newName,
          description: `(evolved from ${base.name}) ${base.description}`.slice(0, 480),
          bodyMd: bestBody,
          category: base.category,
          source: "evolved",
          parentSkillId: base.id,
          state: "pending_review",
          createdBy: `skill_evolver:${input.triggeredBy ?? "user"}`,
          metadata: {
            evolutionRunId: runId,
            baselineScore,
            bestScore,
            winningStrategy: bestRecord.strategy,
            iterations,
            candidatesEvaluated: candidates.length,
          },
        });
        winningSkillId = created.id;
        promoted = true;
      }

      const endedAt = new Date().toISOString();
      await db
        .update(skillEvolutionRun)
        .set({
          status: "completed",
          candidatesEvaluated: candidates.length,
          bestScore,
          winningSkillId,
          reportJson: {
            candidates,
            winning: bestRecord,
            promoted,
            llmAvailable,
            offlineFallbackUsed: candidates.some((c) => c.fromOffline),
          },
          endedAt,
        })
        .where(eq(skillEvolutionRun.id, runId));

      return {
        evolutionRunId: runId,
        status: "completed",
        baselineScore,
        bestScore,
        winningSkillId,
        winningCandidate: bestRecord,
        candidates,
        promoted,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(skillEvolutionRun)
        .set({
          status: "failed",
          errorMessage: msg,
          endedAt: new Date().toISOString(),
        })
        .where(eq(skillEvolutionRun.id, runId));
      return {
        evolutionRunId: runId,
        status: "failed",
        baselineScore,
        bestScore: baselineScore,
        winningSkillId: null,
        winningCandidate: null,
        candidates,
        promoted: false,
        errorMessage: msg,
      };
    }
  }

  async listRecentRuns(projectId: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(skillEvolutionRun)
      .where(eq(skillEvolutionRun.projectId, projectId))
      .orderBy(desc(skillEvolutionRun.startedAt))
      .limit(limit);
  }

  /** 列出"演化谱系"：从 base 出发的所有 evolved 子代 */
  async listLineage(baseSkillId: string): Promise<AgentSkill[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(agentSkill)
      .where(eq(agentSkill.parentSkillId, baseSkillId))
      .orderBy(desc(agentSkill.createdAt));
    return rows as AgentSkill[];
  }

  private async mutateViaLlm(input: {
    base: { description: string; bodyMd: string; name: string; category: string };
    instruction: string;
    llmConfig: Awaited<ReturnType<typeof loadModelConfig>>;
  }): Promise<string> {
    if (!input.llmConfig) throw new Error("no LLM config");
    const userPrompt = [
      `**Skill name**: ${input.base.name}`,
      `**Category**: ${input.base.category}`,
      `**Description**: ${input.base.description}`,
      ``,
      `**当前 bodyMd**:`,
      `---`,
      input.base.bodyMd,
      `---`,
      ``,
      `**突变策略**: ${input.instruction}`,
      ``,
      `请直接输出改进后的完整 bodyMd（保留 Markdown 结构）。`,
    ].join("\n");

    const result = await invokeWithFallback(input.llmConfig, {
      systemPrompt: MUTATOR_SYSTEM_PROMPT,
      userPrompt,
      onToken: () => {},
    });
    let body = result.answer.trim();
    // 处理 LLM 偶尔加 ```md ... ``` 的情况
    const fence = body.match(/^```(?:md|markdown)?\s*([\s\S]*?)```$/);
    if (fence?.[1]) body = fence[1].trim();
    if (!body) throw new Error("LLM returned empty body");
    return body;
  }
}

export const skillEvolver = new SkillEvolver();

/** 简化的"skill 质量评分"——0~1 之间，越高越好。完全离线、确定性。 */
export function scoreSkillBody(input: { description: string; bodyMd: string }): number {
  return scoreSkillBodyDetailed(input).score;
}

export function scoreSkillBodyDetailed(input: { description: string; bodyMd: string }): {
  score: number;
  breakdown: Record<string, number>;
} {
  const body = input.bodyMd ?? "";
  const desc = input.description ?? "";
  const breakdown: Record<string, number> = {};

  // 1. 长度合适（200~6000 字符甜区；太短/太长都扣分）
  const len = body.length;
  let lengthScore = 0;
  if (len >= 200 && len <= 6000) lengthScore = 1;
  else if (len >= 80 && len < 200) lengthScore = 0.6;
  else if (len > 6000 && len <= 12000) lengthScore = 0.5;
  else if (len > 12000) lengthScore = 0.2;
  breakdown.length = lengthScore;

  // 2. 结构性：是否含有显式步骤（编号列表 / 步骤词）
  const stepMatches = body.match(/^(\s*[\d]+[\.)]\s+|\s*[-*]\s+)/gm) ?? [];
  const stepScore = Math.min(1, stepMatches.length / 6);
  breakdown.steps = stepScore;

  // 3. 是否包含验收/失败处理词
  const acceptanceHints = ["验收", "判据", "门槛", "失败", "fallback", "回退", "acceptance"];
  const failureHints = ["common pitfalls", "常见", "陷阱", "排错", "踩坑"];
  let acceptanceScore = 0;
  for (const h of acceptanceHints) if (body.toLowerCase().includes(h.toLowerCase())) acceptanceScore += 0.25;
  for (const h of failureHints) if (body.toLowerCase().includes(h.toLowerCase())) acceptanceScore += 0.25;
  acceptanceScore = Math.min(1, acceptanceScore);
  breakdown.acceptance = acceptanceScore;

  // 4. 描述清晰度（长度 80~360；不含模糊词如"也许"、"可能"）
  let descScore = 0;
  if (desc.length >= 60 && desc.length <= 480) descScore = 0.7;
  else if (desc.length > 0) descScore = 0.3;
  if (/(也许|可能|大约|maybe|perhaps)/i.test(desc)) descScore *= 0.6;
  breakdown.description = descScore;

  // 5. 反作弊：含 commit SHA / PR 号 / "we" / "this run" 等当次性指代 → 扣分
  let penalty = 0;
  if (/\b([a-f0-9]{7,40})\b/.test(body)) penalty += 0.1;
  if (/PR\s*#\d+/i.test(body)) penalty += 0.1;
  if (/this run|本次执行|当次/i.test(body)) penalty += 0.15;
  breakdown.cleanlinessPenalty = -penalty;

  // 加权汇总
  const weighted =
    0.2 * lengthScore + 0.3 * stepScore + 0.25 * acceptanceScore + 0.25 * descScore - penalty;
  const score = Math.max(0, Math.min(1, weighted));
  breakdown.final = score;
  return { score, breakdown };
}

function offlineMutate(body: string, strategyKey: string): string {
  // 极简启发式变异（dry-run / 无 LLM 时用）：
  switch (strategyKey) {
    case "tighten_steps":
      // 压缩多余空行
      return body
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^\s+$/gm, "")
        .trim();
    case "add_failure_modes":
      if (/常见失败|common pitfalls/i.test(body)) return body;
      return (
        body.trim() +
        "\n\n## 常见失败模式与回退\n- 当某步连续 ≥ 2 次失败 → 调 skill.patch 添加该失败模式与回退\n- 若工具返回空 → 跳到下一个候选信号源\n- 若 LLM 解析 JSON 失败 → 把 system_prompt 中 \"必须输出 JSON\" 这条加粗\n"
      );
    case "sharpen_when_to_use":
      if (/## 适用场景/i.test(body)) return body;
      return `## 适用场景\n- **该用**：当 goal 涉及 5+ 步工具链 / 跨 agent 协作 / 包含上游有不确定输入\n- **别用**：goal 是单一查询 / 一次性数据拉取 / 用户已显式指定流程\n\n${body.trim()}`;
    case "tool_chain_explicit":
      if (/^(\s*[\d]+[\.)] )/m.test(body)) return body;
      return body.replace(/^(\s*[-*]\s+)/gm, (m) => {
        // 把无序列表强制改成 1./2./3.（最多 9 个）
        return m.replace(/[-*]/, String(Math.floor(Math.random() * 9) + 1) + ".");
      });
    default:
      return body;
  }
}

function nextEvolutionName(baseName: string): string {
  // base-name → base-name-evo1，再来一次 → base-name-evo2 ...
  const m = baseName.match(/^(.*?)-evo(\d+)$/);
  if (m) return `${m[1]}-evo${Number(m[2]) + 1}`;
  return `${baseName}-evo1`;
}
