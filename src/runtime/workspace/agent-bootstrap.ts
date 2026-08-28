import { resolveProviders } from "./providers/resolve";
/**
 * Workspace → Agent 启动注入包（说明书 + 记忆摘要 + 宇宙）。
 * Core 只吃文本/context；不把 FS 逻辑写进 reason loop。
 */
import { openWorkspaceById } from "./service";

export type WorkspaceBootstrapPack = {
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  instructionsText: string;
  memoryBootstrap: string;
  universeText: string;
  /** 拼进 Orchestrator context 的完整块 */
  contextBlock: string;
};

export async function buildWorkspaceBootstrapPack(
  workspaceId: string,
  opts?: { maxInstructionChars?: number; maxMemoryChars?: number; omitExecutionMemory?: boolean }
): Promise<WorkspaceBootstrapPack> {
  const maxInst = opts?.maxInstructionChars ?? 6000;
  const maxMem = opts?.maxMemoryChars ?? 3000;
  const { fs, manifest } = await openWorkspaceById(workspaceId);
  const { layers } = await fs.loadAgentInstructions();
  const instructionsText = layers
    .map((l) => `### ${l.path}\n${l.text.trim()}`)
    .join("\n\n")
    .slice(0, maxInst);

  const { memory } = resolveProviders(manifest);
  let memoryBootstrap = (await memory.loadBootstrap(fs, { maxChars: maxMem })).trim();
  if (opts?.omitExecutionMemory && memoryBootstrap) {
    memoryBootstrap = memoryBootstrap
      .split("\n")
      .filter((line) => !/auto-play\(|factor\.register|strategy\.compose|backtest\.run/i.test(line))
      .join("\n")
      .trim();
  }

  let universeText = "";
  if (await fs.exists("input/universe.json")) {
    try {
      const raw = await fs.readText("input/universe.json");
      universeText = raw.trim().slice(0, 2000);
    } catch {
      universeText = "";
    }
  }

  const focus = manifest.defaultFocus
    ? `${manifest.defaultFocus.symbol}${
        manifest.defaultFocus.exchange ? `.${manifest.defaultFocus.exchange}` : ""
      }`
    : "";

  const contextBlock = [
    `## Workspace 课题上下文（FS · ${manifest.name} · id=${manifest.id}）`,
    focus ? `- 默认焦点：${focus}` : null,
    `- 根路径：${fs.rootPath}`,
    "",
    "### 项目说明书（QUBIT.md / AGENTS.md / rules）",
    instructionsText || "（无说明书文件）",
    "",
    "### 长期记忆摘要",
    memoryBootstrap || "（暂无记忆）",
    "",
    "### 研究宇宙 input/universe.json",
    universeText || "（未设置）",
    "",
    "约定：写入本课题时使用相对路径（research/ / decision/ / output/ / memory/）；重要结论经记忆提案沉淀，勿整段粘贴 transcript。",
  ]
    .filter((line) => line != null)
    .join("\n");

  return {
    workspaceId: manifest.id,
    workspaceName: manifest.name,
    rootPath: fs.rootPath,
    instructionsText,
    memoryBootstrap,
    universeText,
    contextBlock,
  };
}
