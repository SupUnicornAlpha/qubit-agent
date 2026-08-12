/**
 * FS-first Workspace 契约类型（对齐 docs/qubit-prime/02-ui-cursor-workbench §7.4–7.5）。
 * DB 仅为可选投影，不以本文件为 UI/HTTP 唯一入口。
 */

export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export type ProviderRef = {
  kind: string;
  config?: Record<string, unknown>;
};

export type WorkspaceManifest = {
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  defaultFocus?: { symbol: string; exchange?: string };
  tags?: string[];
  providers: {
    memory: ProviderRef;
    decision: ProviderRef;
    market?: ProviderRef;
  };
};

export type ProviderSlot = "memory" | "decision" | "market";

export type ProviderBindingFile = {
  schemaVersion: 1;
  slot: ProviderSlot;
  ref: ProviderRef;
  capabilities?: string[];
};

export type WorkspaceTreeNodeKind =
  | "folder"
  | "file"
  | "universe"
  | "symbol"
  | "factor"
  | "strategy"
  | "report"
  | "artifact"
  | "memory_entry"
  | "run"
  | "virtual";

export type WorkspaceTreeNode = {
  id: string;
  name: string;
  kind: WorkspaceTreeNodeKind;
  relPath?: string;
  providerOwned?: boolean;
  meta?: Record<string, unknown>;
  children?: WorkspaceTreeNode[];
};

export type RunRecord = {
  id: string;
  title: string;
  status: "queued" | "running" | "awaiting_hitl" | "done" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  workflowId?: string;
  sessionId?: string;
  modelId?: string;
  focus?: { symbol?: string; exchange?: string };
};

export type MemoryEntry = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  tags?: string[];
  /** experience = virtual Experience row not yet projected to FS */
  source?: "user" | "agent_proposal" | "import" | "experience";
  relPath?: string;
};

export type AgentInstructionLayer = { path: string; text: string };

export const DEFAULT_MEMORY_PROVIDER: ProviderRef = {
  kind: "builtin.fs_memory",
};

export const DEFAULT_DECISION_PROVIDER: ProviderRef = {
  kind: "builtin.local_quant",
};

export const SKELETON_DIRS = [
  ".qubit/rules",
  ".qubit/providers",
  ".qubit/locks",
  "input/news",
  "research/factors",
  "research/notes",
  "research/reports",
  "decision/strategies",
  "decision/scripts",
  "decision/backtests",
  "output/artifacts",
  "output/exports",
  "memory/entries",
  "memory/index",
  "runs",
] as const;

export const GITIGNORE_TEMPLATE =
  [
    "*.local.md",
    "*.local.json",
    ".qubit/settings.local.json",
    ".qubit/locks/",
    "memory/index/",
    ".DS_Store",
  ].join("\n") + "\n";

export const QUBIT_MD_TEMPLATE = (name: string) => `# ${name}

## 课题目标


## 研究范围 / 宇宙


## Agent 约定
- 读取本文件与 \`.qubit/rules/\` 后再动手。
- 策略与脚本写入 \`decision/\`；报告写入 \`research/reports/\`；交付物写入 \`output/\`。
- 长期结论经记忆提案写入 \`memory/\`，不要把整段 transcript 当作记忆。
`;

export const MEMORY_MD_TEMPLATE = `# Workspace Memory Index

> 由 builtin.fs_memory 维护摘要；条目正文见 \`entries/\`。

## 置顶


## 最近

`;
