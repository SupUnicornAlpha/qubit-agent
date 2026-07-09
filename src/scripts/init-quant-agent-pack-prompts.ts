/**
 * 初始化 Agent Pack 目录结构；**主提示词在 DB（seed-agent-prompts）**，Pack 仅保留身份与可选备忘。
 *
 * 用法：bun run init:agent-packs
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { definitionPackDir, ensureAgentPackLayout } from "../runtime/agent/agent-pack-service";
import { SEED_AGENT_DEFINITIONS } from "../runtime/seed-agent-definitions-data";

const PACK_NOTES: Partial<Record<string, string>> = {
  orchestrator: [
    "## 编排备忘",
    "",
    "- 数据层：market_data + news_event",
    "- 研究层：按需调用专家（market_data / news_event / analyst_* / research）",
    "  · 高置信结果直接用 fusion 数值，不必再开 LLM 总结",
    "  · 低置信 / 信号分歧 / missingRoles≥2 时补叫专家，不默认批量拉全队",
    "- 深化：research → backtest",
    "- 风控：risk（规则+组合）",
  ].join("\n"),
};

async function main() {
  const dataDir = config.dataDir;
  for (const def of SEED_AGENT_DEFINITIONS) {
    await ensureAgentPackLayout({ dataDir, definitionId: def.id, configRootUri: "" });
    const root = definitionPackDir(dataDir, def.id);
    const notes = PACK_NOTES[def.role] ?? "";
    const promptMd = [
      "# Pack 备忘（可选）",
      "",
      "系统提示词权威来源为 **seed-agent-prompts.ts** → DB `system_prompt`；本文件由 seed 同步，与 DB 一致（`promptMode: db_primary`）。",
      "",
      notes,
      "",
    ].join("\n");
    await writeFile(join(root, "workspace", "prompt.md"), promptMd, "utf-8");
    const soulMd = [
      "# Soul",
      "",
      `**${def.name}**（\`${def.role}\`）· 内置 Agent v${def.version}`,
      "",
      "专业、可复核、中文沟通；遵守沙箱与风控边界。",
      "",
    ].join("\n");
    await writeFile(join(root, "soul.md"), soulMd, "utf-8");
  }
  console.log(
    `[init-pack] ${SEED_AGENT_DEFINITIONS.length} packs under ${join(dataDir, "agents")} (DB-primary prompts)`
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
