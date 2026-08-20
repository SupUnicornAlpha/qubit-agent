/**
 * IDE 左栏工具注册（可扩展）。
 * v1 仅挂 Monaco 代码编辑；对话在右侧 Agent。
 *
 * 后续可考虑（按需登记为独立工具，或挂在 Editor 表面切换上）：
 * - preview：Markdown / 研究报告预览
 * - problems：语法、回测、工具失败列表
 * - outline：策略/因子符号大纲
 * - output：Python 回测 / 脚本运行日志（亦可放底栏 Panel）
 *
 * Diff：已作为 IdeEditorPane 的 surface（相对磁盘基线），不必再占左栏工具 Tab。
 */
export type IdeLeftTabId = "editor" | "watchlist";

export type IdeLeftToolDescriptor = {
  id: IdeLeftTabId;
  /** i18n key under ide.leftColumn.* */
  titleKey: string;
  order: number;
};

export const IDE_LEFT_TOOLS: readonly IdeLeftToolDescriptor[] = [
  { id: "watchlist", titleKey: "ide.leftColumn.watchlist", order: 10 },
  { id: "editor", titleKey: "ide.leftColumn.editor", order: 20 },
] as const;

export function listIdeLeftTools(): IdeLeftToolDescriptor[] {
  return [...IDE_LEFT_TOOLS].sort((a, b) => a.order - b.order);
}

export function isIdeLeftTabId(v: string): v is IdeLeftTabId {
  return IDE_LEFT_TOOLS.some((t) => t.id === v);
}
