import { RefreshCw } from "lucide-react";
import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  createAgentDefinition,
  createAgentDraft,
  deleteAgentDefinition,
  postAgentDefinitionPackEnsureLayout,
  postAgentDefinitionPackSyncFromFs,
  putAgentDefinitionPackFiles,
  putAgentDefinitionPackSessionSnapshot,
  releaseAgentDraft,
  reloadAgents,
  reloadBuiltinAgentSeed,
  type ReloadBuiltinSeedResponse,
} from "../../api/backend";
import { httpGet } from "../../api/client";
import type {
  AgentDefinitionBundle,
  AgentMemoryStatsResponse,
  AgentPackResponse,
  McpServerConfigRecord,
  McpToolBindingRecord,
} from "../../api/types";
import { agentDisplayLabel, agentSelectOptionLabel } from "../../lib/agentDisplay";
import { AGENT_ROLE_OPTIONS, isBuiltinAgentDefinitionId } from "../../lib/agentRoles";
import type { ConfigSubPage } from "../../store";
import { AgentRuntimeTab } from "./AgentRuntimeTab";
import { IconToolbarButton } from "../ui/IconToolbarButton";

export type AgentConfigUiTab = "overview" | "prompts" | "workspace" | "memory" | "runtime";

export function parseAgentMcpServerNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim());
}

export type ConfigAgentPanelProps = {
  definitions: AgentDefinitionBundle[];
  selectedDefinitionId: string;
  onSelectDefinitionId: (id: string) => void;
  onResetAgentSelectionRef: () => void;
  onReloadAll: () => void;
  /** 在调用 `onReloadAll` 之前写入，以便刷新后仍选中新建的 definition。 */
  onPreferAgentAfterReload: (definitionId: string) => void;
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
  draftLlmProvider: string;
  setDraftLlmProvider: (v: string) => void;
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
  draftDisplayName: string;
  setDraftDisplayName: (v: string) => void;
  draftDescription: string;
  setDraftDescription: (v: string) => void;
  draftTools: string[];
  setDraftTools: (v: string[] | ((prev: string[]) => string[])) => void;
  draftMaxIterations: number;
  setDraftMaxIterations: (v: number) => void;
  draftSkills: string[];
  setDraftSkills: (v: string[] | ((prev: string[]) => string[])) => void;
  draftSubscriptions: string[];
  setDraftSubscriptions: (v: string[] | ((prev: string[]) => string[])) => void;
  skillInstalls: import("../../api/types").SkillMarketInstallRecord[];
  knownToolPool: string[];
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
};

const tabRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 14,
  alignItems: "center",
};
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
  onPreferAgentAfterReload,
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
  draftLlmProvider,
  setDraftLlmProvider,
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
  draftDisplayName,
  setDraftDisplayName,
  draftDescription,
  setDraftDescription,
  draftTools,
  setDraftTools,
  draftMaxIterations,
  setDraftMaxIterations,
  draftSkills,
  setDraftSkills,
  draftSubscriptions,
  setDraftSubscriptions,
  skillInstalls,
  knownToolPool,
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
}) => {
  const def = selectedBundle?.definition;
  const profile = selectedBundle?.profile;
  const displayTitle =
    draftDisplayName.trim() ||
    (selectedBundle ? agentDisplayLabel(selectedBundle) : def?.name || def?.role || "Agent");
  const [newRole, setNewRole] = useState<string>(AGENT_ROLE_OPTIONS[0] ?? "research");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [reloadSeedBusy, setReloadSeedBusy] = useState(false);
  const [reloadSeedMsg, setReloadSeedMsg] = useState<string | null>(null);

  /**
   * 已配置的 LLM provider 列表（来自 GET /api/v1/llm-providers），用于给 Agent 的
   * `llmProvider` 字段做下拉提示 + 配置状态徽章。失败不影响其余 UI。
   */
  type LlmProviderRow = {
    providerId: string;
    providerType: string;
    modelName: string;
    apiKeyConfigured: boolean;
    enabled: boolean;
  };
  const [llmProviderRows, setLlmProviderRows] = useState<LlmProviderRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void httpGet<{ ok: boolean; data: LlmProviderRow[] }>("/api/v1/llm-providers")
      .then((res) => {
        if (!cancelled) setLlmProviderRows(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setLlmProviderRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const llmProviderInfo = useMemo(() => {
    const id = draftLlmProvider.trim();
    if (!id) return { kind: "empty" as const };
    const row = llmProviderRows.find((r) => r.providerId === id);
    if (!row) return { kind: "unregistered" as const };
    if (!row.enabled) return { kind: "disabled" as const, row };
    if (!row.apiKeyConfigured && row.providerType !== "ollama") {
      return { kind: "no_api_key" as const, row };
    }
    return { kind: "ready" as const, row };
  }, [draftLlmProvider, llmProviderRows]);

  const sortedLlmProviderIds = useMemo(() => {
    const ids = llmProviderRows.map((r) => r.providerId);
    return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
  }, [llmProviderRows]);

  const draftLlmProviderTrim = draftLlmProvider.trim();
  const publishedLlmProvider = def?.llmProvider ?? "";
  const llmProviderDiverged =
    Boolean(selectedBundle) && draftLlmProviderTrim !== (publishedLlmProvider ?? "");

  const handleReloadBuiltinSeed = () => {
    if (
      !window.confirm(
        "重载系统预设将把所有内置 Agent 与系统协作预设重置回出厂配置，覆盖你对内置项的发布版改动。\n\n你自定义创建的 Agent 不会受影响。\n\n确定继续？"
      )
    ) {
      return;
    }
    setReloadSeedMsg(null);
    setReloadSeedBusy(true);
    void reloadBuiltinAgentSeed()
      .then((res: ReloadBuiltinSeedResponse) => {
        const d = res.report.definitions;
        const g = res.report.groups;
        setReloadSeedMsg(
          `已重载：Agent ${d.reset}/${d.total}，协作预设 ${g.reset}/${g.total}。运行时 ${res.runtime.before} → ${res.runtime.after}。`
        );
        onReloadAll();
      })
      .catch((e) => {
        setReloadSeedMsg(e instanceof Error ? `失败：${e.message}` : `失败：${String(e)}`);
      })
      .finally(() => setReloadSeedBusy(false));
  };

  const sortedDefinitions = useMemo(() => {
    return [...definitions].sort((a, b) => {
      const ae = a.definition.enabled !== false ? 0 : 1;
      const be = b.definition.enabled !== false ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.definition.role.localeCompare(b.definition.role);
    });
  }, [definitions]);

  const canDeleteSelected =
    Boolean(selectedDefinitionId) && !isBuiltinAgentDefinitionId(selectedDefinitionId);

  return (
    <>
      <h3
        style={{
          margin: "0 0 6px",
          fontSize: 18,
          fontWeight: 600,
          color: "var(--qb-agent-h3, #f4f4f5)",
        }}
      >
        Agent 配置
      </h3>
      <p className="qb-agent-help" style={{ maxWidth: 900 }}>
        分层与常见「文件 + 数据库」双源 Agent 编排对齐：<strong>概览</strong>管身份与 DB 草稿；
        <strong>提示词与文件</strong>对应 pack 内 <code>agent.md</code>（契约/能力，建议仅人改）、
        <code>soul.md</code>（人格与表达）、
        <code>workspace/prompt.md</code>（主任务说明，默认优先于 DB）以及 <code>user.md</code> /{" "}
        <code>memory.md</code>（会话快照，可经归纳或受控流程更新；注入系统提示前按码点截断）； DB
        侧仍有 <code>systemPrompt</code>（默认模式下作候补）与 <code>prompt_template_ref</code>
        （可指向包内其它模板文件，仅当无 <code>workspace/prompt.md</code> 时使用）。
        <strong>工作区</strong>目录含可写提示与沙箱文件；<strong>记忆</strong>按 definition 隔离；
        <strong>运行时</strong>页可配置工具 / MCP / Skills；从已在「MCP」页登记的服务端名中选择白名单（
        <code>mcp_servers_json</code>），并可在此登记<strong>带 definition_id 的工具绑定</strong>。
      </p>

      <div className="qb-agent-shell">
        {selectedBundle ? (
          <div className="qb-agent-hero">
            <div style={{ flex: "1 1 220px", minWidth: 0 }}>
              <h4 className="qb-agent-hero__title">{displayTitle}</h4>
              <p className="qb-agent-hero__sub">
                {def?.id} · role{" "}
                <strong style={{ color: "var(--qb-agent-strong, #d4d4d8)" }}>{def?.role}</strong> ·
                v{def?.version}
                {selectedBundle.draft ? (
                  <>
                    {" "}
                    · 草稿{" "}
                    <strong style={{ color: "var(--qb-agent-draft-accent, #c4b5fd)" }}>
                      {selectedBundle.draft.versionTag}
                    </strong>
                  </>
                ) : null}
              </p>
              {profile?.description ? (
                <p className="qb-agent-hero__desc">{profile.description}</p>
              ) : null}
            </div>
            <div className="qb-agent-badges">
              <span className={`qb-agent-badge${def?.enabled ? "" : " qb-agent-badge--muted"}`}>
                {def?.enabled ? "已启用" : "已禁用"}
              </span>
              <span
                className="qb-agent-badge--muted qb-agent-badge"
                title={
                  llmProviderInfo.kind === "ready"
                    ? `已在 LLM 模型库中配置：${llmProviderInfo.row.providerType} / ${llmProviderInfo.row.modelName}`
                    : llmProviderInfo.kind === "empty"
                      ? "未指定 llmProvider，将走 .qubit/model.json 默认模型"
                      : llmProviderInfo.kind === "unregistered"
                        ? "未在「LLM 模型」中登记，将尝试用环境变量 apiKey，否则降级到默认模型"
                        : llmProviderInfo.kind === "disabled"
                          ? "已在 LLM 模型库中禁用，将降级到默认模型"
                          : "已登记但缺 apiKey，将降级到默认模型"
                }
              >
                LLM: {draftLlmProviderTrim || "（默认）"}
                {llmProviderInfo.kind === "ready" ? null : (
                  <span
                    style={{
                      marginLeft: 4,
                      color:
                        llmProviderInfo.kind === "empty"
                          ? "var(--qb-agent-hint, #a1a1aa)"
                          : "#fbbf24",
                    }}
                  >
                    {llmProviderInfo.kind === "empty"
                      ? "·走默认"
                      : llmProviderInfo.kind === "unregistered"
                        ? "·未登记"
                        : llmProviderInfo.kind === "disabled"
                          ? "·已禁用"
                          : "·缺 apiKey"}
                  </span>
                )}
                {llmProviderDiverged ? (
                  <span style={{ marginLeft: 4, color: "var(--qb-agent-draft-accent, #c4b5fd)" }}>
                    （已发布 {publishedLlmProvider || "—"}）
                  </span>
                ) : null}
              </span>
              <span className="qb-agent-badge--muted qb-agent-badge">
                迭代上限: {draftMaxIterations}
                {selectedBundle.draft?.maxIterations != null &&
                selectedBundle.draft.maxIterations !== draftMaxIterations
                  ? `（已发布 ${def?.maxIterations ?? "—"}）`
                  : def?.maxIterations != null && def.maxIterations !== draftMaxIterations
                    ? `（已发布 ${def.maxIterations}）`
                    : null}
              </span>
            </div>
          </div>
        ) : definitions.length === 0 ? (
          <div className="qb-agent-hero">
            <p style={{ margin: 0, color: "var(--qb-agent-empty, #8e8e93)" }}>
              当前没有可用的 Agent 定义。若数据库已有数据但列表为空，请检查{" "}
              <code>/api/v1/agents/definitions</code>；也可在下方新建一条。
            </p>
          </div>
        ) : (
          <div className="qb-agent-hero">
            <p style={{ margin: 0, color: "var(--qb-agent-empty, #8e8e93)" }}>
              当前选中的 Agent 已不在列表中（可能为旧会话或数据已变更），请从左侧下拉重新选择。
            </p>
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
              {sortedDefinitions.map((item) => (
                <option key={item.definition.id} value={item.definition.id}>
                  {agentSelectOptionLabel(item)}
                </option>
              ))}
            </select>
            <IconToolbarButton
              Icon={RefreshCw}
              label="重新加载配置与 MCP 列表"
              onClick={() => void onReloadAll()}
            />
            {canDeleteSelected ? (
              <button
                type="button"
                className="qb-btn-secondary qb-btn--compact"
                style={{ color: "#f87171", borderColor: "#7f1d1d" }}
                disabled={deleteBusy || createBusy}
                onClick={() => {
                  if (!selectedDefinitionId) return;
                  const label = displayTitle;
                  if (!window.confirm(`确定删除自定义 Agent「${label}」？此操作不可恢复。`)) return;
                  setDeleteErr(null);
                  setDeleteBusy(true);
                  void deleteAgentDefinition(selectedDefinitionId)
                    .then(() => {
                      onResetAgentSelectionRef();
                      onSelectDefinitionId("");
                      onReloadAll();
                    })
                    .catch((e) => setDeleteErr(e instanceof Error ? e.message : String(e)))
                    .finally(() => setDeleteBusy(false));
                }}
              >
                {deleteBusy ? "删除中…" : "删除当前 Agent"}
              </button>
            ) : null}
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => onOpenMcpSubPage("mcp")}
            >
              打开 MCP 配置
            </button>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => onOpenMcpSubPage("skills")}
            >
              Skills 市场
            </button>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              style={{ color: "#fbbf24", borderColor: "#78350f" }}
              disabled={reloadSeedBusy}
              title="把所有内置 Agent / 系统协作预设重置回出厂配置（不影响你自建的 Agent）"
              onClick={handleReloadBuiltinSeed}
            >
              {reloadSeedBusy ? "重载中…" : "重载系统预设"}
            </button>
          </div>
          {reloadSeedMsg ? (
            <div
              style={{
                marginBottom: 10,
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 12,
                color: reloadSeedMsg.startsWith("失败")
                  ? "var(--qb-agent-warn, #f87171)"
                  : "var(--qb-agent-hint, #a1a1aa)",
                background: "var(--qb-main-panel-bg, #18181b)",
                border: "1px solid var(--qb-main-input-border, #3f3f46)",
              }}
            >
              {reloadSeedMsg}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "flex-end",
              marginBottom: 14,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--qb-main-input-border, #3f3f46)",
              background: "var(--qb-main-panel-bg, #18181b)",
            }}
          >
            <div style={{ flex: "1 1 160px", minWidth: 0 }}>
              <span style={label}>新建 Agent（角色）</span>
              <select style={input} value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                {AGENT_ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <span style={label}>显示名（可选）</span>
              <input
                style={input}
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="默认与后端生成的名称一致"
              />
            </div>
            <button
              type="button"
              className="qb-btn-secondary qb-btn--compact"
              disabled={createBusy}
              onClick={() => {
                setCreateErr(null);
                setCreateBusy(true);
                void createAgentDefinition({
                  role: newRole,
                  displayName: newDisplayName.trim() || undefined,
                })
                  .then((bundle) => {
                    onPreferAgentAfterReload(bundle.definition.id);
                    onReloadAll();
                  })
                  .catch((e) => setCreateErr(e instanceof Error ? e.message : String(e)))
                  .finally(() => setCreateBusy(false));
              }}
            >
              {createBusy ? "创建中…" : "新建 Agent"}
            </button>
            {createErr ? (
              <p style={{ margin: 0, flex: "1 1 100%", fontSize: 12, color: "#f87171" }}>
                {createErr}
              </p>
            ) : null}
            {deleteErr ? (
              <p style={{ margin: 0, flex: "1 1 100%", fontSize: 12, color: "#f87171" }}>
                {deleteErr}
              </p>
            ) : null}
          </div>

          <div
            className="qb-segmented qb-segmented--inline"
            style={{ width: "100%", marginBottom: 14 }}
          >
            {(
              [
                ["overview", "概览"],
                ["prompts", "提示词与文件"],
                ["workspace", "工作区"],
                ["memory", "记忆"],
                ["runtime", "运行时"],
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
                <span style={label}>中文显示名（保存草稿后生效）</span>
                <input
                  style={input}
                  value={draftDisplayName}
                  onChange={(e) => setDraftDisplayName(e.target.value)}
                  placeholder={agentDisplayLabel(selectedBundle)}
                />
                <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
                  角色 <code>{selectedBundle.definition.role}</code> · 内置名{" "}
                  {selectedBundle.definition.name}
                </p>
              </div>
              <div>
                <span style={label}>简介</span>
                <input
                  style={input}
                  value={draftDescription}
                  onChange={(e) => setDraftDescription(e.target.value)}
                  placeholder="可选，用于配置中心与团队目录展示"
                />
              </div>
              <div>
                <span style={label}>
                  llmProvider（运行时按此 ID 在「LLM 模型」中查模型，留空走默认模型）
                </span>
                <input
                  list="qb-llm-provider-ids"
                  style={input}
                  value={draftLlmProvider}
                  onChange={(e) => setDraftLlmProvider(e.target.value)}
                  placeholder="例如 openai:gpt-4o / anthropic:claude-sonnet-4 / 留空"
                />
                <datalist id="qb-llm-provider-ids">
                  {sortedLlmProviderIds.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 11,
                    color:
                      llmProviderInfo.kind === "ready"
                        ? "var(--qb-main-meta, #71717a)"
                        : llmProviderInfo.kind === "empty"
                          ? "var(--qb-main-meta, #71717a)"
                          : "#fbbf24",
                  }}
                >
                  {llmProviderInfo.kind === "ready"
                    ? `已就绪：${llmProviderInfo.row.providerType} / ${llmProviderInfo.row.modelName}`
                    : llmProviderInfo.kind === "empty"
                      ? "留空 → 运行时使用 .qubit/model.json 中的默认模型"
                      : llmProviderInfo.kind === "unregistered"
                        ? `「LLM 模型」中没有 providerId=${draftLlmProviderTrim} 的记录；运行时会尝试用环境变量（如 OPENAI_API_KEY）作为 apiKey，否则降级到默认模型`
                        : llmProviderInfo.kind === "disabled"
                          ? "该 provider 在「LLM 模型」中处于禁用状态，将降级到默认模型"
                          : "该 provider 已登记但缺 apiKey，将降级到默认模型 — 请到「LLM 模型」补齐 apiKey"}
                </p>
              </div>
              <div>
                <span style={label}>prompt_mode</span>
                <select
                  style={input}
                  value={draftPromptMode}
                  onChange={(e) => setDraftPromptMode(e.target.value as typeof draftPromptMode)}
                >
                  <option value="db_primary">
                    db_primary（workspace/prompt.md 优先，DB system_prompt 候补）
                  </option>
                  <option value="file_primary">
                    file_primary（磁盘契约层 + Instructions 为主）
                  </option>
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
                <input
                  style={input}
                  value={draftSoul}
                  onChange={(e) => setDraftSoul(e.target.value)}
                />
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
                <textarea
                  style={textarea}
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                />
              </div>
              <div>
                <span style={label}>changeNote</span>
                <input
                  style={input}
                  value={draftNote}
                  onChange={(e) => setDraftNote(e.target.value)}
                />
              </div>
              {agentPack ? (
                <div style={{ fontSize: 12, color: "var(--qb-sidebar-muted, #71717a)" }}>
                  磁盘 contentHash: {agentPack.contentHash.slice(0, 12)}… · profile 记录:{" "}
                  {(selectedBundle.profile?.configContentHash ?? "").slice(0, 12) || "—"}
                  {agentPack.contentHash !== (selectedBundle.profile?.configContentHash ?? "") ? (
                    <span style={{ color: "#eab308" }}>
                      {" "}
                      （与库中 hash 不一致，可在「提示词与文件」从磁盘同步）
                    </span>
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
                  onClick={() =>
                    void postAgentDefinitionPackEnsureLayout(selectedDefinitionId).then(() =>
                      onReloadAll()
                    )
                  }
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
                路径：agent: {agentPack?.agentPath ?? "—"} · soul: {agentPack?.soulPath ?? "—"} ·
                prompt: {agentPack?.promptPath ?? "—"} · user: {agentPack?.userPath ?? "—"} ·
                memory: {agentPack?.memoryPath ?? "—"}
              </p>
              <div>
                <span style={label}>
                  agent.md（契约层；建议仅由人或配置中心维护，勿交给 Agent 自改）
                </span>
                <textarea
                  style={{ ...textarea, minHeight: 120 }}
                  value={fileAgentMd}
                  onChange={(e) => setFileAgentMd(e.target.value)}
                />
              </div>
              <div>
                <span style={label}>soul.md</span>
                <textarea
                  style={{ ...textarea, minHeight: 160 }}
                  value={fileSoulMd}
                  onChange={(e) => setFileSoulMd(e.target.value)}
                />
              </div>
              <div>
                <span style={label}>workspace/prompt.md</span>
                <textarea
                  style={{ ...textarea, minHeight: 160 }}
                  value={filePromptMd}
                  onChange={(e) => setFilePromptMd(e.target.value)}
                />
              </div>
              <div>
                <span style={label}>
                  user.md（USER 快照，注入前截断至 {USER_SNAPSHOT_MAX_CP} 码点）
                  {cpLen(fileUserMd) > USER_SNAPSHOT_MAX_CP ? (
                    <span style={{ color: "#f87171", marginLeft: 6 }}>
                      （当前 {cpLen(fileUserMd)}，保存时服务端会截断）
                    </span>
                  ) : (
                    <span style={{ color: "var(--qb-sidebar-muted, #71717a)", marginLeft: 6 }}>
                      （{cpLen(fileUserMd)} / {USER_SNAPSHOT_MAX_CP}）
                    </span>
                  )}
                </span>
                <textarea
                  style={{ ...textarea, minHeight: 120 }}
                  value={fileUserMd}
                  onChange={(e) => setFileUserMd(e.target.value)}
                />
              </div>
              <div>
                <span style={label}>
                  memory.md（MEMORY 快照，注入前截断至 {MEMORY_SNAPSHOT_MAX_CP} 码点）
                  {cpLen(fileMemoryMd) > MEMORY_SNAPSHOT_MAX_CP ? (
                    <span style={{ color: "#f87171", marginLeft: 6 }}>
                      （当前 {cpLen(fileMemoryMd)}，保存时服务端会截断）
                    </span>
                  ) : (
                    <span style={{ color: "var(--qb-sidebar-muted, #71717a)", marginLeft: 6 }}>
                      （{cpLen(fileMemoryMd)} / {MEMORY_SNAPSHOT_MAX_CP}）
                    </span>
                  )}
                </span>
                <textarea
                  style={{ ...textarea, minHeight: 120 }}
                  value={fileMemoryMd}
                  onChange={(e) => setFileMemoryMd(e.target.value)}
                />
              </div>
              <p className="qb-agent-help" style={{ margin: 0, fontSize: 12, lineHeight: 1.55 }}>
                <code>agent.md</code> + <code>soul.md</code> + <code>workspace/prompt.md</code>{" "}
                对应契约 / 人格 / 任务层；<code>user.md</code> / <code>memory.md</code>{" "}
                为会话快照。默认 <code>db_primary</code> 下主任务以 <code>workspace/prompt.md</code>{" "}
                为准，DB <code>systemPrompt</code> 为空时才作正文来源；
                <code>prompt_template_ref</code> 仅在无
                <code>workspace/prompt.md</code> 时参与解析。其它 promptMode 见选项说明。
              </p>
            </div>
          ) : null}

          {agentUiTab === "workspace" && agentPack ? (
            <div style={{ fontSize: 13, color: "var(--qb-body-fg, #d4d4d8)" }}>
              <p style={{ marginTop: 0 }}>
                私有工作区路径：
                <code
                  style={{
                    background: "var(--qb-mcp-market-chip-bg, #27272a)",
                    padding: "2px 6px",
                    borderRadius: 4,
                  }}
                >
                  {agentPack.packRoot}/workspace/
                </code>
              </p>
              <p style={{ color: "var(--qb-main-meta, #a1a1aa)", fontSize: 12 }}>
                工具沙箱可通过 sandbox 策略 <code>allowedFsPaths</code>{" "}
                挂载该目录；初始化目录后会生成 <code>.gitkeep</code>。
              </p>
            </div>
          ) : null}

          {agentUiTab === "memory" ? (
            <div style={{ fontSize: 13, color: "var(--qb-body-fg, #d4d4d8)" }}>
              <p>
                逻辑命名空间：<strong>{agentPack?.memoryNamespace ?? "—"}</strong>
              </p>
              <p>
                中期记忆条数（带 definition_id）：
                <strong>{agentMemoryStats?.midtermCount ?? 0}</strong>
              </p>
              <p>
                长期记忆条数（带 definition_id）：
                <strong>{agentMemoryStats?.longtermCount ?? 0}</strong>
              </p>
              <p style={{ fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" }}>
                写入 native memory 时在 metadata 中携带 <code>definitionId</code>{" "}
                即可与条目标记关联。
              </p>
            </div>
          ) : null}

          {agentUiTab === "runtime" && selectedBundle ? (
            <AgentRuntimeTab
              selectedBundle={selectedBundle}
              draftTools={draftTools}
              setDraftTools={setDraftTools}
              draftMaxIterations={draftMaxIterations}
              setDraftMaxIterations={setDraftMaxIterations}
              draftSkills={draftSkills}
              setDraftSkills={setDraftSkills}
              draftMcpServerNames={draftMcpServerNames}
              setDraftMcpServerNames={setDraftMcpServerNames}
              draftSubscriptions={draftSubscriptions}
              setDraftSubscriptions={setDraftSubscriptions}
              draftPrompt={draftPrompt}
              draftPromptMode={draftPromptMode}
              mcpServers={mcpServers}
              mcpBindings={mcpBindings}
              skillInstalls={skillInstalls}
              currentProjectId={currentProjectId}
              knownToolPool={knownToolPool}
              onReloadAll={onReloadAll}
              pickBindingForMcpServer={pickBindingForMcpServer}
              mcpServerBindingCount={mcpServerBindingCount}
            />
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
              toolsJson: draftTools,
              maxIterations: draftMaxIterations,
              mcpServersJson: draftMcpServerNames,
              skillsJson: draftSkills,
              subscriptionsJson: draftSubscriptions,
              /**
               * 留空 → 写入空串：resolveLlmForAgent 看到空串会跳过 DB/inline 查找，
               * 直接降级到 .qubit/model.json 的默认模型（"" 在 if(agentProvider) 中为
               * falsy）。表 `agent_definition_draft.llm_provider` notNull 允许空串。
               */
              llmProvider: draftLlmProvider.trim(),
              profile: {
                displayName:
                  draftDisplayName.trim() ||
                  selectedBundle.profile?.displayName ||
                  selectedBundle.definition.name,
                soulFileRef: draftSoul,
                promptTemplateRef: draftPromptTemplateRef.trim() || undefined,
                description: draftDescription,
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
    </>
  );
};
