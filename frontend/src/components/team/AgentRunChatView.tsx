import type { CSSProperties, FC } from "react";
import { useMemo, useState } from "react";
import type {
  AnalystTeamGraphAgentStep,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphMcpCall,
  AnalystTeamGraphToolCall,
} from "../../api/types";
import {
  analyzeToolEffectiveness,
  TOOL_BADGE_STYLE,
  type ToolResultBadge,
} from "../../lib/toolResultEffectiveness";
import { avatarColorFor, avatarLabelFor, formatRoleName } from "./conversationAvatar";

export type AgentRunPanelData = {
  role: string;
  inbound: AnalystTeamGraphInteraction[];
  outbound: AnalystTeamGraphInteraction[];
  steps: AnalystTeamGraphAgentStep[];
  tools: AnalystTeamGraphToolCall[];
  mcps: AnalystTeamGraphMcpCall[];
};

type ViewMode = "chat" | "compact";

/**
 * 顶层面板：统计 + 视图切换 + 内容渲染。
 * 默认对话流（Chat），人读起来更顺；切到 Compact 看到原有的紧凑 details 列表。
 */
export const AgentRunPanel: FC<{ data: AgentRunPanelData; defaultMode?: ViewMode }> = ({
  data,
  defaultMode = "chat",
}) => {
  const [mode, setMode] = useState<ViewMode>(defaultMode);
  const totals = {
    inbound: data.inbound.length,
    outbound: data.outbound.length,
    steps: data.steps.length,
    tools: data.tools.length,
    mcps: data.mcps.length,
  };
  const issueCounts = useMemo(() => {
    let empty = 0;
    let suspect = 0;
    let failed = 0;
    for (const t of data.tools) {
      const v = analyzeToolEffectiveness({
        status: t.status,
        responseJson: t.responseJson ?? null,
        latencyMs: t.latencyMs ?? null,
        errorMessage: t.errorMessage ?? null,
      });
      if (v.badge === "empty") empty++;
      else if (v.badge === "suspect") suspect++;
      else if (v.badge === "failed") failed++;
    }
    for (const m of data.mcps) {
      const v = analyzeToolEffectiveness({
        status: m.status,
        responseJson: m.responseJson ?? null,
        latencyMs: m.latencyMs ?? null,
        errorCode: m.errorCode ?? null,
      });
      if (v.badge === "empty") empty++;
      else if (v.badge === "suspect") suspect++;
      else if (v.badge === "failed") failed++;
    }
    return { empty, suspect, failed };
  }, [data.tools, data.mcps]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "8px 10px",
          borderBottom: "1px solid #2a2a30",
          background: "rgba(8,8,10,0.92)",
          backdropFilter: "blur(2px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 4,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e4e4e7" }}>
            Agent 运行 · {data.role}
          </div>
          <div
            style={{
              display: "inline-flex",
              border: "1px solid #3f3f46",
              borderRadius: 6,
              overflow: "hidden",
              fontSize: 11,
              flexShrink: 0,
            }}
          >
            {(["chat", "compact"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  padding: "3px 10px",
                  background: mode === m ? "#27272a" : "transparent",
                  color: mode === m ? "#f4f4f5" : "#a1a1aa",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {m === "chat" ? "对话流" : "紧凑"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#a1a1aa" }}>
          收到 {totals.inbound} · 发出 {totals.outbound} · 步 {totals.steps} · 工具 {totals.tools}
          {" · "}MCP {totals.mcps}
          {(issueCounts.empty || issueCounts.suspect || issueCounts.failed) > 0 ? (
            <span style={{ marginLeft: 8 }}>
              {issueCounts.empty > 0 ? (
                <span style={{ color: TOOL_BADGE_STYLE.empty.color, marginRight: 8 }}>
                  ⚠ 空数据 {issueCounts.empty}
                </span>
              ) : null}
              {issueCounts.suspect > 0 ? (
                <span style={{ color: TOOL_BADGE_STYLE.suspect.color, marginRight: 8 }}>
                  ? 可疑 {issueCounts.suspect}
                </span>
              ) : null}
              {issueCounts.failed > 0 ? (
                <span style={{ color: TOOL_BADGE_STYLE.failed.color }}>
                  ✗ 失败 {issueCounts.failed}
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
      <div
        style={{
          flex: "1 1 0",
          minHeight: 0,
          overflowY: "auto",
          overflowX: "hidden",
          padding: "8px 10px 16px",
        }}
      >
        {mode === "chat" ? <AgentRunChatView {...data} /> : <AgentRunCompactView {...data} />}
      </div>
    </div>
  );
};

/**
 * 把 inbound / outbound A2A 消息、tool / MCP 调用、agent_step 思考统一按 createdAt 排序后，
 * 像聊天 IM 一样一行一条气泡渲染，便于人快速从上到下读完一个 Agent 的运行轨迹。
 */
export type AgentRunChatViewProps = {
  role: string;
  inbound: AnalystTeamGraphInteraction[];
  outbound: AnalystTeamGraphInteraction[];
  steps: AnalystTeamGraphAgentStep[];
  tools: AnalystTeamGraphToolCall[];
  mcps: AnalystTeamGraphMcpCall[];
  /** 是否仅显示有效（ok）+ 警告（empty/suspect/failed），过滤掉空 thought 之类。 */
  compact?: boolean;
};

type ChatItem =
  | {
      kind: "inbound";
      ts: string;
      raw: AnalystTeamGraphInteraction;
    }
  | {
      kind: "outbound";
      ts: string;
      raw: AnalystTeamGraphInteraction;
    }
  | {
      kind: "tool";
      ts: string;
      raw: AnalystTeamGraphToolCall;
    }
  | {
      kind: "mcp";
      ts: string;
      raw: AnalystTeamGraphMcpCall;
    }
  | {
      kind: "step";
      ts: string;
      raw: AnalystTeamGraphAgentStep;
    };

function formatTs(ts: string): string {
  const m = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  if (m && m[1]) return m[1];
  return ts.slice(11, 19);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

export const AgentRunChatView: FC<AgentRunChatViewProps> = ({
  role,
  inbound,
  outbound,
  steps,
  tools,
  mcps,
  compact = false,
}) => {
  const items = useMemo<ChatItem[]>(() => {
    const list: ChatItem[] = [];
    inbound.forEach((r) => list.push({ kind: "inbound", ts: r.createdAt, raw: r }));
    outbound.forEach((r) => list.push({ kind: "outbound", ts: r.createdAt, raw: r }));
    tools.forEach((t) => list.push({ kind: "tool", ts: t.createdAt, raw: t }));
    mcps.forEach((m) => list.push({ kind: "mcp", ts: m.createdAt, raw: m }));
    steps.forEach((s) => {
      if (compact && !s.thought) return;
      list.push({ kind: "step", ts: s.createdAt, raw: s });
    });
    list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return list;
  }, [inbound, outbound, steps, tools, mcps, compact]);

  if (items.length === 0) {
    return (
      <div style={{ fontSize: 12, color: "#71717a", padding: "12px 0" }}>
        该 Agent 暂无运行轨迹。
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {items.map((item) => (
        <ChatRow key={`${item.kind}:${item.raw.id}`} item={item} role={role} />
      ))}
    </div>
  );
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "8px 4px 16px",
};

const ChatRow: FC<{ item: ChatItem; role: string }> = ({ item, role }) => {
  switch (item.kind) {
    case "inbound":
      return <MsgBubble item={item} selfRole={role} side="left" />;
    case "outbound":
      return <MsgBubble item={item} selfRole={role} side="right" />;
    case "tool":
      return <ToolBubble tool={item.raw} />;
    case "mcp":
      return <McpBubble mcp={item.raw} />;
    case "step":
      return <StepBubble step={item.raw} role={role} />;
  }
};

/**
 * 头像气泡：基于 fromRole 取色 + 缩写，selfRole 决定左右；
 * 与 LiveConversationView 视觉保持一致。
 */
const Avatar: FC<{ role: string; size?: number }> = ({ role, size = 28 }) => {
  const { bg, fg } = avatarColorFor(role);
  return (
    <div
      title={formatRoleName(role)}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: bg,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size <= 24 ? 9 : 10,
        fontWeight: 700,
        flexShrink: 0,
        boxShadow: "0 0 0 1px rgba(255,255,255,0.06)",
        userSelect: "none",
      }}
    >
      {avatarLabelFor(role)}
    </div>
  );
};

const tsLabel: CSSProperties = {
  fontSize: 10,
  color: "#71717a",
  marginBottom: 2,
  fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
};

const MsgBubble: FC<{
  item: Extract<ChatItem, { kind: "inbound" | "outbound" }>;
  selfRole: string;
  side: "left" | "right";
}> = ({ item, selfRole, side }) => {
  const r = item.raw;
  const isSelf = side === "right";
  const avatarRole = isSelf ? selfRole : r.fromRole;
  const accent = avatarColorFor(avatarRole).bg;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: isSelf ? "row-reverse" : "row",
        gap: 8,
        alignItems: "flex-start",
      }}
    >
      <Avatar role={avatarRole} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isSelf ? "flex-end" : "flex-start",
          maxWidth: "82%",
          minWidth: 0,
        }}
      >
        <div style={tsLabel}>
          {formatTs(item.ts)} · {formatRoleName(r.fromRole)} → {formatRoleName(r.toRole)}
          {r.kind ? ` · ${r.kind}` : ""}
        </div>
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            background: isSelf ? "rgba(245,158,11,0.08)" : "rgba(96,165,250,0.06)",
            border: `1px solid ${isSelf ? "rgba(245,158,11,0.32)" : "rgba(96,165,250,0.32)"}`,
            color: "#e4e4e7",
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          }}
        >
          {!isSelf ? (
            <span style={{ color: accent, fontWeight: 600, fontSize: 11, marginRight: 6 }}>
              {formatRoleName(r.fromRole)}
            </span>
          ) : null}
          {truncate(r.contentText || "(无文本内容)", 4000)}
        </div>
      </div>
    </div>
  );
};

