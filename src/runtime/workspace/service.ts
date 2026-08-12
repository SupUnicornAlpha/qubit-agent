import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "../app-paths";
import { slugifyWorkspaceName } from "./path-safety";
import type { WorkspaceManifest } from "./types";
import {
  QUBIT_MD_TEMPLATE,
  type WorkspaceFs,
  buildInitialManifest,
  createWorkspaceFs,
} from "./workspace-fs";

export function defaultWorkspacesRoot(dataDir?: string): string {
  return join(dataDir ?? defaultDataDir(), "workspaces");
}

export type DiscoverHit = {
  rootPath: string;
  manifest: WorkspaceManifest;
};

async function pathExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** 扫描 dataDir/workspaces 下带 .qubit/workspace.json 的子目录。 */
export async function discoverWorkspaces(dataDir?: string): Promise<DiscoverHit[]> {
  const root = defaultWorkspacesRoot(dataDir);
  if (!(await pathExists(root))) return [];
  const names = await readdir(root);
  const hits: DiscoverHit[] = [];
  for (const name of names) {
    const rootPath = join(root, name);
    let st;
    try {
      st = await stat(rootPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const manifestAbs = join(rootPath, ".qubit", "workspace.json");
    if (!(await pathExists(manifestAbs))) continue;
    try {
      const raw = await readFile(manifestAbs, "utf8");
      const manifest = JSON.parse(raw) as WorkspaceManifest;
      if (manifest?.id && manifest?.name) {
        hits.push({ rootPath, manifest });
      }
    } catch {}
  }
  hits.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return hits;
}

export async function openWorkspaceByRoot(rootPath: string): Promise<WorkspaceFs> {
  const fs = createWorkspaceFs(rootPath);
  const manifestAbs = join(fs.rootPath, ".qubit", "workspace.json");
  if (!(await pathExists(manifestAbs))) {
    throw new Error(`Not a workspace (missing .qubit/workspace.json): ${rootPath}`);
  }
  await fs.ensureSkeleton();
  return fs;
}

export async function openWorkspaceById(
  id: string,
  dataDir?: string
): Promise<{ fs: WorkspaceFs; manifest: WorkspaceManifest }> {
  const hits = await discoverWorkspaces(dataDir);
  const hit = hits.find((h) => h.manifest.id === id);
  if (!hit) throw new Error(`Workspace not found: ${id}`);
  const fs = await openWorkspaceByRoot(hit.rootPath);
  return { fs, manifest: hit.manifest };
}

export type CreateWorkspaceInput = {
  name: string;
  description?: string;
  slug?: string;
  /** 可选自定义父目录；默认 $QUBIT_DATA_DIR/workspaces */
  parentDir?: string;
  seedUniverse?: {
    symbols?: Array<{ symbol: string; exchange?: string }>;
    mode?: string;
  };
  defaultFocus?: WorkspaceManifest["defaultFocus"];
  dataDir?: string;
};

export async function createFsWorkspace(
  input: CreateWorkspaceInput
): Promise<{ rootPath: string; manifest: WorkspaceManifest; fs: WorkspaceFs }> {
  const parent = input.parentDir ?? defaultWorkspacesRoot(input.dataDir);
  await mkdir(parent, { recursive: true });
  let slug = slugifyWorkspaceName(input.slug || input.name);
  let rootPath = join(parent, slug);
  let n = 2;
  while (await pathExists(rootPath)) {
    rootPath = join(parent, `${slug}-${n}`);
    n += 1;
    if (n > 100) throw new Error("unable to allocate unique workspace directory");
  }
  // 若加了后缀，更新 slug 仅为目录名
  slug = rootPath.split(/[/\\]/).pop() || slug;

  await mkdir(rootPath, { recursive: true });
  const id = crypto.randomUUID();
  const manifest = buildInitialManifest({
    id,
    name: input.name.trim() || slug,
    description: input.description,
    defaultFocus: input.defaultFocus,
  });

  const fs = createWorkspaceFs(rootPath);
  await fs.writeJson(".qubit/workspace.json", manifest);
  await fs.ensureSkeleton();
  if (!(await fs.exists("QUBIT.md"))) {
    await fs.writeText("QUBIT.md", QUBIT_MD_TEMPLATE(manifest.name));
  }
  if (input.seedUniverse) {
    await fs.writeJson("input/universe.json", {
      schemaVersion: 1,
      ...input.seedUniverse,
      updatedAt: new Date().toISOString(),
    });
  } else if (!(await fs.exists("input/universe.json"))) {
    await fs.writeJson("input/universe.json", {
      schemaVersion: 1,
      symbols: [],
      updatedAt: new Date().toISOString(),
    });
  }
  if (!(await fs.exists("input/watchlist.json"))) {
    await fs.writeJson("input/watchlist.json", {
      schemaVersion: 1,
      symbols: [],
      updatedAt: new Date().toISOString(),
    });
  }
  // settings.json 骨架
  if (!(await fs.exists(".qubit/settings.json"))) {
    await fs.writeJson(".qubit/settings.json", {
      schemaVersion: 1,
      locale: "zh-CN",
    });
  }

  return { rootPath: fs.rootPath, manifest, fs };
}

/** 写入简单 run 记录到 runs/<id>/run.json */
export async function writeRunRecord(
  fs: WorkspaceFs,
  run: {
    id: string;
    title: string;
    status: string;
    workflowId?: string;
    sessionId?: string;
    modelId?: string;
    focus?: { symbol?: string; exchange?: string };
  }
): Promise<void> {
  const now = new Date().toISOString();
  const rel = `runs/${run.id}/run.json`;
  let createdAt = now;
  if (await fs.exists(rel)) {
    try {
      const prev = await fs.readJson<{ createdAt?: string }>(rel);
      if (prev.createdAt) createdAt = prev.createdAt;
    } catch {
      /* ignore */
    }
  }
  await fs.writeJson(rel, {
    ...run,
    createdAt,
    updatedAt: now,
  });
}
