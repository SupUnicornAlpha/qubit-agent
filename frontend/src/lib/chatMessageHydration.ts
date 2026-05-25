import {
  getWorkflowArtifacts,
  getWorkflowDetail,
  patchSessionMessage,
} from "../api/backend";
import type { ChatMessage, WorkflowDetail } from "../api/types";

const CHAT_STREAM_LS_PREFIX = "qubit:chatStream:";

type WorkflowStepRow = {
  stepIndex?: number;
  phase?: string;
  thought?: string | null;
  observationJson?: unknown;
};

export function persistChatStreamBinding(
  messageId: string,
  workflowId: string,
  runId: string
): void {
  try {
    sessionStorage.setItem(
      `${CHAT_STREAM_LS_PREFIX}${messageId}`,
      JSON.stringify({ workflowId, runId })
    );
  } catch {
    /* ignore */
  }
}

export function clearChatStreamBinding(messageId: string): void {
  try {
    sessionStorage.removeItem(`${CHAT_STREAM_LS_PREFIX}${messageId}`);
  } catch {
    /* ignore */
  }
}

function readChatStreamBinding(
  messageId: string
): { workflowId: string; runId: string } | null {
  try {
    const raw = sessionStorage.getItem(`${CHAT_STREAM_LS_PREFIX}${messageId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { workflowId?: string; runId?: string };
    if (!parsed.workflowId || !parsed.runId) return null;
    return { workflowId: parsed.workflowId, runId: parsed.runId };
  } catch {
    return null;
  }
}

export function messageNeedsHydration(msg: ChatMessage): boolean {
  if (msg.role !== "assistant") return false;
  if (!msg.workflowRunIds?.length) return false;
  const hasContent = Boolean(msg.content?.trim());
  if (msg.status === "running" || msg.status === "queued") return true;
  if (msg.status === "awaiting_approval") return false;
  if (!hasContent) return true;
  return false;
}

function parseObservationJson(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function messageStatusFromFinalPayload(payload: Record<string, unknown>): ChatMessage["status"] {
  const s = String(payload.status ?? "completed");
  if (s === "awaiting_approval") return "awaiting_approval";
  if (s === "terminated") return "failed";
  return "completed";
}

/** 剥掉 LLM 流式输出里的 `<TOOL_CALL>` sentinel / fenced JSON 工具块（含未闭合尾部），
 * 与后端 `stripToolCallSentinels` 行为保持一致，避免泄漏到聊天 UI。 */
const TOOL_CALL_SENTINEL_REGEX = /\n*<TOOL_CALL>[\s\S]*?<\/TOOL_CALL>\n*/gi;
const TOOL_CALL_OPEN_TAIL_REGEX = /\n*<TOOL_CALL>[\s\S]*$/i;
const JSON_TOOL_FENCE_REGEX = /\n*```(?:json)?\s*\{[\s\S]*?"tool"\s*:[\s\S]*?\}\s*```\n*/gi;

export function stripToolCallSentinels(text: string | null | undefined): string {
  if (!text) return "";
  let out = String(text);
  out = out.replace(TOOL_CALL_SENTINEL_REGEX, "\n");
  out = out.replace(TOOL_CALL_OPEN_TAIL_REGEX, "");
  out = out.replace(JSON_TOOL_FENCE_REGEX, "\n");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

export function buildFinalAssistantText(
  buffer: string,
  payload: Record<string, unknown>,
  stepIndex: number
): string {
  const frStatus = String(payload.status ?? "completed");
  const role = String(payload.role ?? "agent");
  const obs = payload.observation as Record<string, unknown> | undefined;
  const cleanedBuffer = stripToolCallSentinels(buffer);
  let obsText = "";
  if (obs && Object.keys(obs).length > 0) {
    obsText = `\n\n📎 观测结果:\n\`\`\`json\n${JSON.stringify(obs, null, 2)}\n\`\`\``;
  }
  if (frStatus === "awaiting_approval") {
    const title = String(payload.title ?? "待人工确认");
    const summary = stripToolCallSentinels(String(payload.summary ?? cleanedBuffer));
    return `⏸️ **待确认**：${title}\n\n${summary || "（无摘要）"}`;
  }
  if (frStatus === "terminated") {
    return cleanedBuffer || `❌ ${role} 已终止（第 ${stepIndex} 轮）${obsText}`;
  }
  return cleanedBuffer || `✅ ${role} 已完成（第 ${stepIndex} 轮）${obsText}`;
}

export function buildContentFromWorkflowDetail(detail: WorkflowDetail): string {
  const wfStatus = String(detail.workflow.status ?? "");
  const steps = (detail.steps as WorkflowStepRow[]).slice().sort((a, b) => {
    const ai = a.stepIndex ?? 0;
    const bi = b.stepIndex ?? 0;
    if (ai !== bi) return ai - bi;
    const phaseOrder: Record<string, number> = {
      perceive: 0,
      reason: 1,
      act: 2,
      observe: 3,
      external: 4,
    };
    return (phaseOrder[a.phase ?? ""] ?? 9) - (phaseOrder[b.phase ?? ""] ?? 9);
  });

  const thoughtParts: string[] = [];
  for (const step of steps) {
    const thought = step.thought?.trim();
    if (!thought) continue;
    if (step.phase === "reason") {
      if (thought === "Reasoning with LLM provider") continue;
      thoughtParts.push(thought);
    }
  }
  const buffer = stripToolCallSentinels(thoughtParts.join("\n\n"));

  const lastObserve = [...steps].reverse().find((s) => s.phase === "observe");
  const obs = parseObservationJson(lastObserve?.observationJson);
  let obsText = "";
  if (obs && Object.keys(obs).length > 0) {
    obsText = `\n\n📎 观测结果:\n\`\`\`json\n${JSON.stringify(obs, null, 2)}\n\`\`\``;
  }

  if (buffer) return `${buffer}${obsText}`;

  if (wfStatus === "failed" || wfStatus === "cancelled") {
    return `❌ 工作流执行失败${obsText}`;
  }
  if (wfStatus === "awaiting_approval") {
    return `⏸️ 等待人工确认${obsText}`;
  }
  if (wfStatus === "completed") {
    return `✅ orchestrator 已完成${obsText}`;
  }
  return "";
}

async function hydrateAssistantMessage(
  msg: ChatMessage,
  workflowId: string
): Promise<ChatMessage | null> {
  const detail = await getWorkflowDetail(workflowId);
  const wfStatus = String(detail.workflow.status ?? "");
  const terminal =
    wfStatus === "completed" ||
    wfStatus === "failed" ||
    wfStatus === "cancelled" ||
    wfStatus === "awaiting_approval";

  if (!terminal) return null;

  if (msg.content?.trim()) {
    const nextStatus =
      wfStatus === "completed"
        ? "completed"
        : wfStatus === "awaiting_approval"
          ? "awaiting_approval"
          : "failed";
    if (msg.status === nextStatus) return null;
    const patched = await patchSessionMessage({
      messageId: msg.id,
      status: nextStatus,
    });
    clearChatStreamBinding(msg.id);
    return { ...msg, ...patched, workflowRunIds: msg.workflowRunIds };
  }

  let content = msg.content?.trim() ?? "";
  if (!content) {
    try {
      const artifacts = await getWorkflowArtifacts(workflowId);
      if (artifacts.report?.trim()) content = artifacts.report.trim();
    } catch {
      /* optional */
    }
  }
  if (!content) {
    content = buildContentFromWorkflowDetail(detail);
  }
  if (!content) {
    content =
      wfStatus === "failed" || wfStatus === "cancelled"
        ? "❌ 工作流执行失败（无输出记录）"
        : "✅ 已完成（无文本输出）";
  }

  const nextStatus =
    wfStatus === "completed"
      ? "completed"
      : wfStatus === "awaiting_approval"
        ? "awaiting_approval"
        : "failed";
  if (content === msg.content && msg.status === nextStatus) return null;

  const patched = await patchSessionMessage({
    messageId: msg.id,
    content,
    status: nextStatus,
    errorMessage: nextStatus === "failed" ? msg.errorMessage ?? "workflow ended without assistant content" : null,
  });

  clearChatStreamBinding(msg.id);
  return {
    ...msg,
    ...patched,
    workflowRunIds: msg.workflowRunIds,
  };
}

export async function hydrateStaleChatMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const out = [...messages];
  await Promise.all(
    out.map(async (msg, index) => {
      if (!messageNeedsHydration(msg)) return;
      const workflowId = msg.workflowRunIds?.[0];
      if (!workflowId) return;
      try {
        const updated = await hydrateAssistantMessage(msg, workflowId);
        if (updated) out[index] = updated;
      } catch {
        /* single message failure should not block the rest */
      }
    })
  );
  return out;
}

/** Re-attach SSE for in-flight assistant messages after panel remount (within stream buffer TTL). */
export function reconnectActiveChatStreams(
  messages: ChatMessage[],
  bindStream: (workflowId: string, runId: string, assistantMessageId: string) => void
): void {
  const bound = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (msg.status !== "running" && msg.status !== "queued") continue;
    if (msg.content?.trim()) continue;
    const binding = readChatStreamBinding(msg.id);
    if (!binding) continue;
    if (bound.has(msg.id)) continue;
    bound.add(msg.id);
    bindStream(binding.workflowId, binding.runId, msg.id);
  }
}
