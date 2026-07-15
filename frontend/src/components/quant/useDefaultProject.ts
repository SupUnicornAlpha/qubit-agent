/**
 * useDefaultProject — 取出当前默认的 workspaceId / projectId。
 *
 * 量化工作台的 Tab 大多只需要 projectId（factor/discovery 入库归属），不需要
 * 用户做完整工作区切换，因此这里直接复用 MainContent 启动时已自动 ensure
 * 的「QUBIT Default Workspace / Project」。
 *
 * Project 选择策略（2026-06-09 修复）：
 *   旧版 `projects[0]?.id` 永远拿最老的 project（按 created_at），生产数据库里
 *   往往是 seed 数据（test_proj / fs-proj / disc-proj 等 fixture），跟 Agent /
 *   评测 / dev server 实际使用的 `QUBIT Default Project` 不一致 —— 表现：
 *   ComposerTab 进去看不到 Agent 刚产出的 strategy_version。
 *
 *   新策略：
 *     1. 优先 name === "QUBIT Default Project"（运行时 ensure 出来的官方默认）
 *     2. fallback 找 name === "default"（兼容老 datadir 命名）
 *     3. 最后才回 projects[0]
 */
import { useCallback, useEffect, useState } from "react";
import { listProjects, listWorkspaces } from "../../api/backend";
import { useAppStore } from "../../store";

export interface DefaultProjectInfo {
  workspaceId: string | null;
  projectId: string | null;
  loading: boolean;
  error: string | null;
  /** true 表示当前项目来自研究产物跳转，而不是默认项目选择器。 */
  contextual: boolean;
  reload: () => Promise<void>;
}

/** listProjects 当前回的最小行结构。提成 type 仅给 pickPreferredProject 用。 */
type ProjectLite = Awaited<ReturnType<typeof listProjects>>[number];

const PREFERRED_NAMES = ["QUBIT Default Project", "default"] as const;

/**
 * 在多个候选 project 中按优先级挑出"默认"那一个。
 * 提成纯函数便于单测；不依赖 React。
 */
export function pickPreferredProject(projects: ProjectLite[]): string | null {
  if (projects.length === 0) return null;
  for (const name of PREFERRED_NAMES) {
    const hit = projects.find((p) => p.name === name);
    if (hit) return hit.id;
  }
  return projects[0]?.id ?? null;
}

export function useDefaultProject(): DefaultProjectInfo {
  const contextProjectId = useAppStore((s) => s.quantContext?.projectId ?? null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const workspaces = await listWorkspaces();
      const wsId = workspaces[0]?.id ?? null;
      setWorkspaceId(wsId);
      if (!wsId) {
        setProjectId(null);
        return;
      }
      const projects = await listProjects(wsId);
      setProjectId(pickPreferredProject(projects));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    workspaceId,
    projectId: contextProjectId || projectId,
    loading: contextProjectId ? false : loading,
    error: contextProjectId ? null : error,
    contextual: Boolean(contextProjectId),
    reload,
  };
}
