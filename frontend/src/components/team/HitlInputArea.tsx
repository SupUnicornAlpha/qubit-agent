/**
 * HITL 输入区组件（4 种形态共用渲染）。
 *
 * 历史：早先仅在 `TeamHitlBanner.tsx` 内联实现，对话窗口那条 HITL 路径直接两个按钮
 * 写死 approve/reject，所以 single_choice / multi_choice / free_form 在对话场景下
 * 根本没法显示。把 InputArea 抽出来后，对话气泡里的 `ChatHitlPromptControls` 也
 * 能复用——两条路径共用同一份 schema → UI 渲染逻辑。
 *
 * 不依赖 backend.ts 之外的全局状态；外层负责拉 pending 详情与提交。
 */
import type { HitlInputKind, HitlInputSchema } from "../../api/backend";
import { t, useTranslation } from "../../i18n";

export interface HitlInputAreaProps {
  controlId: string;
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

export function HitlInputArea(props: HitlInputAreaProps) {
  const { t: tt } = useTranslation();
  const { inputKind, schema, disabled } = props;
  const options = schema.options ?? [];

  if (inputKind === "approve_only") return null;

  if (inputKind === "single_choice") {
    if (options.length === 0) {
      return <div style={hintStyle}>{tt("team.hitl.inputArea.missingOptions")}</div>;
    }
    return (
      <div style={optionListStyle}>
        {options.map((opt) => (
          <label key={opt.value} style={optionRowStyle}>
            <input
              type="radio"
              name={`hitl-single-${props.controlId}`}
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
      return <div style={hintStyle}>{tt("team.hitl.inputArea.missingOptions")}</div>;
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
            {schema.minSelect ? tt("team.hitl.inputArea.minSelect", { n: schema.minSelect }) : ""}
            {schema.minSelect && schema.maxSelect ? tt("team.hitl.inputArea.minMaxJoiner") : ""}
            {schema.maxSelect ? tt("team.hitl.inputArea.maxSelect", { n: schema.maxSelect }) : ""}
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
      placeholder={schema.placeholder ?? tt("team.hitl.inputArea.defaultPlaceholder")}
      maxLength={schema.maxLength ?? 500}
      disabled={disabled}
      rows={3}
      style={textareaStyle}
    />
  );
}

/** 提交按钮文案 —— Banner 与 ChatHitlPromptControls 共用，避免文案漂移 */
export function hitlSubmitLabel(kind: HitlInputKind): string {
  switch (kind) {
    case "approve_only":
      return t("team.hitl.submit.approveOnly");
    case "single_choice":
    case "multi_choice":
      return t("team.hitl.submit.choice");
    case "free_form":
      return t("team.hitl.submit.freeForm");
  }
}

/** 顶部小标签 —— 让用户一眼分清"确认/单选/多选/自由输入" */
export function hitlKindLabel(kind: HitlInputKind): string {
  switch (kind) {
    case "approve_only":
      return t("team.hitl.kind.approveOnly");
    case "single_choice":
      return t("team.hitl.kind.singleChoice");
    case "multi_choice":
      return t("team.hitl.kind.multiChoice");
    case "free_form":
      return t("team.hitl.kind.freeForm");
  }
}

/**
 * 把当前状态 + inputKind 校验并打包成 response（resolveWorkflowHitl 第 4 个参数）。
 * 校验失败抛 Error；外层 try/catch 后展示到 inline error 区。
 *
 * 抽出来是为了两个调用点（TeamHitlBanner / ChatHitlPromptControls）逻辑一致 —— 任何
 * 一边改了校验规则，另一边自动跟上。
 */
export function buildHitlResponsePayload(input: {
  inputKind: HitlInputKind;
  schema: HitlInputSchema;
  choice: string;
  multiChoice: string[];
  freeText: string;
}): Record<string, unknown> | null {
  const { inputKind, schema, choice, multiChoice, freeText } = input;
  if (inputKind === "single_choice") {
    if (!choice) throw new Error(t("team.hitl.validation.needChoice"));
    if (!(schema.options ?? []).some((option) => option.value === choice)) {
      throw new Error(t("team.hitl.validation.needChoice"));
    }
    return { value: choice };
  }
  if (inputKind === "multi_choice") {
    const allowed = new Set((schema.options ?? []).map((option) => option.value));
    const values = [...new Set(multiChoice)].filter((value) => allowed.has(value));
    const minSelect = schema.minSelect ?? 1;
    const maxSelect = schema.maxSelect ?? allowed.size;
    if (values.length < minSelect) {
      throw new Error(t("team.hitl.validation.needMin", { n: minSelect }));
    }
    if (values.length > maxSelect) {
      throw new Error(t("team.hitl.validation.needMax", { n: maxSelect }));
    }
    return { values };
  }
  if (inputKind === "free_form") {
    const text = freeText.trim();
    if (!text) throw new Error(t("team.hitl.validation.needText"));
    return { text };
  }
  return null;
}

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

const hintStyle: React.CSSProperties = {
  color: "#a1a1aa",
  fontSize: 11,
  padding: "4px 0",
};
