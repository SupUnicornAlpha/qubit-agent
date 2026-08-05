/**
 * IDE 左栏工具注册（可扩展）。
 * v1 仅挂 Monaco 代码编辑；对话在右侧 Agent。
 *
 * 后续可考虑（尚未实现，按需登记）：
 * - diff：Agent / 人工改文件前后对比
 * - preview：Markdown / 研究报告预览
 * - problems：语法、回测、工具失败列表
 * - outline：策略/因子符号大纲
 * - output：Python 回测 / 脚本运行日志（亦可放底栏 Panel）
 */
export type IdeLeftTabId = "editor";

export type IdeLeftToolDescriptor = {
  id: IdeLeftTabId;
  /** i18n key under ide.leftColumn.* */
  titleKey: string;
  order: number;
};

export const IDE_LEFT_TOOLS: readonly IdeLeftToolDescriptor[] = [
  { id: "editor", titleKey: "ide.leftColumn.editor", order: 10 },
] as const;

export function listIdeLeftTools(): IdeLeftToolDescriptor[] {
  return [...IDE_LEFT_TOOLS].sort((a, b) => a.order - b.order);
}

export function isIdeLeftTabId(v: string): v is IdeLeftTabId {
  return IDE_LEFT_TOOLS.some((t) => t.id === v);
}
