/**
 * 将内置 `SEED_AGENT_DEFINITIONS` 写入数据目录下的 Agent Pack：
 *   `$QUBIT_DATA_DIR` 或 `~/.quant-agent/agents/<definitionId>/workspace/prompt.md` + `soul.md`
 * 并补齐 `ensureAgentPackLayout` 所需的目录与占位文件（agent/user/memory 等）。
 *
 * 用法：
 *   bun run src/scripts/init-quant-agent-pack-prompts.ts
 *   QUBIT_DATA_DIR=/path/to/data bun run src/scripts/init-quant-agent-pack-prompts.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { definitionPackDir, ensureAgentPackLayout } from "../runtime/agent/agent-pack-service";
import { SEED_AGENT_DEFINITIONS } from "../runtime/seed-agent-definitions-data";

async function main() {
  const dataDir = config.dataDir;
  for (const def of SEED_AGENT_DEFINITIONS) {
    await ensureAgentPackLayout({ dataDir, definitionId: def.id, configRootUri: "" });
    const root = definitionPackDir(dataDir, def.id);
    const promptMd = [
      "# 系统提示词",
      "",
      "> 由仓库脚本 `init-quant-agent-pack-prompts` 根据内置 seed 写入；默认模式下优先于数据库 `system_prompt`。",
      "",
      def.systemPrompt.trim(),
      "",
    ].join("\n");
    await writeFile(join(root, "workspace", "prompt.md"), promptMd, "utf-8");
    const soulMd = [
      "# Soul",
      "",
      `**${def.name}**（\`${def.role}\`）：专业、可复核、中文沟通；遵守 QUBIT 沙箱与风控边界。`,
      "",
    ].join("\n");
    await writeFile(join(root, "soul.md"), soulMd, "utf-8");
  }
  console.log(
    `[init-pack] initialized ${SEED_AGENT_DEFINITIONS.length} agent packs under ${join(dataDir, "agents")}`
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
