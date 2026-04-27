import type { CSSProperties, FC, FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  createWorkspace,
  createWorkflow,
  getAgentsConfig,
  listProjects,
  listAgents,
  listWorkspaces,
  reloadAgents,
  subscribeWorkflowStream,
} from "../../api/backend";
import type { WorkflowMode } from "../../api/types";
import { useAppStore } from "../../store";

export const MainContent: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  if (activeView === "config") {
    return (
      <main style={styles.main}>
        <ConfigPanel />
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <div style={styles.placeholder}>
        <MonitorPanel />
      </div>
    </main>
  );
};

const MonitorPanel: FC = () => {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const streamEvents = useAppStore((s) => s.streamEvents);
  const pushStreamEvent = useAppStore((s) => s.pushStreamEvent);
  const clearStreamEvents = useAppStore((s) => s.clearStreamEvents);
  const [workflowId, setWorkflowId] = useState("");
  const [runId, setRunId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("Run orchestrator workflow");
  const [mode, setMode] = useState<WorkflowMode>("research");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void listAgents().then(setAgents).catch(console.error);
  }, [setAgents]);

  useEffect(() => {
    const boot = async () => {
      const workspaces = await listWorkspaces();
      let workspaceId = workspaces[0]?.id;
      if (!workspaceId) {
        const created = await createWorkspace({
          name: "QUBIT Default Workspace",
          owner: "local-user",
        });
        workspaceId = created.data.id;
      }
      const projects = await listProjects(workspaceId);
      let pid = projects[0]?.id;
      if (!pid) {
        const createdProject = await createProject({
          workspaceId,
          name: "QUBIT Default Project",
          marketScope: "CN-A",
        });
        pid = createdProject.data.id;
      }
      setProjectId(pid);
    };
    void boot().catch(console.error);
  }, []);

  const eventsPreview = useMemo(() => streamEvents.slice(-200), [streamEvents]);

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    clearStreamEvents();
    try {
      const created = await createWorkflow({
        projectId,
        goal,
        mode,
      });
      setWorkflowId(created.data.id);
      setRunId(created.runId);
      const unsubscribe = subscribeWorkflowStream({
        workflowId: created.data.id,
        runId: created.runId,
        onEvent: pushStreamEvent,
        onError: () => unsubscribe(),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h2 style={styles.title}>运行监控</h2>
      <p style={styles.desc}>创建 workflow 后自动订阅 SSE 事件流，实时查看 Agent 执行轨迹。</p>
      <form style={styles.form} onSubmit={onCreate}>
        <input
          style={styles.input}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="workflow goal"
        />
        <select style={styles.select} value={mode} onChange={(e) => setMode(e.target.value as WorkflowMode)}>
          <option value="research">research</option>
          <option value="backtest">backtest</option>
          <option value="simulation">simulation</option>
          <option value="live">live</option>
        </select>
        <button style={styles.button} type="submit" disabled={loading || !projectId}>
          {loading ? "创建中..." : "创建并订阅"}
        </button>
      </form>
      <div style={styles.meta}>
        <span>projectId: {projectId || "-"}</span>
        <span>workflowId: {workflowId || "-"}</span>
        <span>runId: {runId || "-"}</span>
      </div>
      <h3 style={styles.subTitle}>Agent 列表</h3>
      <div style={styles.grid}>
        {agents.map((a) => (
          <div key={a.id} style={styles.card}>
            <div style={styles.cardName}>{a.role}</div>
            <div style={styles.cardDesc}>
              {a.running ? "running" : "stopped"} · {a.version}
            </div>
          </div>
        ))}
      </div>
      <h3 style={styles.subTitle}>SSE 事件流</h3>
      <pre style={styles.streamBox}>
        {eventsPreview.length === 0 ? "暂无事件..." : eventsPreview.map((e) => JSON.stringify(e)).join("\n")}
      </pre>
    </>
  );
};

const ConfigPanel: FC = () => {
  const configData = useAppStore((s) => s.configData);
  const setConfigData = useAppStore((s) => s.setConfigData);
  const reloadSummary = useAppStore((s) => s.reloadSummary);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const [loading, setLoading] = useState(false);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const data = await getAgentsConfig();
      setConfigData(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const onReload = async () => {
    const res = await reloadAgents();
    setReloadSummary({ before: res.before, after: res.after });
    await loadConfig();
  };

  return (
    <>
      <h2 style={styles.title}>配置中心</h2>
      <p style={styles.desc}>查看 workspace 与 DB 生效配置差异，支持一键 reload。</p>
      <div style={styles.actions}>
        <button style={styles.button} onClick={() => void loadConfig()} disabled={loading}>
          刷新配置
        </button>
        <button style={styles.buttonSecondary} onClick={() => void onReload()}>
          触发 reload
        </button>
      </div>
      <pre style={styles.streamBox}>{JSON.stringify(configData?.diffSummary ?? {}, null, 2)}</pre>
      {reloadSummary && (
        <div style={styles.meta}>
          <span>reload before: {reloadSummary.before}</span>
          <span>reload after: {reloadSummary.after}</span>
        </div>
      )}
    </>
  );
};

const styles: Record<string, CSSProperties> = {
  main: {
    flex: 1,
    overflow: "auto",
    padding: 32,
  },
  placeholder: {
    maxWidth: 800,
    margin: "0 auto",
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: "#e4e4e7",
    margin: "0 0 8px",
  },
  desc: {
    color: "#71717a",
    fontSize: 14,
    lineHeight: 1.6,
    margin: "0 0 32px",
  },
  subTitle: {
    fontSize: 16,
    margin: "20px 0 10px",
  },
  form: {
    display: "flex",
    gap: 8,
    marginBottom: 12,
  },
  input: {
    flex: 1,
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 10px",
  },
  select: {
    background: "#18181b",
    border: "1px solid #27272a",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 10px",
  },
  button: {
    background: "#7c3aed",
    border: "none",
    color: "#fff",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  },
  buttonSecondary: {
    background: "#27272a",
    border: "1px solid #3f3f46",
    color: "#e4e4e7",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
  },
  actions: {
    display: "flex",
    gap: 8,
    marginBottom: 12,
  },
  meta: {
    display: "flex",
    gap: 12,
    fontSize: 12,
    color: "#a1a1aa",
    marginBottom: 10,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 16,
  },
  card: {
    background: "#18181b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 16,
  },
  cardName: {
    fontSize: 14,
    fontWeight: 600,
    color: "#a78bfa",
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 12,
    color: "#71717a",
  },
  streamBox: {
    background: "#09090b",
    border: "1px solid #27272a",
    borderRadius: 8,
    padding: 12,
    maxHeight: 320,
    overflow: "auto",
    color: "#d4d4d8",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
};
