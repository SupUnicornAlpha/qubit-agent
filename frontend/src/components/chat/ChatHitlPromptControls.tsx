/**
 * 对话窗口内的 HITL 审批控件（替换原"批准继续 / 拒绝"两按钮）。
 *
 * 历史：对话窗口（MainContent.tsx）的 awaiting_approval 气泡只画了两个按钮，并且直
 * 接调 `approveWorkflowHitl` / `rejectWorkflowHitl` 老端点，永远不带 `response`。
 * 后端虽然 v2 已支持 single_choice / multi_choice / free_form（见 hitl-service.ts +
 * 0044/0045 迁移），UI 上对话路径却**永远只能画 approve_only**。
 *
 * 本组件做三件事：
 *   1. 通过 `listPendingWorkflowHitl` 拉到 requestId 对应的 `inputKind` + `inputSchemaJson`
 *      —— 父组件只需要 messageId / workflowRunId / requestId 三个 key
 *   2. 按 inputKind 复用 `<HitlInputArea />` 渲染选择题 / 自由输入
 *   3. 提交时统一走 `resolveWorkflowHitl`（带 response），与团队 banner 同协议
 *
 * 不影响"防重订阅"等父组件状态：保留 `inflight` 入参，让 MainContent 仍能用
 * `hitlInflightRequestIds` 去重连点。
 */
import { useCallback, useEffect, useState } from "react";
import {
  type HitlInputKind,
  type HitlInputSchema,
  type HitlPendingRequest,
  listPendingWorkflowHitl,
} from "../../api/backend";
import {
  HitlInputArea,
  buildHitlResponsePayload,
  hitlKindLabel,
  hitlSubmitLabel,
} from "../team/HitlInputArea";

export interface ChatHitlPromptControlsProps {
  workflowRunId: string;
  requestId: string;
  /** 父组件已有的"该 requestId 当前正在 resolve" 状态，避免重复点击 */
  inflight: boolean;
  /**
   * 父组件统一管理 SSE 重绑 / 消息状态切换，所以这里只把 decision + response
   * 抛给它，由它去调 `resolveWorkflowHitl` —— 与原两按钮路径保持一致语义。
   */
  onDecision: (decision: "approved" | "rejected", response: Record<string, unknown> | null) => void;
}

interface InnerState {
  pending: HitlPendingRequest | null;
  loading: boolean;
  error: string | null;
}

export function ChatHitlPromptControls({
  workflowRunId,
  requestId,
  inflight,
  onDecision,
}: ChatHitlPromptControlsProps) {
  const [state, setState] = useState<InnerState>({
    pending: null,
    loading: true,
    error: null,
  });
  const [choice, setChoice] = useState<string>("");
  const [multiChoice, setMultiChoice] = useState<string[]>([]);
  const [freeText, setFreeText] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const list = await listPendingWorkflowHitl(workflowRunId);
      /**
       * 这里特意按 requestId 精确匹配，而不是直接 list[0] —— 对话窗口可能并发挂着
       * 多条 pending（用户连发多轮），requestId 是唯一可信定位。
       */
      const hit = list.find((r) => r.id === requestId) ?? null;
      setState({ pending: hit, loading: false, error: null });
    } catch (e) {
      setState({ pending: null, loading: false, error: (e as Error).message });
    }
  }, [workflowRunId, requestId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.loading) {
    return <div style={loadingStyle}>正在加载审批详情…</div>;
  }

  if (state.error) {
    return (
      <div style={errorStyle} role="alert">
        加载审批失败：{state.error}
        <button type="button" style={smallBtnStyle} onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }

  /**
   * 兜底：requestId 已 resolved（典型场景：用户在团队画布点了同一条 pending 的
   * 拒绝按钮，再切回对话，pending 列表里已经没了）。退化成"基础两按钮"，让对话
   * 流仍能 approve/reject —— 父组件 onDecision 内部仍会 idempotent 处理。
   */
  const fallback = !state.pending;
  const inputKind: HitlInputKind = fallback
    ? "approve_only"
    : state.pending!.inputKind ?? "approve_only";
  const schema: HitlInputSchema = fallback ? {} : state.pending!.inputSchemaJson ?? {};

  const submit = (decision: "approved" | "rejected") => {
    setSubmitError(null);
    try {
      const response =
        decision === "approved"
          ? buildHitlResponsePayload({ inputKind, schema, choice, multiChoice, freeText })
          : null;
      onDecision(decision, response);
    } catch (e) {
      setSubmitError((e as Error).message);
    }
  };

  return (
    <div style={containerStyle}>
      {!fallback ? (
        <div style={metaRowStyle}>
          <span style={kindTagStyle}>{hitlKindLabel(inputKind)}</span>
          {state.pending!.title ? (
            <span style={titleStyle}>{state.pending!.title}</span>
          ) : null}
        </div>
      ) : null}

      <HitlInputArea
        inputKind={inputKind}
        schema={schema}
        choice={choice}
        setChoice={setChoice}
        multiChoice={multiChoice}
        setMultiChoice={setMultiChoice}
        freeText={freeText}
        setFreeText={setFreeText}
        disabled={inflight}
      />

      {submitError ? <div style={inlineErrorStyle}>{submitError}</div> : null}

      <div style={btnRowStyle}>
        <button
          type="button"
          className="qb-btn-primary-brand"
          disabled={inflight}
          onClick={() => submit("approved")}
        >
          {inflight ? "处理中…" : hitlSubmitLabel(inputKind)}
        </button>
        <button
          type="button"
          className="qb-btn-ghost"
          disabled={inflight}
          onClick={() => submit("rejected")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  marginTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const metaRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  color: "var(--qb-chat-meta-fg, #a1a1aa)",
};

const kindTagStyle: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid #78350f",
  color: "#fbbf24",
  fontSize: 10,
};

const titleStyle: React.CSSProperties = {
  fontWeight: 500,
  color: "#fef3c7",
};

const btnRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
};

const loadingStyle: React.CSSProperties = {
  marginTop: 8,
  color: "var(--qb-chat-meta-fg, #a1a1aa)",
  fontSize: 12,
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "6px 8px",
  borderRadius: 4,
  background: "#3f0d12",
  color: "#fecaca",
  fontSize: 12,
};

const smallBtnStyle: React.CSSProperties = {
  marginLeft: 10,
  padding: "2px 8px",
  fontSize: 11,
  background: "transparent",
  border: "1px solid #fecaca",
  color: "#fecaca",
  borderRadius: 4,
  cursor: "pointer",
};

const inlineErrorStyle: React.CSSProperties = {
  padding: "4px 6px",
  background: "#3f0d12",
  color: "#fecaca",
  fontSize: 11,
  borderRadius: 4,
};
