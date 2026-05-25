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

  if (!state.pending && !state.error) return null;
  if (state.error) {
    return (
      <div style={errorBannerStyle} role="alert">
        HITL 加载失败：{state.error}
        <button
          type="button"
          onClick={() => void refresh()}
          style={smallBtnStyle}
        >
          重试
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
      let response: Record<string, unknown> | null = null;
      if (decision === "approved") {
        if (inputKind === "single_choice") {
          if (!choice) {
            throw new Error("请先选择一项");
          }
          response = { value: choice };
        } else if (inputKind === "multi_choice") {
          if (
            schema.minSelect !== undefined &&
            multiChoice.length < schema.minSelect
          ) {
            throw new Error(`至少选择 ${schema.minSelect} 项`);
          }
          if (
            schema.maxSelect !== undefined &&
            multiChoice.length > schema.maxSelect
          ) {
            throw new Error(`最多选择 ${schema.maxSelect} 项`);
          }
          response = { values: multiChoice };
        } else if (inputKind === "free_form") {
          const text = freeText.trim();
          if (!text) {
            throw new Error("请输入指引内容");
          }
          response = { text };
        }
      }
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
        <span style={{ fontWeight: 600 }}>{p.title || "等待人工审批"}</span>
        <span style={kindTagStyle}>{kindLabel(inputKind)}</span>
      </div>

      {p.summary ? (
        <details style={summaryStyle}>
          <summary style={{ cursor: "pointer", color: "#fbbf24" }}>
            Orchestrator 规划摘要 / 触发原因
          </summary>
          <pre style={preStyle}>{p.summary}</pre>
        </details>
      ) : null}

      <InputArea
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
          {state.busy ? "处理中…" : submitLabel(inputKind)}
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
          拒绝（中止）
        </button>
      </div>
    </div>
  );
}

function kindLabel(kind: HitlInputKind): string {
  switch (kind) {
    case "approve_only":
      return "确认";
    case "single_choice":
      return "单选";
    case "multi_choice":
      return "多选";
    case "free_form":
      return "输入指引";
  }
}

function submitLabel(kind: HitlInputKind): string {
  switch (kind) {
    case "approve_only":
      return "批准并继续";
    case "single_choice":
    case "multi_choice":
      return "提交选择";
    case "free_form":
      return "提交指引";
  }
}

interface InputAreaProps {
  inputKind: HitlInputKind;
  schema: HitlInputSchema;
  choice: string;
  setChoice: (v: string) => void;
  multiChoice: string[];
  setMultiChoice: (v: string[]) => void;
  freeText: string;
  setFreeText: (v: string) => void;
  disabled: boolean;
}

function InputArea(props: InputAreaProps) {
  const { inputKind, schema, disabled } = props;
  const options = schema.options ?? [];

  if (inputKind === "approve_only") return null;

  if (inputKind === "single_choice") {
    if (options.length === 0) {
      return <div style={hintStyle}>（缺少选项，仅可批准/拒绝）</div>;
    }
    return (
      <div style={optionListStyle}>
        {options.map((opt) => (
          <label key={opt.value} style={optionRowStyle}>
            <input
              type="radio"
              name="hitl-single"
              checked={props.choice === opt.value}
              onChange={() => props.setChoice(opt.value)}
              disabled={disabled}
            />
            <div>
              <div style={{ color: "#fef3c7" }}>{opt.label}</div>
              {opt.description ? (
                <div style={{ color: "#a1a1aa", fontSize: 11 }}>{opt.description}</div>
              ) : null}
            </div>
          </label>
        ))}
      </div>
    );
  }

  if (inputKind === "multi_choice") {
    if (options.length === 0) {
      return <div style={hintStyle}>（缺少选项，仅可批准/拒绝）</div>;
    }
    return (
      <div style={optionListStyle}>
        {options.map((opt) => {
          const checked = props.multiChoice.includes(opt.value);
          return (
            <label key={opt.value} style={optionRowStyle}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) {
                    props.setMultiChoice([...props.multiChoice, opt.value]);
                  } else {
                    props.setMultiChoice(props.multiChoice.filter((v) => v !== opt.value));
                  }
                }}
                disabled={disabled}
              />
              <div>
                <div style={{ color: "#fef3c7" }}>{opt.label}</div>
                {opt.description ? (
                  <div style={{ color: "#a1a1aa", fontSize: 11 }}>{opt.description}</div>
                ) : null}
              </div>
            </label>
          );
        })}
        {schema.minSelect || schema.maxSelect ? (
          <div style={hintStyle}>
            {schema.minSelect ? `至少 ${schema.minSelect} 项` : ""}
            {schema.minSelect && schema.maxSelect ? "，" : ""}
            {schema.maxSelect ? `最多 ${schema.maxSelect} 项` : ""}
          </div>
        ) : null}
      </div>
    );
  }

  // free_form
  return (
    <textarea
      value={props.freeText}
      onChange={(e) => props.setFreeText(e.target.value)}
      placeholder={schema.placeholder ?? "请输入对 Orchestrator 的指引（≤500 字符）"}
      maxLength={schema.maxLength ?? 500}
      disabled={disabled}
      rows={3}
      style={textareaStyle}
    />
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

const optionListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 0",
};

const optionRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  cursor: "pointer",
  padding: "4px 6px",
  borderRadius: 4,
};

const textareaStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  background: "#0f0e08",
  border: "1px solid #78350f",
  borderRadius: 6,
  color: "#fde68a",
  fontSize: 12,
  resize: "vertical",
};

const btnRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 4,
};

const hintStyle: React.CSSProperties = {
  color: "#a1a1aa",
  fontSize: 11,
  padding: "4px 0",
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
