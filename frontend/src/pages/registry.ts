/**
 * 页面注册表（02 §12 / U5）：PageId → 元数据。
 * 实际组件挂载见 `PageHost`；本表供壳层导航 / Status / 命令面板共用，
 * 禁止在此直接堆业务 JSX，避免与 MainContent 巨石双写。
 */
import type { ActiveView, InterfaceMode } from "../store";

export type PageShell = "simple" | "pro";

/** 中栏外壳布局（与 PageHost shellStyle 对齐） */
export type PageLayout = "default" | "chat" | "team" | "ide" | "trader";

export type PageDescriptor = {
  id: ActiveView;
  /** i18n key under sidebar.nav.* */
  titleKey: string;
  /** 哪些壳默认暴露入口 */
  shells: PageShell[];
  /** 专业壳 Activity / Explorer「页面」分组排序 */
  order: number;
  /** 中栏 main 布局变体 */
  layout: PageLayout;
};

/**
 * 与 store ActiveView 对齐。simple 壳收敛入口；pro 全开。
 * 新增页面：先登记这里，再在 PageHost 的 PAGE_COMPONENT 挂载。
 */
export const PAGE_REGISTRY: readonly PageDescriptor[] = [
  { id: "chat", titleKey: "sidebar.nav.chat", shells: ["simple", "pro"], order: 10, layout: "chat" },
  { id: "team", titleKey: "sidebar.nav.team", shells: ["pro"], order: 20, layout: "team" },
  { id: "ide", titleKey: "sidebar.nav.ide", shells: ["pro"], order: 30, layout: "ide" },
  { id: "chart", titleKey: "sidebar.nav.chart", shells: ["pro"], order: 40, layout: "ide" },
  { id: "quant", titleKey: "sidebar.nav.quant", shells: ["pro"], order: 50, layout: "default" },
  { id: "trader", titleKey: "sidebar.nav.trader", shells: ["pro"], order: 60, layout: "trader" },
  { id: "broker", titleKey: "sidebar.nav.broker", shells: ["pro"], order: 70, layout: "default" },
  { id: "monitor", titleKey: "sidebar.nav.monitor", shells: ["simple", "pro"], order: 80, layout: "default" },
  { id: "config", titleKey: "sidebar.nav.config", shells: ["simple", "pro"], order: 90, layout: "default" },
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
