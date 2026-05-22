/**
 * SkillCurator — M11.C1 周期性 skill 维护与策展
 *
 * 职责（参考 Hermes Agent curator.py 设计）：
 *   1. 自动状态迁移（确定性、零 LLM）
 *      - active 长时间未使用 → stale
 *      - stale 仍长时间未使用 → 软归档（agent_created/auto_candidate 才会被自动归档）
 *      - 任何 source 是 user_authored / open_skill_market / pinned 的 skill 不自动归档
 *   2. LLM 评审（可选；当 aux LLM 可用时）
 *      - 找出"重复/冲突/可合并"的 skill 组合
 *      - 产出 YAML 行动建议；dry_run 仅写入 skill_curator_run.summary_yaml 不动手
 *      - live 模式下按 YAML 执行 archive / patch
 *   3. 落痕：每次 run 都写一条 skill_curator_run（dry_run 或 live）
 *
 * 触发：
 *   - 通过 src/runtime/scripts/run-skill-curator.ts 由 cron / 用户手动触发
 *   - 单次执行幂等；并发由"同一 project 只允许一个 running" guard 保证
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, skillCuratorRun } from "../../db/sqlite/schema";
import type { AgentSkill, SkillCuratorMode } from "../../types/entities";
import { invokeWithFallback } from "../llm/llm-router";
import { loadModelConfig } from "../config/model-config";
import { skillService } from "./skill-service";

const STALE_THRESHOLD_DAYS = 30;
const ARCHIVE_THRESHOLD_DAYS = 60;
/** 自动归档仅适用于这些来源（用户 / 市场 skill 由人工管理） */
const AUTO_ARCHIVE_SOURCES = new Set(["agent_created", "evolved"]);

const CURATOR_REVIEW_SYSTEM_PROMPT = `你是 **Skill Curator**，负责审视 Agent 自创的程序性记忆库（agent_skill）。

任务：
1. 找出 **重复/高度重合** 的 skill（描述相似 + 工具链相似），建议合并。
2. 找出 **过时** 的 skill（描述提到的工具已下线 / 流程已被更广义 skill 覆盖），建议归档。
3. 找出 **质量低** 的 skill（描述空洞、步骤数 < 2、命中率 < 20% 且使用 ≥ 10 次），建议归档。

强约束：
- **只输出 YAML**，不要 markdown、不要解释、不要 \`\`\` 块。
- 仅基于输入数据下结论；信息不足时跳过该 skill。
- 每条 action 必须有 reason（≤ 80 字）。
- **保守优先**：宁可不动，也不要误判 active skill。pinned=true 的 skill 一律不动。

输出格式（YAML）：
\`\`\`
actions:
  - kind: archive            # archive | consolidate | rename | none
    skill_id: <id>
    reason: <短句>
  - kind: consolidate
    primary_skill_id: <id>   # 被合并到的目标
    duplicate_skill_ids: [<id>, <id>]
    reason: <短句>
\`\`\``;

export interface CuratorActionItem {
  kind: "archive" | "consolidate" | "rename" | "none";
  skillId?: string;
  primarySkillId?: string;
  duplicateSkillIds?: string[];
  reason: string;
}

export interface CuratorRunOptions {
  projectId: string;
  mode?: SkillCuratorMode;
  triggeredBy?: string;
  useLlm?: boolean;
  /** 当 useLlm=true 时强制使用某个 model；否则用 default model */
  llmProvider?: string;
}

export interface CuratorRunResult {
  curatorRunId: string;
  projectId: string;
  mode: SkillCuratorMode;
  status: "completed" | "failed";
  totalChecked: number;
  markedStale: number;
  archived: number;
  consolidated: number;
  pruned: number;
  summaryText: string;
  actions: CuratorActionItem[];
  errorMessage?: string;
}

