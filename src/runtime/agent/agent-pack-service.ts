import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { config } from "../../config";

const MAX_PACK_BYTES = 256 * 1024;

/** 注入系统提示词时 USER / MEMORY 快照的 Unicode 码位上限（近似“字符数”） */
export const PACK_MEMORY_SNAPSHOT_MAX_CP = 2200;
export const PACK_USER_SNAPSHOT_MAX_CP = 1375;

export type PromptMode = "db_primary" | "file_primary" | "merged";

/** 写入 workspace/prompt.md 时附加；标明与 DB 同源 */
export const PACK_PROMPT_SYNC_HEADER =
  "<!-- QUBIT: 与 DB system_prompt 同步自 seed-agent-prompts.ts；修改请改 seed 后执行 bun run seed:agent-definitions -->\n\n";

export function truncateSnapshotByCodepoints(input: string, maxCodepoints: number): string {
  const s = [...input];
  if (s.length <= maxCodepoints) return input;
  return s.slice(0, maxCodepoints).join("");
}

export function defaultAgentPackRoot(dataDir: string): string {
  return join(dataDir, "agents");
}

export function definitionPackDir(dataDir: string, definitionId: string): string {
  return join(defaultAgentPackRoot(dataDir), definitionId);
}

function resolvePackRoot(dataDir: string, definitionId: string, configRootUri: string): string {
  const trimmed = (configRootUri ?? "").trim();
  if (!trimmed) return definitionPackDir(dataDir, definitionId);
  if (trimmed.startsWith("file://")) return resolve(trimmed.slice("file://".length));
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(join(dataDir, trimmed));
}

function resolveRefFile(
  packRoot: string,
  ref: string | null | undefined,
  fallbackName: string
): string {
  const r = (ref ?? "").trim();
  if (!r) return join(packRoot, fallbackName);
  if (isAbsolute(r) || r.startsWith("file://")) {
    return r.startsWith("file://") ? resolve(r.slice("file://".length)) : r;
  }
  return join(packRoot, r);
}

export function defaultMemoryNamespace(definitionId: string): string {
  return `def:${definitionId}`;
}

export function effectiveMemoryNamespace(
  profileNamespace: string | null | undefined,
  definitionId: string
): string {
  const n = (profileNamespace ?? "").trim();
  return n || defaultMemoryNamespace(definitionId);
}

export interface ReadPackFilesResult {
  packRoot: string;
  agentPath: string;
  agentText: string;
  agentExists: boolean;
  soulPath: string;
  soulText: string;
  soulExists: boolean;
  /** 实际读取到的主提示词文件路径（优先 `workspace/prompt.md`，否则为 `prompt_template_ref` 解析路径） */
  promptPath: string;
  promptText: string;
  promptExists: boolean;
  userPath: string;
  userText: string;
  userExists: boolean;
  memoryPath: string;
  memoryText: string;
  memoryExists: boolean;
}

export async function readPackFiles(params: {
  dataDir: string;
  definitionId: string;
  configRootUri: string;
  soulFileRef: string;
  promptTemplateRef: string | null | undefined;
}): Promise<ReadPackFilesResult> {
  const packRoot = resolvePackRoot(params.dataDir, params.definitionId, params.configRootUri);
  const agentPath = join(packRoot, "agent.md");
  const userPath = join(packRoot, "user.md");
  const memoryPath = join(packRoot, "memory.md");
  const soulPath = resolveRefFile(packRoot, params.soulFileRef, "soul.md");
  const refPromptPath = resolveRefFile(packRoot, params.promptTemplateRef, "prompt.md");
  const workspacePromptPath = join(packRoot, "workspace", "prompt.md");

  let agentText = "";
  let agentExists = false;
  let soulText = "";
  let promptText = "";
  let soulExists = false;
  let promptExists = false;
  let userText = "";
  let userExists = false;
  let memoryText = "";
  let memoryExists = false;
  let effectivePromptPath = refPromptPath;

  if (existsSync(agentPath)) {
    agentText = await readFile(agentPath, "utf-8");
    agentExists = true;
  }
  if (existsSync(soulPath)) {
    soulText = await readFile(soulPath, "utf-8");
    soulExists = true;
  }
  if (existsSync(workspacePromptPath)) {
    promptText = await readFile(workspacePromptPath, "utf-8");
    promptExists = true;
    effectivePromptPath = workspacePromptPath;
  } else if (existsSync(refPromptPath)) {
    promptText = await readFile(refPromptPath, "utf-8");
    promptExists = true;
  }
  if (existsSync(userPath)) {
    userText = await readFile(userPath, "utf-8");
    userExists = true;
  }
  if (existsSync(memoryPath)) {
    memoryText = await readFile(memoryPath, "utf-8");
    memoryExists = true;
  }

  return {
    packRoot,
    agentPath,
    agentText,
    agentExists,
    soulPath,
    promptPath: effectivePromptPath,
    soulText,
    promptText,
    soulExists,
    promptExists,
    userPath,
    userText,
    userExists,
    memoryPath,
    memoryText,
    memoryExists,
  };
}

