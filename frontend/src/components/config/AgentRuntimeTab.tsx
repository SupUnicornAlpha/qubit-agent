import { ChevronDown, ChevronRight, Server } from "lucide-react";
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { postAgentPromptPreview, upsertMcpBinding } from "../../api/backend";
import type {
  AgentDefinitionBundle,
  AgentPromptPreviewResponse,
  McpServerConfigRecord,
  McpToolBindingRecord,
  SkillMarketInstallRecord,
} from "../../api/types";

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

function parseStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(
      v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim())
    ),
  ];
}

function toggleInList(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

const Collapsible: FC<{
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}> = ({ title, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        border: "1px solid var(--qb-main-input-border, #27272a)",
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--qb-main-panel-bg, #141416)",
      }}
    >
      <summary
        style={{
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--qb-team-section-fg, #cbd5e1)",
          listStyle: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </summary>
      <div style={{ marginTop: 10 }}>{children}</div>
    </details>
  );
};

export const AgentRuntimeTab: FC<{
  selectedBundle: AgentDefinitionBundle;
  draftTools: string[];
  setDraftTools: (v: string[] | ((p: string[]) => string[])) => void;
  draftSkills: string[];
  setDraftSkills: (v: string[] | ((p: string[]) => string[])) => void;
  draftMcpServerNames: string[];
  setDraftMcpServerNames: (v: string[] | ((p: string[]) => string[])) => void;
  draftSubscriptions: string[];
  setDraftSubscriptions: (v: string[] | ((p: string[]) => string[])) => void;
  draftPrompt: string;
  draftPromptMode: "db_primary" | "file_primary" | "merged";
  mcpServers: McpServerConfigRecord[];
  mcpBindings: McpToolBindingRecord[];
  skillInstalls: SkillMarketInstallRecord[];
  currentProjectId: string;
  knownToolPool: string[];
  onReloadAll: () => void;
  pickBindingForMcpServer: (serverName: string) => McpToolBindingRecord | undefined;
  mcpServerBindingCount: Map<string, number>;
}> = ({
  selectedBundle,
  draftTools,
  setDraftTools,
  draftSkills,
  setDraftSkills,
  draftMcpServerNames,
  setDraftMcpServerNames,
  draftSubscriptions,
  setDraftSubscriptions,
  draftPrompt,
  draftPromptMode,
  mcpServers,
  mcpBindings,
  skillInstalls,
  currentProjectId,
  knownToolPool,
  onReloadAll,
  pickBindingForMcpServer,
  mcpServerBindingCount,
}) => {
  const def = selectedBundle.definition;
  const [newTool, setNewTool] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const [regToolName, setRegToolName] = useState("");
  const [regTimeoutMs, setRegTimeoutMs] = useState("");
  const [regServer, setRegServer] = useState("");
  const [preview, setPreview] = useState<AgentPromptPreviewResponse | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [showSectionPrompt, setShowSectionPrompt] = useState(false);

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

  const skillPool = useMemo(() => {
    const s = new Set<string>(draftSkills);
    for (const row of skillInstalls) {
      if (row.skillName?.trim()) s.add(row.skillName.trim());
    }
    for (const x of parseStringList(selectedBundle.definition.skillsJson)) s.add(x);
    return Array.from(s).sort();
  }, [draftSkills, skillInstalls, selectedBundle.definition.skillsJson]);

  const toolPool = useMemo(() => {
    const s = new Set<string>(knownToolPool);
    for (const t of draftTools) s.add(t);
    return Array.from(s).sort();
  }, [knownToolPool, draftTools]);

  const subscriptionPool = useMemo(
    () => ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK", "ORDER_INTENT", "MODEL_UPDATE", "MEMORY_WRITE"],
    []
  );

  const agentScopedBindings = useMemo(
    () =>
      mcpBindings.filter(
        (b) =>
          b.definitionId === def.id &&
          (!currentProjectId || b.projectId === currentProjectId || b.projectId == null)
      ),
    [mcpBindings, def.id, currentProjectId]
  );

  const refreshPreview = useCallback(() => {
    setPreviewErr(null);
    setPreviewBusy(true);
    void postAgentPromptPreview(def.id, {
      systemPrompt: draftPrompt,
      promptMode: draftPromptMode,
      toolsJson: draftTools,
      mcpServersJson: draftMcpServerNames,
      skillsJson: draftSkills,
      subscriptionsJson: draftSubscriptions,
    })
      .then(setPreview)
      .catch((e) => {
        setPreview(null);
        setPreviewErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setPreviewBusy(false));
  }, [
    def.id,
    draftPrompt,
    draftPromptMode,
    draftTools,
    draftMcpServerNames,
    draftSkills,
    draftSubscriptions,
  ]);

  useEffect(() => {
    void refreshPreview();
  }, [refreshPreview]);

  const effectiveBindServer =
    (regServer && serverOptions.includes(regServer) ? regServer : null) ??
    draftMcpServerNames[0] ??
    mcpServers.find((s) => s.enabled)?.name ??
    "";

  const selectAllEnabledMcp = () => {
    setDraftMcpServerNames(mcpServers.filter((s) => s.enabled).map((s) => s.name));
  };

  return (
    <div className="qb-agent-field-grid" style={{ gap: 16 }}>
      <section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>内置工具</span>
          <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>勾选写入 tools_json（保存草稿后生效）</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {toolPool.map((t) => {
            const on = draftTools.includes(t);
            return (
              <button
                key={t}
                type="button"
                className={`qb-mcp-chip${on ? " qb-mcp-chip--on" : ""}`}
                onClick={() => setDraftTools((prev) => toggleInList(prev, t))}
              >
                {t}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, maxWidth: 420 }}>
          <input
            style={input}
            value={newTool}
            onChange={(e) => setNewTool(e.target.value)}
            placeholder="添加自定义工具名"
          />
          <button
            type="button"
            className="qb-btn-secondary qb-btn--compact"
            disabled={!newTool.trim()}
            onClick={() => {
              const t = newTool.trim();
              if (!t) return;
              setDraftTools((prev) => (prev.includes(t) ? prev : [...prev, t]));
              setNewTool("");
            }}
          >
            添加
          </button>
        </div>
      </section>

      <section>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>MCP 服务白名单</span>
          <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={selectAllEnabledMcp}>
            勾选全部已启用
          </button>
          <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={() => setDraftMcpServerNames([])}>
            清空
          </button>
        </div>
        <div className="qb-mcp-pool">
          {mcpServers.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--qb-sidebar-muted, #71717a)" }}>暂无 MCP，请先到「MCP」页添加。</span>
          ) : (
            mcpServers.map((s) => {
              const on = draftMcpServerNames.includes(s.name);
              const bind = pickBindingForMcpServer(s.name);
              const nBind = mcpServerBindingCount.get(s.name) ?? 0;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={!s.enabled}
                  title={`${bind?.toolName ? `工具 ${bind.toolName}` : "未绑定"} · 绑定 ${nBind} 条`}
                  className={`qb-mcp-chip${on ? " qb-mcp-chip--on" : ""}`}
                  onClick={() => !s.enabled || setDraftMcpServerNames((p) => toggleInList(p, s.name))}
                >
                  <Server size={14} strokeWidth={2} aria-hidden />
                  {s.name}
                </button>
              );
            })
          )}
        </div>
        {orphanMcp.length > 0 ? (
          <p style={{ margin: "8px 0 0", fontSize: 11, color: "#eab308" }}>
            白名单中未登记的服务：{orphanMcp.join(", ")}
          </p>
        ) : null}
      </section>

      <section>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)", display: "block", marginBottom: 8 }}>
          Skills
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {skillPool.map((sk) => {
            const on = draftSkills.includes(sk);
            return (
              <button
                key={sk}
                type="button"
                className={`qb-mcp-chip${on ? " qb-mcp-chip--on" : ""}`}
                onClick={() => setDraftSkills((p) => toggleInList(p, sk))}
              >
                {sk}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, maxWidth: 420 }}>
          <input style={input} value={newSkill} onChange={(e) => setNewSkill(e.target.value)} placeholder="技能 id / 名称" />
          <button
            type="button"
            className="qb-btn-secondary qb-btn--compact"
            disabled={!newSkill.trim()}
            onClick={() => {
              const s = newSkill.trim();
              if (!s) return;
              setDraftSkills((p) => (p.includes(s) ? p : [...p, s]));
              setNewSkill("");
            }}
          >
            添加
          </button>
        </div>
      </section>

      <section>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)", display: "block", marginBottom: 8 }}>
          消息订阅
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {subscriptionPool.map((sub) => {
            const on = draftSubscriptions.includes(sub);
            return (
              <button
                key={sub}
                type="button"
                className={`qb-mcp-chip${on ? " qb-mcp-chip--on" : ""}`}
                onClick={() => setDraftSubscriptions((p) => toggleInList(p, sub))}
              >
                {sub}
              </button>
            );
          })}
        </div>
      </section>

      {def.id && currentProjectId ? (
        <section
          style={{ paddingTop: 12, borderTop: "1px solid var(--qb-main-input-border, #27272a)" }}
        >
          <span style={label}>本 Agent 的 MCP 工具绑定</span>
          {agentScopedBindings.length > 0 ? (
            <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 12, color: "var(--qb-body-fg, #d4d4d8)" }}>
              {agentScopedBindings.map((b) => (
                <li key={b.id}>
                  {b.serverName} · {b.toolName}
                  {b.timeoutMs != null ? ` · ${b.timeoutMs}ms` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--qb-sidebar-muted, #52525b)" }}>尚无绑定。</p>
          )}
          <div style={{ display: "grid", gap: 8, maxWidth: 480 }}>
            <select style={input} value={effectiveBindServer} onChange={(e) => setRegServer(e.target.value)}>
              {serverOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              style={input}
              value={regToolName}
              onChange={(e) => setRegToolName(e.target.value)}
              placeholder="tool_name 或 *"
            />
            <input
              style={input}
              value={regTimeoutMs}
              onChange={(e) => setRegTimeoutMs(e.target.value)}
              placeholder="timeout_ms（可选）"
            />
            <button
              type="button"
              className="qb-btn-secondary qb-btn--compact"
              disabled={!effectiveBindServer.trim() || !regToolName.trim()}
              onClick={() => {
                const t = regToolName.trim();
                if (!effectiveBindServer || !t) return;
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
                  onReloadAll();
                });
              }}
            >
              登记绑定
            </button>
          </div>
        </section>
      ) : null}

      <section style={{ paddingTop: 8, borderTop: "1px solid var(--qb-main-input-border, #27272a)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>
            系统提示词预览（组装后）
          </span>
          <button type="button" className="qb-btn-ghost qb-btn--compact" disabled={previewBusy} onClick={refreshPreview}>
            {previewBusy ? "刷新中…" : "刷新预览"}
          </button>
          <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
            mode: {preview?.promptMode ?? draftPromptMode} · pack: {preview?.packMeta.packRoot ?? "—"}
          </span>
        </div>
        {previewErr ? <p style={{ fontSize: 12, color: "#f87171", margin: "0 0 8px" }}>{previewErr}</p> : null}
        {preview ? (
          <>
            <div style={{ fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)", marginBottom: 8, lineHeight: 1.5 }}>
              运行时：工具 {preview.runtime.tools.length} · MCP {preview.runtime.mcpServers.join(", ") || "—"} · Skills{" "}
              {preview.runtime.skills.join(", ") || "—"}
            </div>
            <pre
              className="qb-json-preview"
              style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", marginBottom: 10 }}
            >
              {preview.mergedSystemPrompt || "（空）"}
            </pre>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => setShowSectionPrompt((v) => !v)}
            >
              {showSectionPrompt ? "收起" : "展开"}分块原文（agent / soul / workspace / DB）
            </button>
            {showSectionPrompt ? (
              <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                {(
                  [
                    ["agent.md", preview.sections.agent],
                    ["soul", preview.sections.soul],
                    ["workspace/prompt.md", preview.sections.workspacePrompt],
                    ["DB systemPrompt", preview.sections.dbPrompt],
                    ["user.md", preview.sections.user],
                    ["memory.md", preview.sections.memory],
                  ] as const
                ).map(([title, text]) =>
                  text.trim() ? (
                    <details key={title} style={{ fontSize: 12 }}>
                      <summary style={{ cursor: "pointer", color: "var(--qb-team-section-fg, #cbd5e1)" }}>{title}</summary>
                      <pre className="qb-json-preview" style={{ maxHeight: 160, marginTop: 6, whiteSpace: "pre-wrap" }}>
                        {text.slice(0, 8000)}
                      </pre>
                    </details>
                  ) : null
                )}
              </div>
            ) : null}
          </>
        ) : null}
      </section>

      <Collapsible title="高级：JSON 配置（随草稿保存）">
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <span style={label}>mcp_servers_json</span>
            <pre className="qb-json-preview">{JSON.stringify(draftMcpServerNames, null, 2)}</pre>
          </div>
          <div>
            <span style={label}>tools_json</span>
            <pre className="qb-json-preview">{JSON.stringify(draftTools, null, 2)}</pre>
          </div>
          <div>
            <span style={label}>skills_json</span>
            <pre className="qb-json-preview">{JSON.stringify(draftSkills, null, 2)}</pre>
          </div>
          <div>
            <span style={label}>subscriptions_json</span>
            <pre className="qb-json-preview">{JSON.stringify(draftSubscriptions, null, 2)}</pre>
          </div>
        </div>
      </Collapsible>
    </div>
  );
};
