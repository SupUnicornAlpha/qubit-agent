import type { CSSProperties, FC } from "react";
import { useMemo, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import type {
  AgentDefinitionBundle,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  McpServerConfigRecord,
  McpToolBindingRecord,
} from "../../api/types";
import {
  createAgentDraft,
  postAgentDefinitionPackEnsureLayout,
  postAgentDefinitionPackSyncFromFs,
  putAgentDefinitionPackFiles,
  putAgentDefinitionPackSessionSnapshot,
  releaseAgentDraft,
  reloadAgents,
  upsertMcpBinding,
} from "../../api/backend";
import type { ConfigSubPage } from "../../store";
import { IconToolbarButton } from "../ui/IconToolbarButton";

export type AgentConfigUiTab = "overview" | "prompts" | "workspace" | "memory" | "mcp";

export function parseAgentMcpServerNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
}

function stringifyJson(v: unknown, max = 4000): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > max ? `${s.slice(0, max)}\n…` : s;
  } catch {
    return String(v);
  }
}

export type ConfigAgentPanelProps = {
  definitions: AgentDefinitionBundle[];
  selectedDefinitionId: string;
  onSelectDefinitionId: (id: string) => void;
  onResetAgentSelectionRef: () => void;
  onReloadAll: () => void;
  onOpenMcpSubPage: (page: ConfigSubPage) => void;
  agentUiTab: AgentConfigUiTab;
  setAgentUiTab: (t: AgentConfigUiTab) => void;
  selectedBundle: AgentDefinitionBundle | null;
  agentPack: AgentPackResponse | null;
  agentMemoryStats: AgentMemoryStatsResponse | null;
  draftPrompt: string;
  setDraftPrompt: (v: string) => void;
  draftSoul: string;
  setDraftSoul: (v: string) => void;
  draftPromptTemplateRef: string;
  setDraftPromptTemplateRef: (v: string) => void;
  draftNote: string;
  setDraftNote: (v: string) => void;
  draftPromptMode: "db_primary" | "file_primary" | "merged";
  setDraftPromptMode: (v: "db_primary" | "file_primary" | "merged") => void;
  draftMemoryNamespace: string;
  setDraftMemoryNamespace: (v: string) => void;
  draftConfigRootUri: string;
  setDraftConfigRootUri: (v: string) => void;
  draftMcpServerNames: string[];
  setDraftMcpServerNames: (v: string[] | ((prev: string[]) => string[])) => void;
  fileSoulMd: string;
  setFileSoulMd: (v: string) => void;
  filePromptMd: string;
  setFilePromptMd: (v: string) => void;
  fileAgentMd: string;
  setFileAgentMd: (v: string) => void;
  fileUserMd: string;
  setFileUserMd: (v: string) => void;
  fileMemoryMd: string;
  setFileMemoryMd: (v: string) => void;
  mcpServers: McpServerConfigRecord[];
  mcpBindings: McpToolBindingRecord[];
  currentProjectId: string;
  pickBindingForMcpServer: (serverName: string) => McpToolBindingRecord | undefined;
  mcpServerBindingCount: Map<string, number>;
  syncSummary: unknown;
};

const tabRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, alignItems: "center" };
const label: CSSProperties = {
  fontSize: 12,
  color: "var(--qb-main-meta, #a1a1aa)",
  display: "block",
  marginBottom: 4,
};
const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  background: "var(--qb-main-input-bg, #18181b)",
  color: "var(--qb-main-input-fg, #e4e4e7)",
  fontSize: 13,
};
const textarea: CSSProperties = {
  ...input,
  minHeight: 140,
  resize: "vertical" as const,
  fontFamily: "inherit",
  lineHeight: 1.45,
};

/** 与后端 `PACK_USER_SNAPSHOT_MAX_CP` / `PACK_MEMORY_SNAPSHOT_MAX_CP` 对齐（Unicode 码点） */
const USER_SNAPSHOT_MAX_CP = 1375;
const MEMORY_SNAPSHOT_MAX_CP = 2200;