export function hashPackContent(
  agentText: string,
  soulText: string,
  userText: string,
  memoryText: string,
  promptText: string
): string {
  return createHash("sha256")
    .update(agentText, "utf8")
    .update("\0", "utf8")
    .update(soulText, "utf8")
    .update("\0", "utf8")
    .update(userText, "utf8")
    .update("\0", "utf8")
    .update(memoryText, "utf8")
    .update("\0", "utf8")
    .update(promptText, "utf8")
    .digest("hex");
}

export function mergeSystemPrompt(params: {
  mode: PromptMode;
  dbPrompt: string;
  agentText: string;
  soulText: string;
  userText: string;
  memoryText: string;
  promptText: string;
}): string {
  const agent = params.agentText.trim();
  const soul = params.soulText.trim();
  const user = truncateSnapshotByCodepoints(params.userText.trim(), PACK_USER_SNAPSHOT_MAX_CP);
  const memory = truncateSnapshotByCodepoints(
    params.memoryText.trim(),
    PACK_MEMORY_SNAPSHOT_MAX_CP
  );
  const filePrompt = params.promptText.trim();
  const db = params.dbPrompt.trim();

  const frozen = [
    agent ? `## Agent\n${agent}` : "",
    soul ? `## Soul\n${soul}` : "",
    user ? `## User\n${user}` : "",
    memory ? `## Memory\n${memory}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (params.mode === "db_primary") {
    // 主任务提示：DB system_prompt 为权威；workspace/prompt.md 为 seed 镜像（空时才读文件）
    const core = db || filePrompt;
    if (frozen && core) return `${frozen}\n\n---\n\n${core}`;
    return frozen || core || soul;
  }

  const instructions = filePrompt ? `## Instructions\n${filePrompt}` : "";
  const fileCombined = [frozen, instructions].filter(Boolean).join("\n\n");

  if (params.mode === "file_primary") {
    if (fileCombined) return fileCombined;
    return db;
  }

  // merged
  if (fileCombined && db) {
    return `${fileCombined}\n\n---\n\n## Overlay (DB)\n${db}`;
  }
  return fileCombined || db;
}

export async function ensureAgentPackLayout(params: {
  dataDir: string;
  definitionId: string;
  configRootUri: string;
}): Promise<{ packRoot: string; created: string[] }> {
  const packRoot = resolvePackRoot(params.dataDir, params.definitionId, params.configRootUri);
  const agentPath = join(packRoot, "agent.md");
  const userPath = join(packRoot, "user.md");
  const memoryPath = join(packRoot, "memory.md");
  const soulPath = join(packRoot, "soul.md");
  const workspacePromptPath = join(packRoot, "workspace", "prompt.md");
  const workspaceDir = join(packRoot, "workspace");
  const memoryDir = join(packRoot, "memory");
  const created: string[] = [];

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  if (!existsSync(agentPath)) {
    await writeFile(
      agentPath,
      [
        "# Agent",
        "",
        "本文件为 **Agent 行为契约**（项目规则 / 能力边界，类似代码库中的 AGENTS.md）。",
        "仅应由人或「配置中心」写入；运行时工具 **不得** 修改此文件。",
        "",
        "## 规则示例",
        "",
        "- 不得编造成交或持仓。",
        "- 遵守风控与沙箱策略。",
        "",
      ].join("\n"),
      "utf-8"
    );
    created.push(agentPath);
  }
  if (!existsSync(userPath)) {
    await writeFile(
      userPath,
      [
        "# User",
        "",
        "提炼后的用户画像与会话偏好。",
        `建议长度不超过约 ${PACK_USER_SNAPSHOT_MAX_CP} 个 Unicode 码位；超出部分在注入系统提示词时会被截断。`,
        "可由记忆归纳流程或受控 API 更新。",
        "",
      ].join("\n"),
      "utf-8"
    );
    created.push(userPath);
  }
  if (!existsSync(memoryPath)) {
    await writeFile(
      memoryPath,
      [
        "# Memory",
        "",
        "Agent 自身经验与会话级笔记。",
        `建议长度不超过约 ${PACK_MEMORY_SNAPSHOT_MAX_CP} 个 Unicode 码位；超出部分在注入系统提示词时会被截断。`,
        "可由记忆归纳流程或受控 API 更新。",
        "",
      ].join("\n"),
      "utf-8"
    );
    created.push(memoryPath);
  }

  if (!existsSync(soulPath)) {
    await mkdir(dirname(soulPath), { recursive: true });
    await writeFile(
      soulPath,
      "# Soul\n\nDescribe personality, values, and long-lived preferences.\n",
      "utf-8"
    );
    created.push(soulPath);
  }
  if (!existsSync(workspacePromptPath)) {
    await writeFile(
      workspacePromptPath,
      [
        PACK_PROMPT_SYNC_HEADER,
        "# 系统提示词",
        "",
        "由 `bun run seed:agent-definitions` 从 seed-agent-prompts.ts 写入，与 DB `system_prompt` 保持一致。",
        "",
      ].join("\n"),
      "utf-8"
    );
    created.push(workspacePromptPath);
  }
  const readmeMemory = join(memoryDir, "README.md");
  if (!existsSync(readmeMemory)) {
    await writeFile(
      readmeMemory,
      "# Agent memory scope\n\nLogical namespace is stored in SQL (`agent_profile.memory_namespace`).\n",
      "utf-8"
    );
    created.push(readmeMemory);
  }
  const wsKeep = join(workspaceDir, ".gitkeep");
  if (!existsSync(wsKeep)) {
    await writeFile(wsKeep, "", "utf-8");
    created.push(wsKeep);
  }

  return { packRoot, created };
}

export async function writePackMarkdownFiles(params: {
  dataDir: string;
  definitionId: string;
  configRootUri: string;
  /** 若传入则写入 `agent.md`；省略则保留磁盘上已有内容（用于仅改 soul/prompt 的旧客户端） */
  agentMarkdown?: string;
  soulMarkdown: string;
  promptMarkdown: string;
}): Promise<{
  packRoot: string;
  agentPath: string;
  soulPath: string;
  promptPath: string;
  hash: string;
}> {
  const packRoot = resolvePackRoot(params.dataDir, params.definitionId, params.configRootUri);
  const agentPath = join(packRoot, "agent.md");
  const soulPath = join(packRoot, "soul.md");
  const workspacePromptPath = join(packRoot, "workspace", "prompt.md");
  const userPath = join(packRoot, "user.md");
  const memoryPath = join(packRoot, "memory.md");

  if (
    Buffer.byteLength(params.soulMarkdown, "utf8") > MAX_PACK_BYTES ||
    Buffer.byteLength(params.promptMarkdown, "utf8") > MAX_PACK_BYTES
  ) {
    throw new Error(`soul/prompt exceeds ${MAX_PACK_BYTES} bytes`);
  }
  if (
    params.agentMarkdown !== undefined &&
    Buffer.byteLength(params.agentMarkdown, "utf8") > MAX_PACK_BYTES
  ) {
    throw new Error(`agent exceeds ${MAX_PACK_BYTES} bytes`);
  }

  await mkdir(packRoot, { recursive: true });
  await mkdir(join(packRoot, "workspace"), { recursive: true });
  await mkdir(join(packRoot, "memory"), { recursive: true });

  if (params.agentMarkdown !== undefined) {
    await writeFile(agentPath, params.agentMarkdown, "utf-8");
  }

  await writeFile(soulPath, params.soulMarkdown, "utf-8");
  await writeFile(workspacePromptPath, params.promptMarkdown, "utf-8");

  const agentSnap =
    params.agentMarkdown ?? (existsSync(agentPath) ? await readFile(agentPath, "utf-8") : "");
  const userSnap = existsSync(userPath) ? await readFile(userPath, "utf-8") : "";
  const memSnap = existsSync(memoryPath) ? await readFile(memoryPath, "utf-8") : "";
  const hash = hashPackContent(
    agentSnap,
    params.soulMarkdown,
    userSnap,
    memSnap,
    params.promptMarkdown
  );
  return { packRoot, agentPath, soulPath, promptPath: workspacePromptPath, hash };
}

/** 会话可变的 USER / MEMORY 文件（Agent 工具或归纳流水线应只调用此写入，而非 agent.md） */
/** Agent 自服务可改写的 pack 文件（禁止 `agent.md`，须走管理 API） */
export type AgentPackSelfEditTarget = "soul" | "user" | "memory" | "prompt";

function assertResolvedUnderPackRoot(packRoot: string, filePath: string): void {
  const root = resolve(packRoot);
  const resolved = resolve(filePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("refused: target path escapes agent pack root");
  }
}

/**
 * 将 markdown 写入当前 definition 的 pack 内 soul / user / memory / prompt（含 soulFileRef / promptTemplateRef 解析路径）。
 * `user` / `memory` 与 session-snapshot 一致按码位截断；`soul` / `prompt` 受 MAX_PACK_BYTES 约束。
 */
export async function writePackSelfEditMarkdown(params: {
  dataDir: string;
  definitionId: string;
  configRootUri: string;
  soulFileRef: string;
  promptTemplateRef: string | null | undefined;
  target: AgentPackSelfEditTarget;
  markdown: string;
}): Promise<{ writtenPath: string; hash: string; truncated: boolean }> {
  const packRoot = resolvePackRoot(params.dataDir, params.definitionId, params.configRootUri);
  let writtenPath: string;
  let body: string;
  let truncated = false;

  if (params.target === "soul") {
    writtenPath = resolveRefFile(packRoot, params.soulFileRef, "soul.md");
    assertResolvedUnderPackRoot(packRoot, writtenPath);
    body = params.markdown;
    if (Buffer.byteLength(body, "utf8") > MAX_PACK_BYTES) {
      throw new Error(`soul exceeds ${MAX_PACK_BYTES} bytes`);
    }
  } else if (params.target === "prompt") {
    writtenPath = join(packRoot, "workspace", "prompt.md");
    assertResolvedUnderPackRoot(packRoot, writtenPath);
    body = params.markdown;
    if (Buffer.byteLength(body, "utf8") > MAX_PACK_BYTES) {
      throw new Error(`prompt exceeds ${MAX_PACK_BYTES} bytes`);
    }
  } else if (params.target === "user") {
    writtenPath = join(packRoot, "user.md");
    body = truncateSnapshotByCodepoints(params.markdown, PACK_USER_SNAPSHOT_MAX_CP);
    truncated = [...params.markdown].length > PACK_USER_SNAPSHOT_MAX_CP;
    if (Buffer.byteLength(body, "utf8") > MAX_PACK_BYTES) {
      throw new Error(`user exceeds ${MAX_PACK_BYTES} bytes`);
    }
  } else {
    writtenPath = join(packRoot, "memory.md");
    body = truncateSnapshotByCodepoints(params.markdown, PACK_MEMORY_SNAPSHOT_MAX_CP);
    truncated = [...params.markdown].length > PACK_MEMORY_SNAPSHOT_MAX_CP;
    if (Buffer.byteLength(body, "utf8") > MAX_PACK_BYTES) {
      throw new Error(`memory exceeds ${MAX_PACK_BYTES} bytes`);
    }
  }

  await mkdir(dirname(writtenPath), { recursive: true });
  await mkdir(join(packRoot, "workspace"), { recursive: true });
  await mkdir(join(packRoot, "memory"), { recursive: true });
  await writeFile(writtenPath, body, "utf-8");

  const snap = await readPackFiles({
    dataDir: params.dataDir,
    definitionId: params.definitionId,
    configRootUri: params.configRootUri,
    soulFileRef: params.soulFileRef,
    promptTemplateRef: params.promptTemplateRef,
  });
  const hash = hashPackContent(
    snap.agentText,
    snap.soulText,
    snap.userText,
    snap.memoryText,
    snap.promptText
  );
  return { writtenPath, hash, truncated };
}

export async function writePackSessionSnapshotFiles(params: {
  dataDir: string;
  definitionId: string;
  configRootUri: string;
  userMarkdown: string;
  memoryMarkdown: string;
}): Promise<{ packRoot: string; userPath: string; memoryPath: string; hash: string }> {
  const packRoot = resolvePackRoot(params.dataDir, params.definitionId, params.configRootUri);
  const agentPath = join(packRoot, "agent.md");
  const soulPath = join(packRoot, "soul.md");
  const workspacePromptPath = join(packRoot, "workspace", "prompt.md");
  const legacyPromptPath = join(packRoot, "prompt.md");
  const userPath = join(packRoot, "user.md");
  const memoryPath = join(packRoot, "memory.md");

  const userTrim = truncateSnapshotByCodepoints(params.userMarkdown, PACK_USER_SNAPSHOT_MAX_CP);
  const memTrim = truncateSnapshotByCodepoints(params.memoryMarkdown, PACK_MEMORY_SNAPSHOT_MAX_CP);

  if (
    Buffer.byteLength(userTrim, "utf8") > MAX_PACK_BYTES ||
    Buffer.byteLength(memTrim, "utf8") > MAX_PACK_BYTES
  ) {
    throw new Error(`user/memory exceeds ${MAX_PACK_BYTES} bytes`);
  }

  await mkdir(packRoot, { recursive: true });
  await mkdir(join(packRoot, "memory"), { recursive: true });

  await writeFile(userPath, userTrim, "utf-8");
  await writeFile(memoryPath, memTrim, "utf-8");

  const agentSnap = existsSync(agentPath) ? await readFile(agentPath, "utf-8") : "";
  const soulSnap = existsSync(soulPath) ? await readFile(soulPath, "utf-8") : "";
  const promptSnap = existsSync(workspacePromptPath)
    ? await readFile(workspacePromptPath, "utf-8")
    : existsSync(legacyPromptPath)
      ? await readFile(legacyPromptPath, "utf-8")
      : "";
  const hash = hashPackContent(agentSnap, soulSnap, userTrim, memTrim, promptSnap);
  return { packRoot, userPath, memoryPath, hash };
}

export function getDataDir(): string {
  return config.dataDir;
}

/** 将权威 system_prompt 同步到 Pack 的 workspace/prompt.md（与 DB 一致） */
export async function syncWorkspacePromptFromCanonical(params: {
  dataDir: string;
  definitionId: string;
  systemPrompt: string;
  configRootUri?: string;
}): Promise<string> {
  const packRoot = resolvePackRoot(
    params.dataDir,
    params.definitionId,
    params.configRootUri ?? ""
  );
  const workspaceDir = join(packRoot, "workspace");
  const workspacePromptPath = join(workspaceDir, "prompt.md");
  await mkdir(workspaceDir, { recursive: true });
  const body = params.systemPrompt.trim();
  await writeFile(
    workspacePromptPath,
    body ? `${PACK_PROMPT_SYNC_HEADER}${body}\n` : PACK_PROMPT_SYNC_HEADER,
    "utf-8"
  );
  return workspacePromptPath;
}
