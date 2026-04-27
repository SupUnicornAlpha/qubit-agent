import { httpGet, httpPost } from "./client";
import type {
  AgentSummary,
  AgentsConfigResponse,
  StepStreamEvent,
  WorkflowCreateInput,
} from "./types";

export async function getHealth(): Promise<{ status: string }> {
  return httpGet<{ status: string }>("/health");
}

export async function listWorkspaces(): Promise<Array<{ id: string; name: string }>> {
  const res = await httpGet<{ data: Array<{ id: string; name: string }> }>("/api/v1/workspaces");
  return res.data;
}

export async function createWorkspace(input: { name: string; owner: string }): Promise<{
  data: { id: string; name: string };
}> {
  return httpPost("/api/v1/workspaces", input);
}

export async function listProjects(workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await httpGet<{ data: Array<{ id: string; name: string }> }>(
    `/api/v1/workspaces/${workspaceId}/projects`
  );
  return res.data;
}

export async function createProject(params: {
  workspaceId: string;
  name: string;
  marketScope: string;
}): Promise<{ data: { id: string; name: string } }> {
  return httpPost(`/api/v1/workspaces/${params.workspaceId}/projects`, {
    name: params.name,
    marketScope: params.marketScope,
    status: "active",
  });
}

export async function listAgents(): Promise<AgentSummary[]> {
  const res = await httpGet<{ data: AgentSummary[] }>("/api/v1/agents");
  return res.data;
}

export async function createWorkflow(input: WorkflowCreateInput): Promise<{
  data: { id: string };
  runId: string;
}> {
  return httpPost("/api/v1/workflows", input);
}

export async function reloadAgents(): Promise<{ ok: boolean; before: number; after: number }> {
  return httpPost("/api/v1/agents/reload");
}

export async function getAgentsConfig(): Promise<AgentsConfigResponse> {
  return httpGet<AgentsConfigResponse>("/api/v1/agents/config");
}

export function subscribeWorkflowStream(params: {
  workflowId: string;
  runId: string;
  onEvent: (event: StepStreamEvent) => void;
  onError?: (err: Event) => void;
}): () => void {
  const base = localStorage.getItem("qubit_backend_url") ?? "http://localhost:3000";
  const url = `${base}/api/v1/workflows/${params.workflowId}/stream/${params.runId}`;
  const es = new EventSource(url);
  const types: StepStreamEvent["type"][] = [
    "token",
    "tool_call_start",
    "tool_call_end",
    "observe",
    "step_persisted",
    "final",
    "error",
  ];
  for (const t of types) {
    es.addEventListener(t, (ev) => {
      const msg = ev as MessageEvent<string>;
      params.onEvent(JSON.parse(msg.data) as StepStreamEvent);
    });
  }
  es.onerror = (err) => {
    params.onError?.(err);
  };
  return () => es.close();
}