function cpLen(s: string): number {
  return [...s].length;
}

export const ConfigAgentPanel: FC<ConfigAgentPanelProps> = ({
  definitions,
  selectedDefinitionId,
  onSelectDefinitionId,
  onResetAgentSelectionRef,
  onReloadAll,
  onOpenMcpSubPage,
  agentUiTab,
  setAgentUiTab,
  selectedBundle,
  agentPack,
  agentMemoryStats,
  draftPrompt,
  setDraftPrompt,
  draftSoul,
  setDraftSoul,
  draftPromptTemplateRef,
  setDraftPromptTemplateRef,
  draftNote,
  setDraftNote,
  draftPromptMode,
  setDraftPromptMode,
  draftMemoryNamespace,
  setDraftMemoryNamespace,
  draftConfigRootUri,
  setDraftConfigRootUri,
  draftMcpServerNames,
  setDraftMcpServerNames,
  fileSoulMd,
  setFileSoulMd,
  filePromptMd,
  setFilePromptMd,
  fileAgentMd,
  setFileAgentMd,
  fileUserMd,
  setFileUserMd,
  fileMemoryMd,
  setFileMemoryMd,
  mcpServers,
  mcpBindings,
  currentProjectId,
  pickBindingForMcpServer,
  mcpServerBindingCount,
  syncSummary,
}) => {
  const def = selectedBundle?.definition;
  const profile = selectedBundle?.profile;
  const displayTitle = profile?.displayName?.trim() || def?.name || def?.role || "Agent";
  const knownServerNames = new Set(mcpServers.map((s) => s.name));
  const serverOptions = useMemo(() => {
    const s = new Set<string>();
    for (const n of draftMcpServerNames) s.add(n);
    for (const r of mcpServers) {
      if (r.enabled) s.add(r.name);
    }
    return Array.from(s);
  }, [draftMcpServerNames, mcpServers]);
  const orphanMcp = draftMcpServerNames.filter((n) => !knownServerNames.has(n));

  const [regToolName, setRegToolName] = useState("");
  const [regTimeoutMs, setRegTimeoutMs] = useState("");
  const [regServer, setRegServer] = useState("");

  const agentScopedBindings = useMemo(() => {
    const id = def?.id;
    if (!id) return [];
    return mcpBindings.filter(
      (b) =>
        b.definitionId === id &&
        (!currentProjectId || b.projectId === currentProjectId || b.projectId == null)
    );
  }, [mcpBindings, def?.id, currentProjectId]);

  const serverForBindingForm =
    (regServer && serverOptions.includes(regServer) ? regServer : null) ??
    draftMcpServerNames[0] ??
    mcpServers.find((s) => s.enabled)?.name ??
    "";
  const effectiveBindServer = serverOptions.includes(serverForBindingForm)
    ? serverForBindingForm
    : (serverOptions[0] ?? "");

  const toggleMcp = (name: string) => {
    setDraftMcpServerNames((prev) => (prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]));
  };

  const selectAllEnabledMcp = () => {
    const names = mcpServers.filter((s) => s.enabled).map((s) => s.name);
    setDraftMcpServerNames(Array.from(new Set([...draftMcpServerNames, ...names])));
  };

  const clearMcp = () => setDraftMcpServerNames([]);

  return (
    <>
      <h3 style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 600, color: "var(--qb-agent-h3, #f4f4f5)" }}>Agent 配置</h3>
      <p className="qb-agent-help" style={{ maxWidth: 900 }}>
        分层与常见 Agent Runtime（如带 Hermes 式分区的编排）对齐：<strong>概览</strong>管身份与 DB 草稿；
        <strong>提示词与文件</strong>对应 pack 内 <code>agent.md</code>（契约/能力，建议仅人改）、<code>soul.md</code>（人格与表达）、
        <code>prompt.md</code>（任务层）以及 <code>user.md</code> / <code>memory.md</code>（会话级 USER / MEMORY 快照，可经归纳或受控流程更新；注入系统提示前按码点截断）；
        DB 侧仍有 <code>systemPrompt</code> 与 <code>prompt_template_ref</code>。<strong>工作区</strong>为沙箱目录；<strong>记忆</strong>按 definition 隔离；
        <strong>MCP 与运行时</strong>从已在「MCP」页登记的服务端名中选择白名单（<code>mcp_servers_json</code>），并可在此登记<strong>带 definition_id 的工具绑定</strong>。
      </p>

      <div className="qb-agent-shell">
        {selectedBundle ? (
          <div className="qb-agent-hero">
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <h4 className="qb-agent-hero__title">{displayTitle}</h4>
              <p className="qb-agent-hero__sub">
                {def?.id} · role <strong style={{ color: "var(--qb-agent-strong, #d4d4d8)" }}>{def?.role}</strong> · v{def?.version}
                {selectedBundle.draft ? (
                  <>
                    {" "}
                    · 草稿 <strong style={{ color: "var(--qb-agent-draft-accent, #c4b5fd)" }}>{selectedBundle.draft.versionTag}</strong>
                  </>
                ) : null}
              </p>
              {profile?.description ? <p className="qb-agent-hero__desc">{profile.description}</p> : null}
            </div>
            <div className="qb-agent-badges">
              <span className={`qb-agent-badge${def?.enabled ? "" : " qb-agent-badge--muted"}`}>
                {def?.enabled ? "已启用" : "已禁用"}
              </span>
              <span className="qb-agent-badge--muted qb-agent-badge">LLM: {def?.llmProvider ?? "—"}</span>
              <span className="qb-agent-badge--muted qb-agent-badge">迭代上限: {def?.maxIterations ?? "—"}</span>
            </div>
          </div>
        ) : (
          <div className="qb-agent-hero">
            <p style={{ margin: 0, color: "var(--qb-agent-empty, #8e8e93)" }}>未加载到 Agent 定义，请先在后端种子数据或检查 API。</p>
          </div>
        )}

        <div className="qb-agent-body">
          <div style={{ ...tabRow, marginBottom: 12 }}>
            <select
              style={{ ...input, maxWidth: 360, width: "auto", flex: "1 1 200px" }}
              value={selectedDefinitionId}
              onChange={(e) => {
                onResetAgentSelectionRef();
                onSelectDefinitionId(e.target.value);
              }}
            >
              {definitions.map((item) => (
                <option key={item.definition.id} value={item.definition.id}>
                  {item.definition.role} · {item.definition.version} — {item.definition.name}
                </option>
              ))}
            </select>
            <IconToolbarButton Icon={RefreshCw} label="重新加载配置与 MCP 列表" onClick={() => void onReloadAll()} />
            <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={() => onOpenMcpSubPage("mcp")}>
              打开 MCP 配置
            </button>
            <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={() => onOpenMcpSubPage("skills")}>
              Skills 市场
            </button>
          </div>

          <div className="qb-segmented qb-segmented--inline" style={{ width: "100%", marginBottom: 14 }}>
            {(
              [
                ["overview", "概览"],
                ["prompts", "提示词与文件"],
                ["workspace", "工作区"],
                ["memory", "记忆"],
                ["mcp", "MCP 与运行时"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`qb-segmented__tab${agentUiTab === id ? " qb-segmented__tab--active" : ""}`}
                onClick={() => setAgentUiTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {agentUiTab === "overview" && selectedBundle ? (
            <div className="qb-agent-field-grid">
              <div>
                <span style={label}>prompt_mode</span>
                <select style={input} value={draftPromptMode} onChange={(e) => setDraftPromptMode(e.target.value as typeof draftPromptMode)}>
                  <option value="db_primary">db_primary（仅数据库 systemPrompt）</option>
                  <option value="file_primary">file_primary（磁盘 soul + prompt 为主）</option>
                  <option value="merged">merged（文件 + DB 叠加）</option>
                </select>
              </div>
              <div>
                <span style={label}>memory_namespace（空则 def:&lt;id&gt;）</span>
                <input
                  style={input}
                  value={draftMemoryNamespace}
                  onChange={(e) => setDraftMemoryNamespace(e.target.value)}
                  placeholder="例如 def:def-orchestrator"
                />
              </div>
              <div>
                <span style={label}>config_root_uri（空则 dataDir/agents/&lt;id&gt;）</span>
                <input
                  style={input}
                  value={draftConfigRootUri}
                  onChange={(e) => setDraftConfigRootUri(e.target.value)}
                  placeholder="留空或 file:///... 绝对路径"
                />
              </div>
              <div>
                <span style={label}>soul_file_ref（相对包根或绝对路径）</span>
                <input style={input} value={draftSoul} onChange={(e) => setDraftSoul(e.target.value)} />
              </div>
              <div>
                <span style={label}>prompt_template_ref（可选，额外模板文件引用）</span>
                <input
                  style={input}
                  value={draftPromptTemplateRef}
                  onChange={(e) => setDraftPromptTemplateRef(e.target.value)}
                  placeholder="例如 templates/research.md 或留空"
                />
              </div>
              <div>
                <span style={label}>DB systemPrompt（草稿，随「保存草稿」写入）</span>
                <textarea style={textarea} value={draftPrompt} onChange={(e) => setDraftPrompt(e.target.value)} />
              </div>
              <div>
                <span style={label}>changeNote</span>
                <input style={input} value={draftNote} onChange={(e) => setDraftNote(e.target.value)} />
              </div>
              {agentPack ? (
                <div style={{ fontSize: 12, color: "var(--qb-sidebar-muted, #71717a)" }}>
                  磁盘 contentHash: {agentPack.contentHash.slice(0, 12)}… · profile 记录:{" "}
                  {(selectedBundle.profile?.configContentHash ?? "").slice(0, 12) || "—"}
                  {agentPack.contentHash !== (selectedBundle.profile?.configContentHash ?? "") ? (
                    <span style={{ color: "#eab308" }}> （与库中 hash 不一致，可在「提示词与文件」从磁盘同步）</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {agentUiTab === "prompts" && selectedDefinitionId ? (
            <div className="qb-agent-field-grid">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  onClick={() => void postAgentDefinitionPackEnsureLayout(selectedDefinitionId).then(() => onReloadAll())}
                >
                  初始化目录
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  onClick={() =>
                    void putAgentDefinitionPackFiles(selectedDefinitionId, {
                      agentMarkdown: fileAgentMd,
                      soulMarkdown: fileSoulMd,
                      promptMarkdown: filePromptMd,
                    }).then(() => onReloadAll())
                  }
                >
                  保存 agent / soul / prompt
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  onClick={() =>
                    void putAgentDefinitionPackSessionSnapshot(selectedDefinitionId, {
                      userMarkdown: fileUserMd,
                      memoryMarkdown: fileMemoryMd,
                    }).then(() => onReloadAll())
                  }
                >
                  保存 user / memory 快照
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  onClick={() =>
                    void postAgentDefinitionPackSyncFromFs(selectedDefinitionId).then(() =>
                      Promise.all([reloadAgents(), onReloadAll()])
                    )
                  }
                >
                  从磁盘同步到 DB
                </button>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: "var(--qb-sidebar-muted, #71717a)" }}>
                路径：agent: {agentPack?.agentPath ?? "—"} · soul: {agentPack?.soulPath ?? "—"} · prompt:{" "}
                {agentPack?.promptPath ?? "—"} · user: {agentPack?.userPath ?? "—"} · memory: {agentPack?.memoryPath ?? "—"}
              </p>
              <div>
                <span style={label}>
                  agent.md（契约层；建议仅由人或配置中心维护，勿交给 Agent 自改）
                </span>
                <textarea style={{ ...textarea, minHeight: 120 }} value={fileAgentMd} onChange={(e) => setFileAgentMd(e.target.value)} />
              </div>
              <div>
                <span style={label}>soul.md</span>
                <textarea style={{ ...textarea, minHeight: 160 }} value={fileSoulMd} onChange={(e) => setFileSoulMd(e.target.value)} />
              </div>
              <div>
                <span style={label}>prompt.md</span>
                <textarea style={{ ...textarea, minHeight: 160 }} value={filePromptMd} onChange={(e) => setFilePromptMd(e.target.value)} />
              </div>
              <div>
                <span style={label}>
                  user.md（USER 快照，注入前截断至 {USER_SNAPSHOT_MAX_CP} 码点）
                  {cpLen(fileUserMd) > USER_SNAPSHOT_MAX_CP ? (
                    <span style={{ color: "#f87171", marginLeft: 6 }}>（当前 {cpLen(fileUserMd)}，保存时服务端会截断）</span>
                  ) : (
                    <span style={{ color: "var(--qb-sidebar-muted, #71717a)", marginLeft: 6 }}>（{cpLen(fileUserMd)} / {USER_SNAPSHOT_MAX_CP}）</span>
                  )}
                </span>
                <textarea style={{ ...textarea, minHeight: 120 }} value={fileUserMd} onChange={(e) => setFileUserMd(e.target.value)} />
              </div>
              <div>
                <span style={label}>
                  memory.md（MEMORY 快照，注入前截断至 {MEMORY_SNAPSHOT_MAX_CP} 码点）
                  {cpLen(fileMemoryMd) > MEMORY_SNAPSHOT_MAX_CP ? (
                    <span style={{ color: "#f87171", marginLeft: 6 }}>（当前 {cpLen(fileMemoryMd)}，保存时服务端会截断）</span>
                  ) : (
                    <span style={{ color: "var(--qb-sidebar-muted, #71717a)", marginLeft: 6 }}>（{cpLen(fileMemoryMd)} / {MEMORY_SNAPSHOT_MAX_CP}）</span>
                  )}
                </span>
                <textarea style={{ ...textarea, minHeight: 120 }} value={fileMemoryMd} onChange={(e) => setFileMemoryMd(e.target.value)} />
              </div>
              <p className="qb-agent-help" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>
                与 Hermes 对照：<code>agent.md</code> + <code>soul.md</code> + <code>prompt.md</code> 对应契约 / 人格 / 任务层；<code>user.md</code> /{" "}
                <code>memory.md</code> 对应冻结的 USER / MEMORY 片段。DB <code>systemPrompt</code> 与 <code>prompt_template_ref</code> 仍可按 promptMode
                合并。仓库级 <code>AGENTS.md</code> 等若需要，可合并进 <code>agent.md</code> 或模板引用。
              </p>
            </div>
          ) : null}

          {agentUiTab === "workspace" && agentPack ? (
            <div style={{ fontSize: 13, color: "var(--qb-body-fg, #d4d4d8)" }}>
              <p style={{ marginTop: 0 }}>
                私有工作区路径：
                <code style={{ background: "var(--qb-mcp-market-chip-bg, #27272a)", padding: "2px 6px", borderRadius: 4 }}>{agentPack.packRoot}/workspace/</code>
              </p>
              <p style={{ color: "var(--qb-main-meta, #a1a1aa)", fontSize: 12 }}>
                工具沙箱可通过 sandbox 策略 <code>allowedFsPaths</code> 挂载该目录；初始化目录后会生成 <code>.gitkeep</code>。
              </p>
            </div>
          ) : null}

          {agentUiTab === "memory" ? (
            <div style={{ fontSize: 13, color: "var(--qb-body-fg, #d4d4d8)" }}>
              <p>
                逻辑命名空间：<strong>{agentPack?.memoryNamespace ?? "—"}</strong>
              </p>
              <p>
                中期记忆条数（带 definition_id）：<strong>{agentMemoryStats?.midtermCount ?? 0}</strong>
              </p>
              <p>
                长期记忆条数（带 definition_id）：<strong>{agentMemoryStats?.longtermCount ?? 0}</strong>
              </p>
              <p style={{ fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" }}>
                写入 native memory 时在 metadata 中携带 <code>definitionId</code> 即可与条目标记关联。
              </p>
            </div>
          ) : null}

          {agentUiTab === "mcp" && selectedBundle ? (
            <div className="qb-agent-field-grid">
              <p style={{ margin: 0, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)", lineHeight: 1.5 }}>
                下列服务端名来自当前项目的 <strong>MCP</strong> 登记（与配置页「MCP」一致）。勾选即加入该 Agent 的{" "}
                <code>mcp_servers_json</code>，运行时在 Graph 中作为可连 MCP 白名单；具体工具探测仍依赖各 Server 下的工具绑定。
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={selectAllEnabledMcp}>
                  勾选全部已启用
                </button>
                <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={clearMcp}>
                  清空
                </button>
                <span style={{ fontSize: 11, color: "var(--qb-sidebar-muted, #52525b)" }}>project: {currentProjectId || "—"}</span>
              </div>
              <div className="qb-mcp-pool">
                {mcpServers.length === 0 ? (
                  <span style={{ fontSize: 12, color: "var(--qb-sidebar-muted, #71717a)" }}>暂无 MCP Server，请先到「MCP」页添加。</span>
                ) : (
                  mcpServers.map((s) => {
                    const on = draftMcpServerNames.includes(s.name);
                    const bind = pickBindingForMcpServer(s.name);
                    const nBind = mcpServerBindingCount.get(s.name) ?? 0;
                    const disabled = !s.enabled;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={disabled}
                        title={
                          disabled
                            ? "该 Server 已禁用，请先在 MCP 页启用"
                            : `${bind?.toolName ? `绑定工具 ${bind.toolName}` : "未绑定工具"} · 绑定条数 ${nBind}`
                        }
                        className={`qb-mcp-chip${on ? " qb-mcp-chip--on" : ""}`}
                        onClick={() => !disabled && toggleMcp(s.name)}
                      >
                        <Server size={14} strokeWidth={2} aria-hidden />
                        {s.name}
                      </button>
                    );
                  })
                )}
              </div>
              {orphanMcp.length > 0 ? (
                <p style={{ margin: 0, fontSize: 11, color: "#eab308" }}>
                  以下名称已在白名单但当前项目未登记同名 Server（可保留或移除）：{orphanMcp.join(", ")}
                </p>
              ) : null}
              {def?.id && currentProjectId ? (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--qb-main-input-border, #27272a)" }}>
                  <span style={label}>本 Agent 的 MCP 工具绑定（definition_id）</span>
                  <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--qb-sidebar-muted, #71717a)", lineHeight: 1.5 }}>
                    运行图里调用 MCP 时会优先匹配带当前 Agent id 的绑定，其次为 definition_id 为空的项目级绑定。请先勾选上方白名单并填写工具名（可用 <code>*</code>{" "}
                    表示通配）；登记后可在「MCP」页统一管理。
                  </p>
                  {agentScopedBindings.length > 0 ? (
                    <pre className="qb-json-preview" style={{ marginBottom: 10, maxHeight: 160 }}>
                      {JSON.stringify(
                        agentScopedBindings.map((b) => ({
                          server: b.serverName,
                          tool: b.toolName,
                          enabled: b.enabled,
                          timeoutMs: b.timeoutMs,
                        })),
                        null,
                        2
                      )}
                    </pre>
                  ) : (
                    <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--qb-sidebar-muted, #52525b)" }}>尚无仅本 Agent 的绑定。</p>
                  )}
                  <div style={{ display: "grid", gap: 10, maxWidth: 480 }}>
                    <div>
                      <span style={label}>Server</span>
                      <select
                        style={input}
                        value={effectiveBindServer}
                        onChange={(e) => setRegServer(e.target.value)}
                      >
                        {serverOptions.length === 0 ? (
                          <option value="">请先在「MCP」页添加已启用的 Server</option>
                        ) : null}
                        {serverOptions.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span style={label}>tool_name</span>
                      <input
                        style={input}
                        value={regToolName}
                        onChange={(e) => setRegToolName(e.target.value)}
                        placeholder="例如 tools/list 或 *"
                      />
                    </div>
                    <div>
                      <span style={label}>timeout_ms（可选）</span>
                      <input
                        style={input}
                        value={regTimeoutMs}
                        onChange={(e) => setRegTimeoutMs(e.target.value)}
                        placeholder="留空则用默认"
                      />
                    </div>
                    <button
                      type="button"
                      className="qb-btn-secondary"
                      disabled={!effectiveBindServer.trim() || !regToolName.trim()}
                      onClick={() => {
                        const t = regToolName.trim();
                        if (!def?.id || !currentProjectId || !effectiveBindServer || !t) return;
                        const ms = regTimeoutMs.trim() ? Number(regTimeoutMs) : undefined;
                        void upsertMcpBinding({
                          projectId: currentProjectId,
                          definitionId: def.id,
                          serverName: effectiveBindServer,
                          toolName: t,
                          timeoutMs: ms !== undefined && !Number.isNaN(ms) ? ms : undefined,
                        }).then(() => {
                          setRegToolName("");
                          setRegTimeoutMs("");
                          void onReloadAll();
                        });
                      }}
                    >
                      登记本 Agent 绑定
                    </button>
                  </div>
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 11, color: "var(--qb-sidebar-muted, #52525b)" }}>
                  {!currentProjectId ? "选择工作区项目后可登记带 definition_id 的绑定。" : null}
                </p>
              )}
              <div>
                <span style={label}>当前 mcp_servers_json（将随草稿保存）</span>
                <pre className="qb-json-preview">{JSON.stringify(draftMcpServerNames, null, 2)}</pre>
              </div>
              <div>
                <span style={label}>tools_json（只读，来自已发布 definition）</span>
                <pre className="qb-json-preview">{stringifyJson(selectedBundle.definition.toolsJson)}</pre>
              </div>
              <div>
                <span style={label}>skills_json（只读）</span>
                <pre className="qb-json-preview">{stringifyJson(selectedBundle.definition.skillsJson)}</pre>
              </div>
              <div>
                <span style={label}>subscriptions_json（只读）</span>
                <pre className="qb-json-preview">{stringifyJson(selectedBundle.definition.subscriptionsJson)}</pre>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: "var(--qb-sidebar-muted, #52525b)" }}>
                绑定明细（当前项目，含各 Agent 的 definition_id）共{" "}
                {mcpBindings.filter((b) => !currentProjectId || b.projectId === currentProjectId || b.projectId == null).length}{" "}
                条；完整编辑可在「MCP」页或本页「登记本 Agent 绑定」。
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
        <button
          type="button"
          className="qb-btn-primary-brand"
          disabled={!selectedBundle}
          onClick={() =>
            selectedBundle &&
            void createAgentDraft({
              definitionId: selectedBundle.definition.id,
              systemPrompt: draftPrompt,
              changeNote: draftNote,
              mcpServersJson: draftMcpServerNames,
              profile: {
                displayName: selectedBundle.profile?.displayName ?? selectedBundle.definition.name,
                soulFileRef: draftSoul,
                promptTemplateRef: draftPromptTemplateRef.trim() || undefined,
                description: selectedBundle.profile?.description ?? "",
                configRootUri: draftConfigRootUri,
                memoryNamespace: draftMemoryNamespace,
                promptMode: draftPromptMode,
              },
            }).then(() => onReloadAll())
          }
        >
          保存草稿
        </button>
        <button
          type="button"
          className="qb-btn-secondary"
          disabled={!selectedBundle?.draft}
          onClick={() =>
            selectedBundle?.draft &&
            void releaseAgentDraft({
              definitionId: selectedBundle.definition.id,
              draftId: selectedBundle.draft.id,
              releasedVersion: selectedBundle.definition.version,
              releaseNote: draftNote,
            }).then(() => onReloadAll())
          }
        >
          发布草稿
        </button>
      </div>

      <h4 style={{ margin: "18px 0 8px", fontSize: 14, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>DB / 工作区文件同步摘要</h4>
      <pre className="qb-json-preview" style={{ maxHeight: 360 }}>
        {JSON.stringify(syncSummary ?? {}, null, 2)}
      </pre>
    </>
  );
};
