/**
 * IDE 左栏工具注册（可扩展）。
 * 右侧 Agent 栏负责对话；此处不再挂 Chat。
 */
export type IdeLeftTabId = "editor" | "indicator";

export type IdeLeftToolDescriptor = {
  id: IdeLeftTabId;
  /** i18n key under ide.leftColumn.* */
  titleKey: string;
  order: number;
};

export const IDE_LEFT_TOOLS: readonly IdeLeftToolDescriptor[] = [
  { id: "editor", titleKey: "ide.leftColumn.editor", order: 10 },
  { id: "indicator", titleKey: "ide.leftColumn.indicator", order: 20 },
] as const;

export function listIdeLeftTools(): IdeLeftToolDescriptor[] {
  return [...IDE_LEFT_TOOLS].sort((a, b) => a.order - b.order);
}

export function isIdeLeftTabId(v: string): v is IdeLeftTabId {
  return IDE_LEFT_TOOLS.some((t) => t.id === v);
}
