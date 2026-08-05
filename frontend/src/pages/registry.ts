/**
 * 页面注册表（02 §12 / U5 薄层）：PageId → 元数据。
 * 现有页面仍由 MainContent 按 activeView 渲染；本表供壳层导航 / Status / 命令面板共用，
 * 禁止在此直接堆业务 JSX，避免与 MainContent 巨石双写。
 */
import type { ActiveView, InterfaceMode } from "../store";

export type PageShell = "simple" | "pro";

export type PageDescriptor = {
  id: ActiveView;
  /** i18n key under sidebar.nav.* */
  titleKey: string;
  /** 哪些壳默认暴露入口 */
  shells: PageShell[];
  /** 专业壳 Activity / Explorer「页面」分组排序 */
  order: number;
};

/**
 * 与 store ActiveView 对齐。simple 壳收敛入口；pro 全开。
 * 新增页面时：先登记这里，再在 MainContent 增加分支（后续再迁宿主）。
 */
export const PAGE_REGISTRY: readonly PageDescriptor[] = [
  { id: "chat", titleKey: "sidebar.nav.chat", shells: ["simple", "pro"], order: 10 },
  { id: "team", titleKey: "sidebar.nav.team", shells: ["pro"], order: 20 },
  { id: "ide", titleKey: "sidebar.nav.ide", shells: ["pro"], order: 30 },
  { id: "chart", titleKey: "sidebar.nav.chart", shells: ["pro"], order: 40 },
  { id: "quant", titleKey: "sidebar.nav.quant", shells: ["pro"], order: 50 },
  { id: "trader", titleKey: "sidebar.nav.trader", shells: ["pro"], order: 60 },
  { id: "broker", titleKey: "sidebar.nav.broker", shells: ["pro"], order: 70 },
  { id: "monitor", titleKey: "sidebar.nav.monitor", shells: ["simple", "pro"], order: 80 },
  { id: "config", titleKey: "sidebar.nav.config", shells: ["simple", "pro"], order: 90 },
] as const;

export function listPagesForShell(shell: PageShell): PageDescriptor[] {
  return PAGE_REGISTRY.filter((p) => p.shells.includes(shell)).sort(
    (a, b) => a.order - b.order
  );
}

export function getPageDescriptor(id: ActiveView): PageDescriptor | undefined {
  return PAGE_REGISTRY.find((p) => p.id === id);
}

/** store InterfaceMode → 文档壳名 */
export function interfaceModeToShell(mode: InterfaceMode): PageShell {
  return mode === "simple" ? "simple" : "pro";
}
