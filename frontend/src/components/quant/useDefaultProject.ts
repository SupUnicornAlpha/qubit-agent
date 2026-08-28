/**
 * useDefaultProject — 量化工作台 project + lineage scope。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { listProjects, listWorkspaces } from "../../api/backend";
import {
  quantLineageFilterActive,
  quantListProjectFilter,
  type QuantListProjectFilter,
} from "../../lib/quantListScope";
import { useAppStore, type QuantLineageFilter } from "../../store";

export type ProjectLite = Awaited<ReturnType<typeof listProjects>>[number];

const PREFERRED_NAMES = ["QUBIT Default Project", "default"] as const;

export function pickPreferredProject(projects: ProjectLite[]): string | null {
  if (projects.length === 0) return null;
  for (const name of PREFERRED_NAMES) {
    const hit = projects.find((p) => p.name === name);
    if (hit) return hit.id;
  }
  return projects[0]?.id ?? null;
}

export { quantListProjectFilter };

export interface DefaultProjectInfo {
  workspaceId: string | null;
  projectId: string | null;
  defaultProjectId: string | null;
  scopeProjectId: string | null;
  scopeAllProjects: boolean;
  listProjectFilter: QuantListProjectFilter;
  lineageFilter: QuantLineageFilter;
  lineageFilterActive: boolean;
  setLineageFilter: (filter: QuantLineageFilter) => void;
  listScopeKey: string;
  projects: ProjectLite[];
  projectNameById: Record<string, string>;
  setScopeProjectId: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  contextual: boolean;
  reload: () => Promise<void>;
}

export function useDefaultProject(): DefaultProjectInfo {
  const quantContext = useAppStore((s) => s.quantContext);
  const scopeProjectId = useAppStore((s) => s.quantProjectScopeId);
  const setScopeProjectId = useAppStore((s) => s.setQuantProjectScopeId);
  const lineageFilter = useAppStore((s) => s.quantLineageFilter);
  const setLineageFilter = useAppStore((s) => s.setQuantLineageFilter);

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const wf = quantContext?.workflowRunId?.trim();
    if (!wf) return;
    setLineageFilter({ mode: "workflow", id: wf });
  }, [quantContext?.workflowRunId, setLineageFilter]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const workspaces = await listWorkspaces();
      const wsId = workspaces[0]?.id ?? null;
      setWorkspaceId(wsId);
      if (!wsId) {
        setDefaultProjectId(null);
        setProjects([]);
        return;
      }
      const rows = await listProjects(wsId);
      setProjects(rows);
      setDefaultProjectId(pickPreferredProject(rows));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scopeAllProjects = scopeProjectId === null;
  const listProjectFilter = useMemo(
    () => quantListProjectFilter(scopeProjectId),
    [scopeProjectId]
  );
  const projectId = scopeProjectId ?? defaultProjectId;
  const projectNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.name;
    return map;
  }, [projects]);

  const listScopeKey = `${scopeProjectId ?? "__all__"}|${lineageFilter.mode}|${lineageFilter.id}`;

  return {
    workspaceId,
    projectId,
    defaultProjectId,
    scopeProjectId,
    scopeAllProjects,
    listProjectFilter,
    lineageFilter,
    lineageFilterActive: quantLineageFilterActive(lineageFilter),
    setLineageFilter,
    listScopeKey,
    projects,
    projectNameById,
    setScopeProjectId,
    loading,
    error,
    contextual: Boolean(quantContext),
    reload,
  };
}
