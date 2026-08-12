import type { Stats } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { WorkspacePathError, joinRoot, resolveInsideRoot } from "./path-safety";
import {
  type AgentInstructionLayer,
  DEFAULT_DECISION_PROVIDER,
  DEFAULT_MEMORY_PROVIDER,
  GITIGNORE_TEMPLATE,
  MEMORY_MD_TEMPLATE,
  type ProviderBindingFile,
  QUBIT_MD_TEMPLATE,
  SKELETON_DIRS,
  WORKSPACE_SCHEMA_VERSION,
  type WorkspaceManifest,
  type WorkspaceTreeNode,
  type WorkspaceTreeNodeKind,
} from "./types";

export type WorkspaceFs = {
  readonly rootPath: string;
  readManifest(): Promise<WorkspaceManifest>;
  writeManifest(patch: Partial<WorkspaceManifest>): Promise<WorkspaceManifest>;
  ensureSkeleton(): Promise<void>;
  listTree(opts?: { maxDepth?: number; includeIndex?: boolean }): Promise<WorkspaceTreeNode>;
  readText(relPath: string): Promise<string>;
  writeText(relPath: string, content: string, opts?: { createDirs?: boolean }): Promise<void>;
  readJson<T>(relPath: string): Promise<T>;
  writeJson(relPath: string, value: unknown): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  remove(relPath: string): Promise<void>;
  loadAgentInstructions(): Promise<{ layers: AgentInstructionLayer[] }>;
};

const MANIFEST_REL = ".qubit/workspace.json";

const INSTRUCTION_CANDIDATES = ["QUBIT.md", "AGENTS.md", "CLAUDE.md"] as const;

function guessFileKind(name: string, relPosix: string): WorkspaceTreeNodeKind {
  const lower = name.toLowerCase();
  if (relPosix.startsWith("research/factors/")) return "factor";
  if (relPosix.startsWith("decision/strategies/")) return "strategy";
  if (relPosix.startsWith("research/reports/")) return "report";
  if (relPosix.startsWith("output/artifacts/")) return "artifact";
  if (relPosix.startsWith("memory/entries/")) return "memory_entry";
  if (relPosix.startsWith("runs/") && lower === "run.json") return "run";
  if (lower === "universe.json" || lower === "watchlist.json") return "universe";
  return "file";
}

function shouldSkipDir(name: string, includeIndex: boolean): boolean {
  if (name === ".git" || name === "node_modules" || name === ".DS_Store") return true;
  if (name === "locks" || name === "index") {
    return !includeIndex;
  }
  return false;
}

async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

