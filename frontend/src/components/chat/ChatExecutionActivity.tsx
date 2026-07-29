import { Check, LoaderCircle, Network, Wrench, X } from "lucide-react";
import { type FC, useMemo, useState } from "react";
import type { StepStreamEvent } from "../../api/types";

type ToolActivity = {
  id: string;
  name: string;
  role: string;
  status: "running" | "success" | "failed" | "timeout" | "blocked";
  detail: Record<string, unknown>;
};

export type ChatExecutionActivityModel = {
  tools: ToolActivity[];
  a2a: { role: string; status: "running" | "completed" } | null;
};

function toolStatus(value: unknown): ToolActivity["status"] {
  const status = String(value ?? "success");
  if (status === "timeout") return "timeout";
  if (status === "failed" || status === "error") return "failed";
  if (status === "blocked_by_sandbox" || status === "governance_blocked") return "blocked";
  return "success";
}

export function buildChatExecutionActivity(
  events: StepStreamEvent[],
  running: boolean
): ChatExecutionActivityModel {
  const byId = new Map<string, ToolActivity>();
  for (const event of events) {
    if (event.type !== "tool_call_start" && event.type !== "tool_call_end") continue;
    const id = String(event.payload.toolCallId ?? `${event.runId}:${event.stepIndex}`);
    const existing = byId.get(id);
    const name = String(
      event.payload.targetName ?? event.payload.toolName ?? existing?.name ?? "unknown"
    );
    byId.set(id, {
      id,
      name,
      role: event.role,
      status: event.type === "tool_call_start" ? "running" : toolStatus(event.payload.status),
      detail: { ...(existing?.detail ?? {}), ...event.payload },
    });
  }
  const hasA2a = events.some((event) => event.source === "a2a");
  const latest = events.at(-1);
  return {
    tools: [...byId.values()],
    a2a: hasA2a
      ? {
          role: latest?.role ?? "orchestrator",
          status: running ? "running" : "completed",
        }
      : null,
  };
}

export const ChatExecutionActivity: FC<{
  events: StepStreamEvent[];
  running: boolean;
}> = ({ events, running }) => {
  const [open, setOpen] = useState(true);
  const { tools, a2a } = useMemo(
    () => buildChatExecutionActivity(events, running),
    [events, running]
  );

  if (!a2a && tools.length === 0) return null;
  const activeCount = tools.filter((tool) => tool.status === "running").length;

  return (
    <section className="qb-chat-execution" aria-label="Agent 调用过程" aria-live="polite">
      <button
        type="button"
        className="qb-chat-execution__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>调用过程</span>
        <span className="qb-chat-execution__summary">
          {activeCount > 0 ? `${activeCount} 项运行中` : `${tools.length} 次工具调用`}
        </span>
      </button>
      {open ? (
        <div className="qb-chat-execution__list">
          {a2a ? (
            <div className="qb-chat-call-card qb-chat-call-card--a2a">
              <Network size={15} aria-hidden />
              <div>
                <strong>A2A Agent 调用</strong>
                <span>
                  {a2a.role} · {a2a.status === "running" ? "执行中" : "已结束"}
                </span>
              </div>
              {a2a.status === "running" ? (
                <LoaderCircle className="qb-chat-call-card__spin" size={14} aria-hidden />
              ) : (
                <Check size={14} aria-hidden />
              )}
            </div>
          ) : null}
          {tools.map((tool) => {
            const failed = tool.status === "failed" || tool.status === "blocked";
            return (
              <details
                className={`qb-chat-call-card qb-chat-call-card--${tool.status}`}
                key={tool.id}
              >
                <summary>
                  <Wrench size={14} aria-hidden />
                  <span className="qb-chat-call-card__body">
                    <strong>{tool.name}</strong>
                    <span>
                      {tool.role} ·{" "}
                      {tool.status === "running"
                        ? "调用中"
                        : tool.status === "success"
                          ? "已完成"
                          : tool.status === "timeout"
                            ? "超时"
                            : tool.status === "blocked"
                              ? "已阻止"
                              : "失败"}
                    </span>
                  </span>
                  {tool.status === "running" ? (
                    <LoaderCircle className="qb-chat-call-card__spin" size={14} aria-hidden />
                  ) : failed ? (
                    <X size={14} aria-hidden />
                  ) : (
                    <Check size={14} aria-hidden />
                  )}
                </summary>
                <pre>{JSON.stringify(tool.detail, null, 2)}</pre>
              </details>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
