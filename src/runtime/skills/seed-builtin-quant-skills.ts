/**
 * Wave-1（2026-06-10）：内置 quant skill seed。
 *
 * 把 `content-packs/quant-skills/*.md` 镜像到 agent_skill 表，作为
 * 项目级（projectId scope, definitionId=null）通用 skill，所有 def 都可被
 * skillService.searchWithMeta 召回。
 *
 * 与 FSI skill 流程的差异：
 *   - FSI 走 `content-packs/anthropic-fsi/vendor/...` + `fsi-manifest`，且依赖
 *     `isFsiActive()` env 才会注入；
 *   - quant skill 是默认开启、不要任何 env，定位为"金融研究 base layer"。
 *
 * 命名：name = "quant:<slug>"（与 FSI 的 fsi:xxx 风格一致），便于在
 * skill_recall_log 上一眼区分来源。
 *
 * sync 时机：在 `syncDefinitionSkillsForProject()`（已被 platform-bootstrap
 * 调用）末尾叠加调用 `syncBuiltinQuantSkillsForProject()`；新装 datadir 与
 * 已有 datadir 都覆盖。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillService } from "./skill-service";

const FRONTMATTER_DESC_RE =
  /description:\s*(?:\|\s*\n([\s\S]*?)(?=\n[A-Za-z_][\w-]*:|\n---)|["']?([^\n"']+)["']?)/;
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface QuantSkillSpec {
  /** skill 标识，落到 agent_skill.name 时会前缀 "quant:" */
  slug: string;
  /** content-packs/quant-skills/ 下的文件名（不含路径） */
  fileName: string;
  /**
   * 适用的 agent role 列表（仅作 metadata，不直接影响召回；reason 节点的
   * `ownsByDef` 加分要靠 ROLE_SKILLS catalog 注册到具体 def）。
   */
  roles: ReadonlyArray<string>;
  /** tags 用于后续按场景过滤 / dashboard 可视化 */
  tags: ReadonlyArray<string>;
}

/**
 * 11 个 Wave-1 内置金融 skill。
 *
 * 选型原则：
 *   - 覆盖现有 11 个 def 的核心使用场景（基本面/技术/宏观/情绪/research/risk/backtest/live trading）
 *   - 每条 ≈ 1-3KB markdown，包含可被 LLM 直接拆解执行的 step-by-step 流程
 *   - 优先调用既有 builtin tool / connector / MCP（投递就用、零额外接入）
 */
export const SEED_QUANT_SKILLS: ReadonlyArray<QuantSkillSpec> = [
  {
    slug: "alpha-pead-drift",
    fileName: "alpha-pead-drift.md",
    roles: ["analyst_fundamental", "research", "news_event"],
    tags: ["event-driven", "alpha", "fundamental"],
  },
  {
    slug: "quality-piotroski-f-score",
    fileName: "quality-piotroski-f-score.md",
    roles: ["analyst_fundamental", "research"],
    tags: ["fundamental", "quality", "screening"],
  },
  {
    slug: "momentum-52w-breakout",
    fileName: "momentum-52w-breakout.md",
    roles: ["analyst_technical", "research"],
    tags: ["momentum", "technical", "alpha"],
  },
  {
    slug: "mean-reversion-bollinger",
    fileName: "mean-reversion-bollinger.md",
    roles: ["analyst_technical"],
    tags: ["mean-reversion", "technical", "contrarian"],
  },
  {
    slug: "vol-regime-classifier",
    fileName: "vol-regime-classifier.md",
    roles: ["analyst_macro", "analyst_technical", "research"],
    tags: ["regime", "vol", "macro", "gating"],
  },
  {
    slug: "yield-curve-recession-probe",
    fileName: "yield-curve-recession-probe.md",
    roles: ["analyst_macro", "research"],
    tags: ["macro", "recession", "fixed-income"],
  },
  {
    slug: "news-sentiment-event-scoring",
    fileName: "news-sentiment-event-scoring.md",
    roles: ["analyst_sentiment", "news_event", "research"],
    tags: ["event-driven", "sentiment", "news"],
  },
  {
    slug: "factor-ic-ir-report",
    fileName: "factor-ic-ir-report.md",
    roles: ["research", "backtest", "analyst_technical", "analyst_fundamental"],
    tags: ["factor", "evaluation", "report"],
  },
  {
    slug: "risk-concentration-var-checklist",
    fileName: "risk-concentration-var-checklist.md",
    roles: ["risk", "research", "backtest"],
    tags: ["risk", "checklist", "pre-trade"],
  },
  {
    slug: "backtest-leakage-self-check",
    fileName: "backtest-leakage-self-check.md",
    roles: ["backtest", "research", "analyst_technical"],
    tags: ["backtest", "integrity", "validation"],
  },
  {
    slug: "order-intent-buy-checklist",
    fileName: "order-intent-buy-checklist.md",
    roles: ["research", "risk"],
    tags: ["live-trading", "order", "intent", "checklist"],
  },
] as const;

