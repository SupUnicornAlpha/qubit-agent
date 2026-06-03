/**
 * v2 HITL 审批横幅 —— 挂在画布下方 / 对话流上方，替换原左侧面板内的卡片。
 *
 * 设计要点（详见 docs/HITL_REDESIGN.md）：
 *   - 自包含：仅靠 workflowRunId + triggerKey 拉详情；父组件无需关心 inputKind
 *   - 4 种交互形态：approve_only / single_choice / multi_choice / free_form
 *   - 拒绝按钮永远在；其余按钮根据 inputKind 决定是否启用 + 校验
 *   - 多个 pending 时取最新一条；后续可考虑展开列表（P2）
 */
import { useCallback, useEffect, useState } from "react";
import {
  type HitlInputKind,
  type HitlInputSchema,
  type HitlPendingRequest,
  listPendingWorkflowHitl,
  resolveWorkflowHitl,
} from "../../api/backend";
import { useTranslation } from "../../i18n";
import {
  HitlInputArea,
  buildHitlResponsePayload,
  hitlKindLabel,
  hitlSubmitLabel,
} from "./HitlInputArea";

export interface TeamHitlBannerProps {
  workflowRunId: string;
  /**
   * 触发器：每次需要重新拉 pending 列表时变化（典型来自外部 onAwaitingApproval 回调）。
   * 同一 requestId 内变化不影响内部状态。
   */
  triggerKey: string;
  /** 解决后通知父组件，让其清理 awaiting 状态并继续轮询 */
  onResolved: (decision: "approved" | "rejected") => void;
}

interface BannerState {
  pending: HitlPendingRequest | null;
  busy: boolean;
  error: string | null;
}

export function TeamHitlBanner({ workflowRunId, triggerKey, onResolved }: TeamHitlBannerProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<BannerState>({ pending: null, busy: false, error: null });
  const [choice, setChoice] = useState<string>("");
  const [multiChoice, setMultiChoice] = useState<string[]>([]);
  const [freeText, setFreeText] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!workflowRunId.trim()) {
      setState((s) => ({ ...s, pending: null }));
      return;
    }
    try {
      const list = await listPendingWorkflowHitl(workflowRunId.trim());
      const latest = list[0] ?? null;
      setState({ pending: latest, busy: false, error: null });
      setChoice("");
      setMultiChoice([]);
      setFreeText("");
    } catch (e) {
      setState({ pending: null, busy: false, error: (e as Error).message });
    }
  }, [workflowRunId]);

  useEffect(() => {
    void refresh();
  }, [refresh, triggerKey]);

  /**
   * 轻量轮询：每 4s 重新拉一次 pending 列表。
   *
   * 这样即便 banner 已挂载且当前没 pending，新触发的 HITL（包括硬规则自动触发的）也能
   * 在几秒内自动出现在画布上，而不是依赖父组件 onAwaitingApproval 回调或手动刷新。
   * 4s 既能压低后端压力（pending 是个简单 SELECT，无连接），又能保证用户感知。
   * 用户正在操作 banner（busy=true）时不刷新，避免提交期间 pending 被清掉造成抖动。
   */
  useEffect(() => {
    if (!workflowRunId.trim()) return;
    const t = setInterval(() => {
      if (state.busy) return;
      void refresh();
    }, 4000);
    return () => clearInterval(t);
  }, [refresh, workflowRunId, state.busy]);

  if (!state.pending && !state.error) return null;
  if (state.error) {
    return (
      <div style={errorBannerStyle} role="alert">
        {t("team.hitl.banner.loadFailed", { err: state.error })}
        <button
          type="button"
          onClick={() => void refresh()}
          style={smallBtnStyle}
        >
          {t("team.hitl.banner.retry")}
        </button>
      </div>
    );
  }

  const p = state.pending!;
  const inputKind: HitlInputKind = p.inputKind ?? "approve_only";
  const schema: HitlInputSchema = p.inputSchemaJson ?? {};

  const submit = async (decision: "approved" | "rejected") => {
    if (state.busy) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const response =
        decision === "approved"
          ? buildHitlResponsePayload({ inputKind, schema, choice, multiChoice, freeText })
          : null;
      await resolveWorkflowHitl(workflowRunId.trim(), p.id, decision, response);
      setState({ pending: null, busy: false, error: null });
      onResolved(decision);
    } catch (e) {
      setState((s) => ({ ...s, busy: false, error: (e as Error).message }));
    }
  };

  return (
    <div style={bannerStyle} role="alert">
      <div style={headerStyle}>
        <span aria-hidden>⏸</span>
        <span style={{ fontWeight: 600 }}>{p.title || t("team.hitl.banner.defaultTitle")}</span>
        <span style={kindTagStyle}>{hitlKindLabel(inputKind)}</span>
      </div>

      {p.summary ? (
        <details style={summaryStyle}>
          <summary style={{ cursor: "pointer", color: "#fbbf24" }}>
            {t("team.hitl.banner.summaryHeader")}
          </summary>
          <pre style={preStyle}>{p.summary}</pre>
        </details>
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
        disabled={state.busy}
      />

      {state.error ? <div style={inlineErrorStyle}>{state.error}</div> : null}

      <div style={btnRowStyle}>
        <button
          type="button"
          className="qb-btn-primary-brand"
          style={{ flex: 2 }}
          onClick={() => void submit("approved")}
          disabled={state.busy}
        >
          {state.busy ? t("team.hitl.banner.processing") : hitlSubmitLabel(inputKind)}
        </button>
        <button
          type="button"
          className="qb-btn-secondary"
          style={{
            flex: 1,
            color: "#fecaca",
            borderColor: "#7f1d1d",
          }}
          onClick={() => void submit("rejected")}
          disabled={state.busy}
        >
          {t("team.hitl.banner.reject")}
        </button>
      </div>
    </div>
  );
}

const bannerStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: 8,
  background: "#1f1d12",
  border: "1px solid #b45309",
  color: "#fde68a",
  fontSize: 12,
  lineHeight: 1.5,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  marginBottom: 10,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const kindTagStyle: React.CSSProperties = {
  marginLeft: "auto",
  padding: "2px 6px",
  border: "1px solid #78350f",
  borderRadius: 4,
  fontSize: 10,
  color: "#fbbf24",
};

const summaryStyle: React.CSSProperties = {
  background: "#0f0e08",
  border: "1px solid #78350f",
  borderRadius: 6,
  padding: "6px 8px",
};

const preStyle: React.CSSProperties = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  margin: "6px 0 0",
  color: "#fde68a",
  fontSize: 11,
  maxHeight: 220,
  overflow: "auto",
};

const btnRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 4,
};

const inlineErrorStyle: React.CSSProperties = {
  color: "#fecaca",
  fontSize: 11,
  padding: "4px 6px",
  background: "#3f0d12",
  borderRadius: 4,
};

const errorBannerStyle: React.CSSProperties = {
  ...bannerStyle,
  background: "#3f0d12",
  borderColor: "#7f1d1d",
  color: "#fecaca",
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
