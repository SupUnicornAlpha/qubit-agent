/**
 * 将内置 Agent 定义写入工作区 `.qubit/agents.json`（及按需更新 `sandbox.json`），
 * 便于以配置文件为主管理提示词与工具白名单，启动时由 GraphRunner 同步进 SQLite。
 *
 * 用法：
 *   bun run src/scripts/sync-workspace-agents-json.ts
 *   bun run src/scripts/sync-workspace-agents-json.ts --root /path/to/project
 *   若无 bun：`npx tsx src/scripts/sync-workspace-agents-json.ts`（依赖 Node；数据来自无 `bun:sqlite` 的纯模块）
 *
 * 说明：仓库 `.gitignore` 忽略 `.qubit/`，生成文件留在本机；也可复制到任意工作区根目录。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type WorkspaceSandboxPolicy,
  buildDefaultSandboxPoliciesFromDefinitions,
} from "../runtime/config/workspace-config";
import { SEED_AGENT_DEFINITIONS } from "../runtime/seed-agent-definitions-data";

function parseRootDir(): string {
  const i = process.argv.indexOf("--root");
  const rootArg = i >= 0 ? process.argv[i + 1] : undefined;
  if (rootArg) return rootArg;
  const fromEnv = process.env.QUBIT_WORKSPACE_ROOT?.trim();
  if (fromEnv) return fromEnv;
  return process.cwd();
}

async function main() {
  const root = parseRootDir();
  const configDir = join(root, ".qubit");
  const agentsFile = join(configDir, "agents.json");
  const sandboxFile = join(configDir, "sandbox.json");
  await mkdir(configDir, { recursive: true });

  await writeFile(
    agentsFile,
    `${JSON.stringify({ definitions: SEED_AGENT_DEFINITIONS }, null, 2)}\n`,
    "utf-8"
  );

  let policies = buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS);
  if (existsSync(sandboxFile)) {
    try {
      const raw = await readFile(sandboxFile, "utf-8");
      const parsed = JSON.parse(raw) as { policies?: WorkspaceSandboxPolicy[] };
      if (Array.isArray(parsed.policies) && parsed.policies.length > 0) {
        const next = [...parsed.policies];
        const idx = next.findIndex((p) => p.id === "default-policy");
        const gen = policies[0];
        if (gen) {
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              allowedTools: gen.allowedTools,
              allowedMcpServers: gen.allowedMcpServers,
              description: next[idx].description || gen.description,
            };
          } else {
            next.push(gen);
          }
          policies = next;
        }
      }
    } catch {
      /* 保留新生成的 policies */
    }
  }
  await writeFile(sandboxFile, `${JSON.stringify({ policies }, null, 2)}\n`, "utf-8");

  console.log(
    `[sync-workspace-agents] wrote ${agentsFile} (${SEED_AGENT_DEFINITIONS.length} definitions) and ${sandboxFile}`
  );
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