export class SkillCurator {
  /** 入口：运行一次 curator。dry_run 不动任何 skill，live 才执行 LLM 推荐的动作。 */
  async run(opts: CuratorRunOptions): Promise<CuratorRunResult> {
    const projectId = opts.projectId;
    if (!projectId) throw new Error("SkillCurator: projectId is required");
    const mode: SkillCuratorMode = opts.mode ?? "dry_run";
    const triggeredBy = opts.triggeredBy ?? "cron";

    const db = await getDb();
    const runId = randomUUID();
    await db.insert(skillCuratorRun).values({
      id: runId,
      projectId,
      mode,
      status: "running",
      triggeredBy,
    });

    const result: CuratorRunResult = {
      curatorRunId: runId,
      projectId,
      mode,
      status: "completed",
      totalChecked: 0,
      markedStale: 0,
      archived: 0,
      consolidated: 0,
      pruned: 0,
      summaryText: "",
      actions: [],
    };

    try {
      // 1) 确定性自动状态迁移（不需要 LLM）
      const auto = await this.applyAutoTransitions(projectId, mode);
      result.markedStale = auto.markedStale;
      result.archived = auto.archived;
      result.totalChecked = auto.totalChecked;

      // 2) 可选 LLM 评审（合并/去重）
      let llmActions: CuratorActionItem[] = [];
      let llmYaml = "";
      if (opts.useLlm !== false) {
        try {
          const review = await this.runLlmReview(projectId);
          llmActions = review.actions;
          llmYaml = review.yaml;
        } catch (err) {
          // LLM 失败不影响 auto-transitions 落地
          console.warn(
            "[SkillCurator] LLM review failed (continuing with auto transitions only):",
            err instanceof Error ? err.message : err
          );
        }
      }

      if (mode === "live" && llmActions.length > 0) {
        const applied = await this.applyLlmActions(llmActions);
        result.archived += applied.archived;
        result.consolidated += applied.consolidated;
      }
      result.actions = [
        ...auto.actions,
        ...llmActions,
      ];
      result.summaryText = this.renderSummary(result);

      await db
        .update(skillCuratorRun)
        .set({
          status: "completed",
          totalChecked: result.totalChecked,
          markedStale: result.markedStale,
          archived: result.archived,
          consolidated: result.consolidated,
          pruned: result.pruned,
          summaryText: result.summaryText,
          summaryYaml: llmYaml,
          actionsJson: result.actions,
          endedAt: new Date().toISOString(),
        })
        .where(eq(skillCuratorRun.id, runId));

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(skillCuratorRun)
        .set({
          status: "failed",
          errorMessage: msg,
          endedAt: new Date().toISOString(),
        })
        .where(eq(skillCuratorRun.id, runId));
      result.status = "failed";
      result.errorMessage = msg;
      return result;
    }
  }

  /**
   * 阶段 1：确定性自动状态迁移（无需 LLM）。
   *   - 30d 未用 → stale
   *   - 60d 未用且 agent_created → archived
   *
   * dry_run 仅"统计"应转换的数量但不真写；live 才动 DB。
   */
  async applyAutoTransitions(
    projectId: string,
    mode: SkillCuratorMode
  ): Promise<{ totalChecked: number; markedStale: number; archived: number; actions: CuratorActionItem[] }> {
    const db = await getDb();
    const all = (await db
      .select()
      .from(agentSkill)
      .where(
        and(
          eq(agentSkill.projectId, projectId),
          ne(agentSkill.state, "archived"),
          // pinned 的不动
          eq(agentSkill.pinned, false)
        )
      )) as AgentSkill[];

    const now = Date.now();
    const staleThreshold = now - STALE_THRESHOLD_DAYS * 86400_000;
    const archiveThreshold = now - ARCHIVE_THRESHOLD_DAYS * 86400_000;

    let markedStale = 0;
    let archived = 0;
    const actions: CuratorActionItem[] = [];

    for (const s of all) {
      const lastUsed = s.lastUsedAt ? Date.parse(s.lastUsedAt) : Date.parse(s.createdAt);
      if (lastUsed > staleThreshold) continue;

      if (lastUsed < archiveThreshold && AUTO_ARCHIVE_SOURCES.has(s.source) && s.state === "stale") {
        actions.push({
          kind: "archive",
          skillId: s.id,
          reason: `unused ${Math.floor((now - lastUsed) / 86400_000)}d, source=${s.source}, auto-archive`,
        });
        if (mode === "live") {
          await skillService.archive(s.id, "auto_curator: unused > 60d");
        }
        archived += 1;
      } else if (s.state !== "stale") {
        actions.push({
          kind: "none",
          skillId: s.id,
          reason: `unused ${Math.floor((now - lastUsed) / 86400_000)}d → marked stale`,
        });
        if (mode === "live") {
          await db
            .update(agentSkill)
            .set({ state: "stale", updatedAt: new Date().toISOString() })
            .where(eq(agentSkill.id, s.id));
        }
        markedStale += 1;
      }
    }

    return { totalChecked: all.length, markedStale, archived, actions };
  }