/**
 * content-packs/quant-skills 物理目录。
 *
 * dev：从 src/runtime/skills/seed-builtin-quant-skills.ts 出发，回 3 层到仓库根
 *      然后拼 content-packs/quant-skills。
 * bundle（Tauri sidecar）：QUBIT_APP_ROOT 注入时直接拼到 content-packs/。
 *
 * 与 fsi-config 同源：若 QUBIT_APP_ROOT 不存在 / 目录不存在 → 回退到源码相对路径。
 */
export function getQuantSkillsRoot(): string {
  const appRoot = process.env["QUBIT_APP_ROOT"];
  if (appRoot) {
    const candidate = join(appRoot, "content-packs", "quant-skills");
    if (existsSync(candidate)) return candidate;
  }
  // 源码相对：src/runtime/skills/seed-builtin-quant-skills.ts → ../../../content-packs/quant-skills
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "content-packs", "quant-skills");
}

function descriptionFromMd(raw: string, fallback: string): string {
  const fm = raw.match(FRONTMATTER_BLOCK_RE);
  if (fm) {
    const m = fm[1]!.match(FRONTMATTER_DESC_RE);
    const block = (m?.[1] ?? m?.[2] ?? "").trim();
    if (block) {
      return block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
    }
  }
  const firstLine = raw
    .replace(FRONTMATTER_BLOCK_RE, "")
    .replace(/^#+\s*/, "")
    .split("\n")
    .find((l) => l.trim());
  return (firstLine ?? fallback).trim().slice(0, 500);
}

function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_BLOCK_RE, "").trim();
}

/** 给单个 project 落 / 更新所有 SEED_QUANT_SKILLS；幂等。 */
export async function syncBuiltinQuantSkillsForProject(projectId: string): Promise<number> {
  const root = getQuantSkillsRoot();
  if (!existsSync(root)) {
    console.warn(
      `[Seed:quant-skills] root not found: ${root} ` +
        `(检查 QUBIT_APP_ROOT 或仓库 content-packs/quant-skills 是否存在)`
    );
    return 0;
  }

  let synced = 0;
  for (const spec of SEED_QUANT_SKILLS) {
    const absPath = join(root, spec.fileName);
    if (!existsSync(absPath)) {
      console.warn(`[Seed:quant-skills] missing file: ${absPath}`);
      continue;
    }
    const raw = await readFile(absPath, "utf-8");
    const body = stripFrontmatter(raw).slice(0, 16 * 1024);
    const desc = descriptionFromMd(raw, spec.slug);
    const name = `quant:${spec.slug}`;
    /**
     * skillService 的 (projectId, name) 是 unique 约束；upsert 走 findByName +
     * 存在则 patch（覆盖 description / body / metadata）、不存在 create。
     */
    const existing = await skillService.findByName(projectId, name);
    if (existing) {
      await skillService.patch({
        skillId: existing.id,
        description: desc,
        bodyMd: body,
        metadata: {
          ...((existing.metadataJson as Record<string, unknown>) ?? {}),
          quantSkillSlug: spec.slug,
          roles: [...spec.roles],
          tags: [...spec.tags],
          syncedFrom: "seed-builtin-quant-skills",
        },
      });
    } else {
      await skillService.create({
        projectId,
        definitionId: null,
        name,
        description: desc,
        bodyMd: body,
        category: "quant",
        source: "user_authored",
        createdBy: "builtin-quant-sync",
        metadata: {
          quantSkillSlug: spec.slug,
          roles: [...spec.roles],
          tags: [...spec.tags],
          syncedFrom: "seed-builtin-quant-skills",
        },
      });
    }
    synced += 1;
  }
  return synced;
}
