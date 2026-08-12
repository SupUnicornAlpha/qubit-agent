/**
 * 共享 HITL 自评提示（`hitlHint`）解析。
 *
 * 由两条路径使用：
 *   1. **研究团队 orchestrator plan**（`analyst-team-pipeline.ts#runOrchestratorPlanning`）
 *   2. **对话 orchestrator reason**（`react/nodes/hitl-gate.ts`）
 *
 * 2026-08：扩展 form 填空、allowFreeText、独立提问（可无 TOOL_CALL）。
 */

export type OrchestratorHitlHint = {
  /** 是否建议人工介入；undefined / false = 默认不打扰 */
  needed?: boolean;
  /** ≤200 字短句，会写入 UI 给用户看 */
  reason?: string;
  /** 完整问题（可长于 reason） */
  question?: string;
  /** 推荐的交互形态；缺省 `approve_only` */
  inputKind?: "approve_only" | "single_choice" | "multi_choice" | "free_form" | "form";
  /** single_choice / multi_choice 形态的选项 */
  options?: Array<{ label: string; value: string; description?: string }>;
  /** 选择题是否允许额外补充说明 */
  allowFreeText?: boolean;
  /** form / 选择题附带的填空字段 */
  fields?: Array<{
    key: string;
    label: string;
    type?: "text" | "number";
    required?: boolean;
    placeholder?: string;
  }>;
  placeholder?: string;
};

export type OrchestratorPlanResult = {
  brief: string;
  hitlHint: OrchestratorHitlHint | null;
};

export const HITL_HINT_DELIMITER = "---HITL_HINT_JSON---";

/**
 * 从 LLM 全文里抠出分隔符之后的 HITL JSON 块；同时返回去掉 hint 段的 brief。
 */
export function parsePlanWithHitlHint(answer: string): OrchestratorPlanResult {
  const idx = answer.indexOf(HITL_HINT_DELIMITER);
  if (idx < 0) return { brief: answer.trim() || "（无编排简报）", hitlHint: null };
  const brief = answer.slice(0, idx).trim() || "（无编排简报）";
  const rest = answer.slice(idx + HITL_HINT_DELIMITER.length);
  const m = rest.match(/\{[\s\S]*\}/);
  if (!m) return { brief, hitlHint: null };
  try {
    const raw = JSON.parse(m[0]) as Record<string, unknown>;
    const needed = raw.needed === true ? true : raw.needed === false ? false : undefined;
    const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 200) : undefined;
    const question =
      typeof raw.question === "string"
        ? raw.question.slice(0, 500)
        : typeof raw.prompt === "string"
          ? raw.prompt.slice(0, 500)
          : undefined;
    const inputKindRaw = raw.inputKind;
    const inputKind: OrchestratorHitlHint["inputKind"] =
      inputKindRaw === "single_choice" ||
      inputKindRaw === "multi_choice" ||
      inputKindRaw === "free_form" ||
      inputKindRaw === "approve_only" ||
      inputKindRaw === "form"
        ? inputKindRaw
        : undefined;
    const options =
      Array.isArray(raw.options) &&
      raw.options.every(
        (o) =>
          o && typeof o === "object" && typeof (o as Record<string, unknown>).value === "string"
      )
        ? (raw.options as Array<Record<string, unknown>>).map((o) => ({
            label: String(o.label ?? o.value ?? ""),
            value: String(o.value ?? ""),
            description: typeof o.description === "string" ? o.description : undefined,
          }))
        : undefined;
    const fields = Array.isArray(raw.fields)
      ? (raw.fields as Array<Record<string, unknown>>)
          .filter(
            (f) => f && typeof f === "object" && typeof f.key === "string" && String(f.key).trim()
          )
          .map((f) => ({
            key: String(f.key).trim(),
            label: String(f.label ?? f.key ?? "").trim(),
            type: f.type === "number" ? ("number" as const) : ("text" as const),
            required: f.required !== false,
            placeholder:
              typeof f.placeholder === "string" ? f.placeholder.slice(0, 200) : undefined,
          }))
      : undefined;
    return {
      brief,
      hitlHint: {
        needed,
        reason,
        question,
        inputKind,
        options,
        allowFreeText: raw.allowFreeText === true ? true : undefined,
        fields,
        placeholder:
          typeof raw.placeholder === "string" ? raw.placeholder.slice(0, 300) : undefined,
      },
    };
  } catch {
    return { brief, hitlHint: null };
  }
}

export function extractHitlHintFromText(
  text: string | null | undefined
): OrchestratorHitlHint | null {
  if (!text) return null;
  return parsePlanWithHitlHint(text).hitlHint;
}

/**
 * 对话 orchestrator 的 system prompt 增量：何时主动出 HITL 提问 / 选择题 / 填空。
 */
export function buildChatHitlSelfCheckPromptBlock(): string {
  return [
    "## HITL 人机协作（提问 / 选择题 / 填空 → 用户作答后 resume）",
    "当你需要用户做决策、补参数、或在多条路径中拍板时，在输出末尾追加：",
    "",
    "```",
    HITL_HINT_DELIMITER,
    '{"needed": true, "question": "你希望优先降低成本还是控制回撤？",',
    ' "inputKind": "single_choice",',
    ' "options": [{"label": "摊低成本（可加仓）", "value": "avg_down"}, {"label": "控制回撤（偏防守）", "value": "defend"}],',
    ' "allowFreeText": true, "placeholder": "可选：补充持仓量/成本/可承受亏损"}',
    "```",
    "",
    "也可单独填空（form）：",
    "```",
    HITL_HINT_DELIMITER,
    '{"needed": true, "question": "请补充关键参数以便继续", "inputKind": "form",',
    ' "fields": [{"key": "cost", "label": "持仓成本", "required": true}, {"key": "shares", "label": "股数", "type": "number"}]}',
    "```",
    "",
    "`inputKind`：",
    "- `approve_only`：只确认/拒绝（高危工具系统会强制此形态）",
    "- `single_choice` / `multi_choice`：必带 `options`；可选 `allowFreeText` + `fields`",
    "- `free_form`：一整段自然语言",
    "- `form`：结构化填空，必带 `fields=[{key,label,...}]`",
    "",
    "**可以不挂 `<TOOL_CALL>` 就提问**：若你只需要用户回答再决定下一步，输出思考 + HITL 块即可",
    "（系统会 pause，用户提交后 resume，并把答案注入你的下一轮上下文）。",
    "",
    "常规拉数/计算**不要**打扰用户。高危下单/删除无需你自声明，系统硬规则会拦截。",
  ].join("\n");
}
