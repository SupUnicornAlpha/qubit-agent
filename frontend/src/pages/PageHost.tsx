/**
 * 页面宿主（02 §3.2 / U5）：按 PageId 渲染既有页面，不在此堆业务逻辑。
 * MainContent 巨石里的 Chat/Team/Config 经 lazy 挂载，避免与本模块循环依赖。
 */
import { lazy, Suspense, type CSSProperties, type ComponentType, type FC } from "react";
import { BrokerAccountsPanel } from "../components/broker/BrokerAccountsPanel";
import { KlinePanel } from "../components/chart/KlinePanel";
import { IdeResearchWorkbench } from "../components/ide/IdeResearchWorkbench";
import { MonitorDashboard } from "../components/monitor/MonitorDashboard";
import { QuantStudioPanel } from "../components/quant/QuantStudioPanel";
import { TraderLivePanel } from "../components/trader/TraderLivePanel";
import { useAppStore, type ActiveView } from "../store";
import { getPageDescriptor, type PageLayout } from "./registry";

const ChatPanel = lazy(() =>
  import("../components/layout/MainContent").then((m) => ({ default: m.ChatPanel }))
);
const TeamDashboardPanel = lazy(() =>
  import("../components/layout/MainContent").then((m) => ({ default: m.TeamDashboardPanel }))
);
const ConfigPanel = lazy(() =>
  import("../components/layout/MainContent").then((m) => ({ default: m.ConfigPanel }))
);

const shellStyle: Record<PageLayout, CSSProperties> = {
  default: { flex: 1, minWidth: 0, minHeight: 0, overflow: "auto", padding: 24 },
  chat: {
    flex: 1,
    width: "100%",
    maxWidth: "100%",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 16,
  },
  team: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  ide: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  trader: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
};

const IdePage: FC = () => (
  <Suspense fallback={null}>
    <IdeResearchWorkbench renderChat={() => <ChatPanel ideEmbedded />} />
  </Suspense>
);

const PAGE_COMPONENT: Record<ActiveView, ComponentType> = {
  chat: ChatPanel,
  team: TeamDashboardPanel,
  ide: IdePage,
  chart: KlinePanel,
  quant: QuantStudioPanel,
  trader: TraderLivePanel,
  broker: BrokerAccountsPanel,
  monitor: MonitorDashboard,
  config: ConfigPanel,
};

function PageFallback() {
  return (
    <div style={{ padding: 24, color: "var(--qb-sidebar-muted, #9d9d9d)", fontSize: 13 }}>
      Loading…
    </div>
  );
}

/** 中栏 / 简洁壳共用的页面宿主 */
export const PageHost: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const desc = getPageDescriptor(activeView);
  const layout = desc?.layout ?? "default";
  const Page = PAGE_COMPONENT[activeView] ?? MonitorDashboard;

  return (
    <main className="qb-page-host" data-page={activeView} style={shellStyle[layout]}>
      <Suspense fallback={<PageFallback />}>
        <Page />
      </Suspense>
    </main>
  );
};