export function createWorkspaceFs(rootPath: string): WorkspaceFs {
  const root = joinRoot(rootPath);

  const api: WorkspaceFs = {
    rootPath: root,

    async readManifest() {
      const raw = await api.readText(MANIFEST_REL);
      const parsed = JSON.parse(raw) as WorkspaceManifest;
      if (!parsed?.id || !parsed?.name) {
        throw new WorkspacePathError("invalid workspace.json");
      }
      return parsed;
    },

    async writeManifest(patch) {
      const current = await api.readManifest();
      const next: WorkspaceManifest = {
        ...current,
        ...patch,
        id: current.id,
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        providers: {
          ...current.providers,
          ...(patch.providers ?? {}),
        },
        updatedAt: new Date().toISOString(),
      };
      await api.writeJson(MANIFEST_REL, next);
      return next;
    },

    async ensureSkeleton() {
      for (const dir of SKELETON_DIRS) {
        await mkdir(join(root, ...dir.split("/")), { recursive: true });
      }
      const gitignoreAbs = join(root, ".gitignore");
      if (!(await pathExists(gitignoreAbs))) {
        await writeFile(gitignoreAbs, GITIGNORE_TEMPLATE, "utf8");
      }
      const memoryMd = join(root, "memory", "MEMORY.md");
      if (!(await pathExists(memoryMd))) {
        await writeFile(memoryMd, MEMORY_MD_TEMPLATE, "utf8");
      }
      // Provider 绑定文件：有 manifest 时按 manifest 写；创建流程会先写 manifest
      if (await pathExists(join(root, ".qubit", "workspace.json"))) {
        const m = await api.readManifest();
        await writeProviderBinding(root, "memory", m.providers.memory);
        await writeProviderBinding(root, "decision", m.providers.decision);
        if (m.providers.market) {
          await writeProviderBinding(root, "market", m.providers.market);
        }
      }
    },

    async listTree(opts = {}) {
      const maxDepth = opts.maxDepth ?? 6;
      const includeIndex = opts.includeIndex ?? false;
      let name = basename(root);
      try {
        const m = await api.readManifest();
        name = m.name || name;
      } catch {
        /* 未初始化 manifest 时仍可列目录 */
      }
      const children = await walkDir(root, "", 0, maxDepth, includeIndex);
      return {
        id: "workspace:",
        name,
        kind: "folder",
        relPath: "",
        children,
      };
    },

    async readText(relPath) {
      const { absPath } = resolveInsideRoot(root, relPath);
      return readFile(absPath, "utf8");
    },

    async writeText(relPath, content, writeOpts) {
      const { absPath } = resolveInsideRoot(root, relPath);
      if (writeOpts?.createDirs !== false) {
        await mkdir(dirname(absPath), { recursive: true });
      }
      await writeFile(absPath, content, "utf8");
    },

    async readJson<T>(relPath: string) {
      const text = await api.readText(relPath);
      return JSON.parse(text) as T;
    },

    async writeJson(relPath, value) {
      await api.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`);
    },

    async exists(relPath) {
      try {
        const { absPath } = resolveInsideRoot(root, relPath);
        return pathExists(absPath);
      } catch {
        return false;
      }
    },

    async remove(relPath) {
      const { absPath } = resolveInsideRoot(root, relPath);
      await rm(absPath, { recursive: true, force: true });
    },

    async loadAgentInstructions() {
      const layers: AgentInstructionLayer[] = [];
      // 根指令：优先 QUBIT.md，否则回退 AGENTS.md / CLAUDE.md（同一位置只取第一个存在的）
      for (const candidate of INSTRUCTION_CANDIDATES) {
        const abs = join(root, candidate);
        if (await pathExists(abs)) {
          layers.push({ path: candidate, text: await readFile(abs, "utf8") });
          break;
        }
      }
      const localAbs = join(root, "QUBIT.local.md");
      if (await pathExists(localAbs)) {
        layers.push({
          path: "QUBIT.local.md",
          text: await readFile(localAbs, "utf8"),
        });
      }
      const rulesDir = join(root, ".qubit", "rules");
      if (await pathExists(rulesDir)) {
        const files = (await readdir(rulesDir))
          .filter((f) => f.endsWith(".md"))
          .sort((a, b) => a.localeCompare(b));
        for (const f of files) {
          const rel = `.qubit/rules/${f}`;
          layers.push({ path: rel, text: await readFile(join(rulesDir, f), "utf8") });
        }
      }
      return { layers };
    },
  };

  return api;
}

async function writeProviderBinding(
  root: string,
  slot: ProviderBindingFile["slot"],
  ref: ProviderBindingFile["ref"]
): Promise<void> {
  const rel = `.qubit/providers/${slot}.json`;
  const abs = join(root, ...rel.split("/"));
  if (await pathExists(abs)) return;
  const body: ProviderBindingFile = {
    schemaVersion: 1,
    slot,
    ref,
  };
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

async function walkDir(
  root: string,
  relPosix: string,
  depth: number,
  maxDepth: number,
  includeIndex: boolean
): Promise<WorkspaceTreeNode[]> {
  if (depth >= maxDepth) return [];
  const absDir = relPosix ? join(root, ...relPosix.split("/")) : root;
  let entries: string[];
  try {
    entries = await readdir(absDir);
  } catch {
    return [];
  }
  entries.sort((a, b) => a.localeCompare(b));
  const nodes: WorkspaceTreeNode[] = [];
  for (const name of entries) {
    if (name === ".DS_Store") continue;
    const childRel = relPosix ? `${relPosix}/${name}` : name;
    const abs = join(absDir, name);
    let st: Stats;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (shouldSkipDir(name, includeIndex) && (name === "index" || name === "locks")) {
        // index/locks 默认跳过
        if (!includeIndex) continue;
      }
      if (name === ".git" || name === "node_modules") continue;
      // .qubit/locks 默认跳过
      if (!includeIndex && (childRel === ".qubit/locks" || childRel.endsWith("/index"))) {
        continue;
      }
      nodes.push({
        id: `path:${childRel}`,
        name,
        kind: "folder",
        relPath: childRel,
        children: await walkDir(root, childRel, depth + 1, maxDepth, includeIndex),
      });
    } else if (st.isFile()) {
      nodes.push({
        id: `path:${childRel}`,
        name,
        kind: guessFileKind(name, childRel),
        relPath: childRel,
      });
    }
  }
  return nodes;
}

export function buildInitialManifest(input: {
  id: string;
  name: string;
  description?: string;
  defaultFocus?: WorkspaceManifest["defaultFocus"];
}): WorkspaceManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    createdAt: now,
    updatedAt: now,
    description: input.description,
    defaultFocus: input.defaultFocus,
    providers: {
      memory: { ...DEFAULT_MEMORY_PROVIDER },
      decision: { ...DEFAULT_DECISION_PROVIDER },
    },
  };
}

export { QUBIT_MD_TEMPLATE, MANIFEST_REL };
