import { Check, ChevronDown, CircleAlert, LoaderCircle, Network, Wrench, X } from "lucide-react";
import { type FC, useEffect, useMemo, useRef, useState } from "react";
import type { StepStreamEvent } from "../../api/types";
import { formatLargeJsonPreview } from "../../lib/formatLargeJsonPreview";

type ToolActivity = {
  id: string;
  name: string;
  role: string;
  status: "running" | "success" | "failed" | "timeout" | "blocked";
  detail: Record<string, unknown>;
};

type ToolActivityGroup = ToolActivity & { count: number };

export type ChatExecutionActivityModel = {
  tools: ToolActivity[];
  a2a: { role: string; status: "running" | "completed" } | null;
};

/** Collapsed rows shown without scrolling (~matches CSS max-height). */
export const CHAT_EXECUTION_VISIBLE_ROWS = 10;

function statusCopy(status: ToolActivity["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "success":
      return "完成";
    case "timeout":
      return "超时";
    case "blocked":
      return "已阻止";
    default:
      return "失败";
  }
}

function roleCopy(role: string): string {
  const normalized = role.trim().toLowerCase();
  const labels: Record<string, string> = {
    orchestrator: "编排器",
    market_data: "行情",
    news_event: "新闻",
    research: "研究",
    strategy_coder: "策略",
    backtest: "回测",
    risk: "风控",
  };
  return labels[normalized] ?? role.replace(/[_-]+/g, " ");
}

/** Collapse adjacent retries/polling calls without discarding chronological context. */
export function groupChatExecutionActivities(tools: ToolActivity[]): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = [];
  for (const tool of tools) {
    const last = groups.at(-1);
    if (last && last.name === tool.name && last.role === tool.role && last.status === tool.status) {
      last.count += 1;
      last.detail = tool.detail;
      last.id = tool.id;
    } else {
      groups.push({ ...tool, count: 1 });
    }
  }
  return groups;
}

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
  const listRef = useRef<HTMLDivElement | null>(null);
  const { tools, a2a } = useMemo(
    () => buildChatExecutionActivity(events, running),
    [events, running]
  );

  // Keep the newest call in view while the turn is active.
  useEffect(() => {
    if (!open || !running) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, running, tools.length, a2a?.status]);

  if (!a2a && tools.length === 0) return null;
  const groups = groupChatExecutionActivities(tools);
  const activeCount = tools.filter((tool) => tool.status === "running").length;
  const failedCount = tools.filter(
    (tool) => tool.status === "failed" || tool.status === "blocked" || tool.status === "timeout"
  ).length;
  return (
    <section className="qb-chat-execution" aria-label="Agent 调用过程" aria-live="polite">
      <button
        type="button"
        className="qb-chat-execution__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronDown
          className={`qb-chat-execution__chevron${open ? "" : " qb-chat-execution__chevron--closed"}`}
          size={15}
          aria-hidden
        />
        <span className="qb-chat-execution__title">执行轨迹</span>
        <span className="qb-chat-execution__count">{tools.length} 次调用</span>
        <span className="qb-chat-execution__summary" aria-label="调用状态">
          {activeCount > 0 ? (
            <span className="qb-chat-execution__metric qb-chat-execution__metric--running">
              <LoaderCircle className="qb-chat-call-card__spin" size={12} aria-hidden />
              {activeCount} 运行中
            </span>
          ) : null}
          {failedCount > 0 ? (
            <span className="qb-chat-execution__metric qb-chat-execution__metric--failed">
              <CircleAlert size={12} aria-hidden />
              {failedCount} 异常
            </span>
          ) : (
            <span className="qb-chat-execution__metric qb-chat-execution__metric--success">
              <Check size={12} aria-hidden />
              已完成
            </span>
          )}
        </span>
      </button>
      {open ? (
        <div ref={listRef} className="qb-chat-execution__list">
          {a2a ? (
            <div className="qb-chat-call-card qb-chat-call-card--a2a">
              <Network size={15} aria-hidden />
              <div>
                <strong>专家协作</strong>
                <span>
                  {roleCopy(a2a.role)} · {a2a.status === "running" ? "执行中" : "已结束"}
                </span>
              </div>
              {a2a.status === "running" ? (
                <LoaderCircle className="qb-chat-call-card__spin" size={14} aria-hidden />
              ) : (
                <Check size={14} aria-hidden />
              )}
            </div>
          ) : null}
          {groups.map((tool) => {
            const failed = tool.status === "failed" || tool.status === "blocked";
            const detailPreview = formatLargeJsonPreview(tool.detail, {
              maxChars: 4_000,
              maxLines: 80,
              maxArrayItems: 16,
            });
            return (
              <details
                className={`qb-chat-call-card qb-chat-call-card--${tool.status}`}
                key={tool.id}
              >
                <summary>
                  <span
                    className={`qb-chat-call-card__status qb-chat-call-card__status--${tool.status}`}
                  >
                    {tool.status === "running" ? (
                      <LoaderCircle className="qb-chat-call-card__spin" size={14} aria-hidden />
                    ) : failed ? (
                      <X size={14} aria-hidden />
                    ) : (
                      <Check size={14} aria-hidden />
                    )}
                  </span>
                  <Wrench className="qb-chat-call-card__tool-icon" size={14} aria-hidden />
                  <span className="qb-chat-call-card__name" title={tool.name}>
                    {tool.name}
                  </span>
                  <span className="qb-chat-call-card__role" title={tool.role}>
                    {roleCopy(tool.role)}
                  </span>
                  <span className="qb-chat-call-card__result">
                    {statusCopy(tool.status)}
                    {tool.count > 1 ? ` ×${tool.count}` : ""}
                    {detailPreview.truncated ? " · 已截断" : ""}
                  </span>
                </summary>
                <pre>{detailPreview.text}</pre>
              </details>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};
