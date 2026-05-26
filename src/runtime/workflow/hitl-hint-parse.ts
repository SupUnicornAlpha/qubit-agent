/**
 * 共享 HITL 自评提示（`hitlHint`）解析。
 *
 * 由两条路径使用：
 *   1. **研究团队 orchestrator plan**（`analyst-team-pipeline.ts#runOrchestratorPlanning`）：
 *      LLM 在 Markdown 简报后追加分隔符 + JSON。详见 docs/HITL_REDESIGN.md §5。
 *   2. **对话 orchestrator reason**（`langgraph/nodes/hitl-gate.ts`）：
 *      LLM 在 reasonText 末尾的 `<TOOL_CALL>` 之**外**追加同样格式，让对话 HITL
 *      也能落 single_choice / multi_choice / free_form，而不是只画 approve/reject。
 *
 * 两条路径用同一个分隔符 + 同一个 parser，避免协议漂移；同时也让 `analyst-team`
 * 已有的单测继续按原行为通过。
 */

export type OrchestratorHitlHint = {
  /** 是否建议人工介入；undefined / false = 默认不打扰 */
  needed?: boolean;
  /** ≤200 字短句，会写入 UI 给用户看 */
  reason?: string;
  /** 推荐的交互形态；缺省 `approve_only` */
  inputKind?: "approve_only" | "single_choice" | "multi_choice" | "free_form";
  /** single_choice / multi_choice 形态的选项 */
  options?: Array<{ label: string; value: string; description?: string }>;
};

export type OrchestratorPlanResult = {
  brief: string;
  hitlHint: OrchestratorHitlHint | null;
};

export const HITL_HINT_DELIMITER = "---HITL_HINT_JSON---";

/**
 * 从 LLM 全文里抠出分隔符之后的 HITL JSON 块；同时返回去掉 hint 段的 brief。
 *
 * 解析容错：找不到分隔符或 JSON 无效都视为 hitlHint=null（让 evaluator 走 mode 默认）。
 * 同样宽松对待 `inputKind` 字段——只接受白名单值，其它一律 undefined。
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
    const inputKindRaw = raw.inputKind;
    const inputKind: OrchestratorHitlHint["inputKind"] =
      inputKindRaw === "single_choice" ||
      inputKindRaw === "multi_choice" ||
      inputKindRaw === "free_form" ||
      inputKindRaw === "approve_only"
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
    return { brief, hitlHint: { needed, reason, inputKind, options } };
  } catch {
    return { brief, hitlHint: null };
  }
}

/**
 * 对话 orchestrator 复用的便捷封装：从 reasonText 里只抠 hitlHint。
 * 与团队版区别：忽略 brief 部分，因为对话 reasonText 本身就是给前端显示的；
 * 解析失败也不会污染 brief，调用方拿不到 hint 就当用户没暗示。
 */
export function extractHitlHintFromText(text: string | null | undefined): OrchestratorHitlHint | null {
  if (!text) return null;
  return parsePlanWithHitlHint(text).hitlHint;
}

/**
 * 对话 orchestrator 的 system prompt 增量：教 LLM 何时主动出 HITL 选择题。
 *
 * 与团队 plan 区别：
 *   - 团队 plan 是一次性输出 brief + hitlHint；
 *   - 对话 reason 是逐轮 ReAct，hitlHint 选项要克制（多数轮不需要打扰），
 *     所以默认 `needed=false`，只有特定信号才升级到 `needed=true`。
 *
 * 这个块只在 `role === 'orchestrator'` 且工作流 source = chat 的情况注入；
 * 分析师 / research / risk 等次级 agent 不会画 HITL，注入只会噪声化 LLM 输出。
 */
export function buildChatHitlSelfCheckPromptBlock(): string {
  return [
    "## HITL 自评（仅对话 orchestrator 适用）",
    "在你按工具说明输出 `<TOOL_CALL>` 之后，如果**本轮工具调用**需要让用户在执行前介入，",
    `**可选**追加分隔符 \`${HITL_HINT_DELIMITER}\` 与一段 JSON，例如：`,
    "",
    "```",
    HITL_HINT_DELIMITER,
    '{"needed": true, "reason": "存在两条合理执行路径", "inputKind": "single_choice",',
    ' "options": [{"label": "走 A 方案（保守）", "value": "a"}, {"label": "走 B 方案（激进）", "value": "b"}]}',
    "```",
    "",
    "判定依据（`needed=true` 的典型场景）：",
    "- 你识别到 ≥2 条同样合理的执行路径，希望用户拍板；",
    "- 用户原始意图含糊（如「帮我看一下」「随便分析下」），需要一句话指引；",
    "- 工具调用即将改变外部状态（下单、写入配置、删除等），但**该工具不在内置高危名单**里。",
    "",
    "`inputKind` 选择：",
    "- `approve_only`：你已经选好路径，只想确认 → `options` 可省；",
    "- `single_choice`：路径间选一条 → **必带 options=[{label,value}]**；",
    "- `multi_choice`：勾选多个子项（如要包含哪些分析维度） → **必带 options**；",
    "- `free_form`：希望用户用自然语言给指引 → `options` 可省。",
    "",
    "其余情况**不要**追加该块——绝大多数工具调用都是常规读数据/计算/报告，不需要打扰用户。",
    "（系统已对下单 / 删除 / 自修改 prompt 等高危工具做硬规则拦截，无需你重复声明。）",
  ].join("\n");
}
