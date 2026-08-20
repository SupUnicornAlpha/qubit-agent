/**
 * 工作流列表没有独立的「显示标题」字段，研究团队占位 workflow 曾直接把
 * `研究团队 · 单标的 · 标的 · 时间` 当作 goal 写入，导致整个列表看起来都一样。
 *
 * 这里保留 `研究团队` 前缀（工作流分类仍以它作为兼容信号），仅将首条用户问题
 * 归纳为短标题。完整问题仍保存在会话消息与 rolling chronicle 中，不会因标题截短丢失。
 */
const MAX_TITLE_CHARS = 42;

export function isResearchTeamPlaceholderTitle(value: string | null | undefined): boolean {
  const title = value?.trim() ?? "";
  return /^研究团队\s*[·・|｜-]\s*(单标的|多标的篮子|板块|自由探索|标的)(?:\s*[·・|｜-]|$)/.test(
    title
  );
}

function clip(value: string, maxChars = MAX_TITLE_CHARS): string {
  const chars = Array.from(value);
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("")}…` : value;
}

/** 将用户首问收束成适合工作流侧栏展示的一行标题。 */
export function summarizeResearchQuestionTitle(message: string): string {
  const normalized = message
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^(?:你好[，,！!。\s]*)?(?:请(?:你|帮我|帮忙)?|帮我|麻烦(?:你)?|我想(?:请)?|能否|可否|可以(?:帮我)?)[，,：:\s]*/u,
      ""
    )
    .replace(/^(?:帮我|请你)[，,：:\s]*/u, "")
    .replace(/[。！？!?；;]+$/u, "")
    .trim();

  // 优先取用户表达的第一个完整意图，避免将长篇约束全部塞进侧栏标签。
  const firstIntent = normalized.split(/[。！？!?；;]+/u, 1)[0]?.trim() ?? "";
  return `研究团队 · ${clip(firstIntent || "新研究任务")}`;
}