  /**
   * 阶段 2：LLM 评审（找重复 / 合并建议）。
   * 把 skill 摘要喂给 aux LLM，让它输出 YAML 行动建议；这里只解析 YAML 不执行。
   */
  async runLlmReview(projectId: string): Promise<{ actions: CuratorActionItem[]; yaml: string }> {
    const cfg = await loadModelConfig();
    if (!cfg) {
      throw new Error("no default model config; set .qubit/model.json or env to enable LLM review");
    }
    const skills = await skillService.list(projectId, { includeArchived: false });
    if (skills.length < 2) {
      // 单 skill 没法评审重复
      return { actions: [], yaml: "" };
    }

    const userPrompt = buildCuratorReviewPrompt(skills);
    const result = await invokeWithFallback(cfg, {
      systemPrompt: CURATOR_REVIEW_SYSTEM_PROMPT,
      userPrompt,
      onToken: () => {},
    });
    const yaml = result.answer.trim();
    const actions = parseCuratorYaml(yaml);
    return { actions, yaml };
  }

  /** 应用 LLM 给出的 archive / consolidate 行为；缺失字段或目标不存在则跳过。 */
  async applyLlmActions(
    actions: CuratorActionItem[]
  ): Promise<{ archived: number; consolidated: number }> {
    let archived = 0;
    let consolidated = 0;
    for (const action of actions) {
      try {
        if (action.kind === "archive" && action.skillId) {
          const target = await skillService.findById(action.skillId);
          if (target && target.state !== "archived" && !target.pinned) {
            await skillService.archive(action.skillId, `curator_llm: ${action.reason}`);
            archived += 1;
          }
        } else if (action.kind === "consolidate" && action.primarySkillId && action.duplicateSkillIds) {
          const primary = await skillService.findById(action.primarySkillId);
          if (!primary || primary.state === "archived" || primary.pinned) continue;
          for (const dupId of action.duplicateSkillIds) {
            const dup = await skillService.findById(dupId);
            if (!dup || dup.id === primary.id) continue;
            if (dup.pinned || dup.state === "archived") continue;
            // 把 duplicate 归档，metadata 记录指向 primary
            await skillService.patch({
              skillId: dup.id,
              state: "archived",
              metadata: {
                consolidatedInto: primary.id,
                consolidatedAt: new Date().toISOString(),
                consolidatorReason: action.reason,
              },
            });
            consolidated += 1;
          }
        }
      } catch (err) {
        console.warn(
          `[SkillCurator] action ${action.kind} on ${action.skillId ?? action.primarySkillId} failed:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return { archived, consolidated };
  }

  /** 列出近期 N 次 curator run（UI / audit）。 */
  async listRecentRuns(projectId: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(skillCuratorRun)
      .where(eq(skillCuratorRun.projectId, projectId))
      .orderBy(desc(skillCuratorRun.startedAt))
      .limit(limit);
  }

  private renderSummary(r: CuratorRunResult): string {
    return [
      `Curator ${r.mode} run completed.`,
      `Checked ${r.totalChecked} active/non-pinned skills.`,
      `Marked stale: ${r.markedStale}`,
      `Archived: ${r.archived}`,
      `Consolidated: ${r.consolidated}`,
      `Pruned: ${r.pruned}`,
      `Actions queued: ${r.actions.length}`,
    ].join(" ");
  }
}

export const skillCurator = new SkillCurator();

/** 构建给 aux LLM 的 user prompt（skill 摘要表格） */
export function buildCuratorReviewPrompt(skills: AgentSkill[]): string {
  const lines: string[] = [];
  lines.push("以下是当前项目的活跃 skill 列表，请输出 YAML 行动建议：");
  lines.push("");
  for (const s of skills) {
    const successRate =
      s.useCount > 0 ? Math.round((s.successCount / Math.max(1, s.useCount)) * 100) : 0;
    lines.push(
      `- id: ${s.id}`
    );
    lines.push(`  name: ${s.name}`);
    lines.push(`  category: ${s.category}`);
    lines.push(`  state: ${s.state}`);
    lines.push(`  pinned: ${s.pinned}`);
    lines.push(`  source: ${s.source}`);
    lines.push(`  use_count: ${s.useCount}`);
    lines.push(`  success_rate: ${successRate}%`);
    lines.push(`  last_used_at: ${s.lastUsedAt ?? "never"}`);
    lines.push(`  description: ${JSON.stringify(s.description.slice(0, 240))}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 极简 YAML 解析：仅识别 `actions:` 列表中的 `- kind:` / `skill_id:` / `primary_skill_id:` /
 * `duplicate_skill_ids:` / `reason:`。不依赖 yaml 库。
 *
 * 兼容 LLM 偶尔包 ```yaml ``` 的情况。
 */
export function parseCuratorYaml(rawYaml: string): CuratorActionItem[] {
  // 去掉 markdown 代码块包装
  let text = rawYaml.trim();
  const fence = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const lines = text.split(/\r?\n/);

  const items: CuratorActionItem[] = [];
  let current: Partial<CuratorActionItem> | null = null;

  const flush = () => {
    if (current && current.kind) {
      const item: CuratorActionItem = {
        kind: current.kind,
        reason: current.reason ?? "",
      };
      if (current.skillId) item.skillId = current.skillId;
      if (current.primarySkillId) item.primarySkillId = current.primarySkillId;
      if (current.duplicateSkillIds) item.duplicateSkillIds = current.duplicateSkillIds;
      items.push(item);
    }
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("actions:")) continue;
    if (line.startsWith("- ")) {
      flush();
      current = {};
      const rest = line.slice(2).trim();
      const m = rest.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (m && current) {
        applyField(current, m[1]!, m[2]!.trim());
      }
      continue;
    }
    if (!current) continue;
    const m = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (m) {
      applyField(current, m[1]!, m[2]!.trim());
    }
  }
  flush();
  return items.filter((a) => a.kind !== "none" || a.skillId);
}

function applyField(target: Partial<CuratorActionItem>, key: string, value: string): void {
  const k = key.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  const stripped = value.replace(/^['"]/, "").replace(/['"]$/, "");
  if (key === "kind") {
    if (["archive", "consolidate", "rename", "none"].includes(stripped)) {
      target.kind = stripped as CuratorActionItem["kind"];
    }
    return;
  }
  if (key === "duplicate_skill_ids") {
    const arr = stripped
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]/, "").replace(/['"]$/, ""))
      .filter(Boolean);
    if (arr.length > 0) target.duplicateSkillIds = arr;
    return;
  }
  if (k === "skillId" || k === "primarySkillId" || k === "reason") {
    (target as Record<string, unknown>)[k] = stripped;
  }
}
