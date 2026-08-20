/**
 * 页面注册表（02 §12 / U5）：PageId → 元数据 + 组件。
 * 业务 JSX 在各 Page 文件；本表供壳层导航 / Status / 命令面板 / PageHost 共用。
 */
import type { ComponentType } from "react";
import type { ActiveView, InterfaceMode } from "../store";
import { BrokerAccountsPanel } from "../components/broker/BrokerAccountsPanel";
import { IdeResearchWorkbench } from "../components/ide/IdeResearchWorkbench";
import { MonitorDashboard } from "../components/monitor/MonitorDashboard";
import { QuantStudioPanel } from "../components/quant/QuantStudioPanel";
import { TraderLivePanel } from "../components/trader/TraderLivePanel";
import { ChatPanel } from "./ChatPage";
import { ConfigPanel } from "./ConfigPage";
import { MarketWorkspacePage } from "./MarketWorkspacePage";
import { TeamDashboardPanel } from "./TeamPage";

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
  /** 页面根组件 */
  component: ComponentType;
};

/**
 * 与 store ActiveView 对齐。simple 壳收敛入口；pro 全开。
 * 新增页面：登记这里即可被 PageHost / 导航 / Cmd+K 发现。
 */
export const PAGE_REGISTRY: readonly PageDescriptor[] = [
  {
    id: "ide",
    titleKey: "sidebar.nav.ide",
    shells: ["pro"],
    order: 10,
    layout: "ide",
    component: IdeResearchWorkbench,
  },
  {
    id: "team",
    titleKey: "sidebar.nav.team",
    shells: ["pro"],
    order: 0,
    layout: "team",
    component: TeamDashboardPanel,
  },
  {
    id: "chat",
    titleKey: "sidebar.nav.chat",
    /** 专业壳对话常驻右侧 Agent；独立对话页仅简洁模式保留 */
    shells: ["simple"],
    order: 15,
    layout: "chat",
    component: ChatPanel,
  },
  {
    id: "trader",
    titleKey: "sidebar.nav.trader",
    shells: ["pro"],
    order: 30,
    layout: "trader",
    component: TraderLivePanel,
  },
  {
    id: "quant",
    titleKey: "sidebar.nav.quant",
    shells: ["pro"],
    order: 40,
    layout: "default",
    component: QuantStudioPanel,
  },
  {
    id: "chart",
    titleKey: "sidebar.nav.chart",
    shells: ["pro"],
    order: 50,
    layout: "ide",
    component: MarketWorkspacePage,
  },
  {
    id: "monitor",
    titleKey: "sidebar.nav.monitor",
    shells: ["simple", "pro"],
    order: 60,
    layout: "default",
    component: MonitorDashboard,
  },
  {
    id: "broker",
    titleKey: "sidebar.nav.broker",
    shells: ["pro"],
    order: 70,
    layout: "default",
    component: BrokerAccountsPanel,
  },
  {
    id: "config",
    titleKey: "sidebar.nav.config",
    shells: ["simple", "pro"],
    order: 80,
    layout: "default",
    component: ConfigPanel,
  },
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
