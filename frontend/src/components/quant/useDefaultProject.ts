/**
 * useDefaultProject — 取出当前默认的 workspaceId / projectId。
 *
 * 量化工作台的 Tab 大多只需要 projectId（factor/discovery 入库归属），不需要
 * 用户做完整工作区切换，因此这里直接复用 MainContent 启动时已自动 ensure
 * 的「QUBIT Default Workspace / Project」。
 */
import { useCallback, useEffect, useState } from "react";
import { listProjects, listWorkspaces } from "../../api/backend";

export interface DefaultProjectInfo {
  workspaceId: string | null;
  projectId: string | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useDefaultProject(): DefaultProjectInfo {
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
      setProjectId(projects[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { workspaceId, projectId, loading, error, reload };
}