const Badge: FC<{ badge: ToolResultBadge; reason: string; latencyMs?: number | null }> = ({
  badge,
  reason,
  latencyMs,
}) => {
  const s = TOOL_BADGE_STYLE[badge];
  return (
    <span
      title={reason}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.color}`,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.2,
      }}
    >
      {s.icon} {s.label}
      {latencyMs != null ? <span style={{ opacity: 0.7 }}>· {latencyMs}ms</span> : null}
    </span>
  );
};

const ToolBubble: FC<{ tool: AnalystTeamGraphToolCall }> = ({ tool }) => {
  const verdict = analyzeToolEffectiveness({
    status: tool.status,
    responseJson: tool.responseJson ?? null,
    latencyMs: tool.latencyMs ?? null,
    errorMessage: tool.errorMessage ?? null,
  });
  return (
    <div style={centerCardStyle}>
      <div style={{ ...tsLabel, marginBottom: 4 }}>
        {formatTs(tool.createdAt)} · {tool.toolKind}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: "#d4d4d8", fontSize: 12 }}>{tool.toolName}</span>
        <Badge badge={verdict.badge} reason={verdict.reason} latencyMs={tool.latencyMs} />
      </div>
      {verdict.badge !== "ok" ? (
        <div style={{ fontSize: 11, color: TOOL_BADGE_STYLE[verdict.badge].color, marginBottom: 6 }}>
          {verdict.reason}
        </div>
      ) : null}
      {tool.requestJson != null ? (
        <details>
          <summary style={summaryStyle}>请求</summary>
          <pre style={preStyle}>{truncate(JSON.stringify(tool.requestJson, null, 2), 2000)}</pre>
        </details>
      ) : null}
      {tool.responseJson != null ? (
        <details>
          <summary style={summaryStyle}>响应</summary>
          <pre style={{ ...preStyle, color: "#86efac" }}>
            {truncate(JSON.stringify(tool.responseJson, null, 2), 3000)}
          </pre>
        </details>
      ) : null}
      {tool.errorMessage ? (
        <pre style={{ ...preStyle, color: "#f87171" }}>{tool.errorMessage}</pre>
      ) : null}
    </div>
  );
};

const McpBubble: FC<{ mcp: AnalystTeamGraphMcpCall }> = ({ mcp }) => {
  const verdict = analyzeToolEffectiveness({
    status: mcp.status,
    responseJson: mcp.responseJson ?? null,
    latencyMs: mcp.latencyMs ?? null,
    errorCode: mcp.errorCode ?? null,
  });
  return (
    <div style={centerCardStyle}>
      <div style={{ ...tsLabel, marginBottom: 4 }}>
        {formatTs(mcp.createdAt)} · MCP · {mcp.serverName}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ fontWeight: 600, color: "#d4d4d8", fontSize: 12 }}>{mcp.toolName}</span>
        <Badge badge={verdict.badge} reason={verdict.reason} latencyMs={mcp.latencyMs} />
      </div>
      {verdict.badge !== "ok" ? (
        <div style={{ fontSize: 11, color: TOOL_BADGE_STYLE[verdict.badge].color, marginBottom: 6 }}>
          {verdict.reason}
        </div>
      ) : null}
      {mcp.requestJson != null ? (
        <details>
          <summary style={summaryStyle}>请求</summary>
          <pre style={preStyle}>{truncate(JSON.stringify(mcp.requestJson, null, 2), 2000)}</pre>
        </details>
      ) : null}
      {mcp.responseJson != null ? (
        <details>
          <summary style={summaryStyle}>响应</summary>
          <pre style={{ ...preStyle, color: "#86efac" }}>
            {truncate(JSON.stringify(mcp.responseJson, null, 2), 3000)}
          </pre>
        </details>
      ) : null}
    </div>
  );
};

const StepBubble: FC<{ step: AnalystTeamGraphAgentStep; role: string }> = ({ step, role }) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        margin: "0 auto",
        maxWidth: "92%",
      }}
    >
      <div style={tsLabel}>
        {formatTs(step.createdAt)} · {role} · {step.phase} · {step.actionType} · step{" "}
        {step.stepIndex}
      </div>
      <div
        style={{
          width: "100%",
          padding: "8px 12px",
          borderRadius: 8,
          background: "rgba(161,161,170,0.06)",
          border: "1px dashed rgba(161,161,170,0.35)",
          color: "#a1a1aa",
          fontSize: 11.5,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
        }}
      >
        {step.thought ? truncate(step.thought, 3000) : <em style={{ opacity: 0.6 }}>（无思考文本）</em>}
        {step.observationJson != null && typeof step.observationJson === "object" ? (
          <details style={{ marginTop: 6 }}>
            <summary style={summaryStyle}>观察</summary>
            <pre style={preStyle}>
              {truncate(JSON.stringify(step.observationJson, null, 2), 2000)}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
};

const centerCardStyle: CSSProperties = {
  alignSelf: "stretch",
  margin: "0 auto",
  maxWidth: "94%",
  padding: "8px 12px",
  borderRadius: 8,
  background: "rgba(39,39,42,0.45)",
  border: "1px solid #3f3f46",
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  fontSize: 11,
  color: "#a1a1aa",
};

const preStyle: CSSProperties = {
  margin: "4px 0 0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  color: "#d4d4d8",
  fontSize: 10.5,
  lineHeight: 1.45,
  fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
};

/**
 * 旧版"紧凑列表"视图——在 chat 视图下不顺手时切回来用。
 * 与 chat 视图共用 effectiveness 徽章逻辑，确保两边对"假成功"判定一致。
 */
const AgentRunCompactView: FC<AgentRunPanelData> = ({
  inbound,
  outbound,
  steps,
  tools,
  mcps,
}) => {
  const hasCalls = tools.length > 0 || mcps.length > 0;
  return (
    <div
      style={{
        fontSize: 11,
        color: "#d4d4d8",
        fontFamily: "ui-monospace, Menlo, Monaco, Consolas, monospace",
      }}
    >
      {hasCalls ? (
        <div style={{ marginBottom: 10, maxHeight: 220, overflow: "auto" }}>
          <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 4 }}>工具 / MCP</div>
          {tools.map((t) => {
            const v = analyzeToolEffectiveness({
              status: t.status,
              responseJson: t.responseJson ?? null,
              latencyMs: t.latencyMs ?? null,
              errorMessage: t.errorMessage ?? null,
            });
            const c = TOOL_BADGE_STYLE[v.badge];
            return (
              <details key={t.id} style={{ marginBottom: 6 }}>
                <summary style={{ cursor: "pointer", color: c.color }}>
                  [{formatTs(t.createdAt)}] {t.toolKind} · {t.toolName} · {c.icon} {c.label}
                  {t.latencyMs != null ? ` · ${t.latencyMs}ms` : ""}
                </summary>
                {v.badge !== "ok" ? (
                  <div style={{ fontSize: 11, color: c.color, margin: "4px 0" }}>{v.reason}</div>
                ) : null}
                {t.errorMessage ? (
                  <pre style={{ ...preStyle, color: "#f87171" }}>{t.errorMessage}</pre>
                ) : null}
                {t.requestJson != null ? (
                  <pre style={{ ...preStyle, color: "#a1a1aa" }}>
                    请求: {truncate(JSON.stringify(t.requestJson, null, 2), 2000)}
                  </pre>
                ) : null}
                {t.responseJson != null ? (
                  <pre style={{ ...preStyle, color: "#86efac" }}>
                    响应: {truncate(JSON.stringify(t.responseJson, null, 2), 3000)}
                  </pre>
                ) : null}
              </details>
            );
          })}
          {mcps.map((m) => {
            const v = analyzeToolEffectiveness({
              status: m.status,
              responseJson: m.responseJson ?? null,
              latencyMs: m.latencyMs ?? null,
              errorCode: m.errorCode ?? null,
            });
            const c = TOOL_BADGE_STYLE[v.badge];
            return (
              <details key={m.id} style={{ marginBottom: 6 }}>
                <summary style={{ cursor: "pointer", color: c.color }}>
                  [MCP] {m.serverName}/{m.toolName} · {c.icon} {c.label}
                  {m.latencyMs != null ? ` · ${m.latencyMs}ms` : ""}
                </summary>
                {v.badge !== "ok" ? (
                  <div style={{ fontSize: 11, color: c.color, margin: "4px 0" }}>{v.reason}</div>
                ) : null}
                {m.responseJson != null ? (
                  <pre style={{ ...preStyle, color: "#86efac" }}>
                    响应: {truncate(JSON.stringify(m.responseJson, null, 2), 3000)}
                  </pre>
                ) : null}
              </details>
            );
          })}
        </div>
      ) : null}
      {inbound.length > 0 ? (
        <div style={{ maxHeight: 140, overflow: "auto", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 4 }}>收到的消息</div>
          {inbound.map((row) => (
            <div
              key={row.id}
              style={{ marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #27272a" }}
            >
              <span style={{ color: "#93c5fd" }}>
                {row.fromRole} → {row.toRole}
              </span>
              <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
                {truncate(row.contentText, 2000)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
      {outbound.length > 0 ? (
        <div style={{ maxHeight: 140, overflow: "auto", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 4 }}>发出的消息</div>
          {outbound.map((row) => (
            <div
              key={row.id}
              style={{ marginBottom: 6, paddingBottom: 4, borderBottom: "1px solid #27272a" }}
            >
              <span style={{ color: "#fcd34d" }}>
                {row.fromRole} → {row.toRole}
              </span>
              <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
                {truncate(row.contentText, 2000)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <div style={{ maxHeight: 160, overflow: "auto", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 4 }}>执行轨迹（ReAct）</div>
          {steps.map((s) => (
            <details key={s.id} style={{ marginBottom: 6 }}>
              <summary style={{ cursor: "pointer", color: "#e4e4e7" }}>
                [{formatTs(s.createdAt)}] {s.phase} · {s.actionType} · step {s.stepIndex}
              </summary>
              {s.thought ? (
                <pre style={{ ...preStyle, color: "#a1a1aa" }}>{truncate(s.thought, 2500)}</pre>
              ) : null}
              {s.observationJson != null && typeof s.observationJson === "object" ? (
                <pre style={{ ...preStyle, color: "#86efac" }}>
                  {truncate(JSON.stringify(s.observationJson, null, 2), 2000)}
                </pre>
              ) : null}
            </details>
          ))}
        </div>
      ) : null}
      {!hasCalls && inbound.length === 0 && outbound.length === 0 && steps.length === 0 ? (
        <div style={{ fontSize: 11, color: "#71717a" }}>该 Agent 暂无运行轨迹。</div>
      ) : null}
    </div>
  );
};
