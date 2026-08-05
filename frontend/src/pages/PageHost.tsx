/**
 * 页面宿主（02 §3.2 / U5）：按注册表渲染页面，不在此堆业务逻辑。
 */
import type { CSSProperties, FC } from "react";
import { useAppStore } from "../store";
import { getPageDescriptor, type PageLayout } from "./registry";
import { MonitorDashboard } from "../components/monitor/MonitorDashboard";

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

/** 中栏 / 简洁壳共用的页面宿主 */
export const PageHost: FC = () => {
  const activeView = useAppStore((s) => s.activeView);
  const desc = getPageDescriptor(activeView);
  const layout = desc?.layout ?? "default";
  const Page = desc?.component ?? MonitorDashboard;

  return (
    <main className="qb-page-host" data-page={activeView} style={shellStyle[layout]}>
      <Page />
    </main>
  );
};
