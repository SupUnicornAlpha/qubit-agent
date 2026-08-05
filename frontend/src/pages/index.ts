/** pages 公共出口：宿主 + 注册表 + 页面组件 */
export { PageHost } from "./PageHost";
export {
  PAGE_REGISTRY,
  getPageDescriptor,
  listPagesForShell,
  interfaceModeToShell,
  type PageDescriptor,
  type PageLayout,
  type PageShell,
} from "./registry";
export { ChatPanel } from "./ChatPage";
export { ConfigPanel } from "./ConfigPage";
export { TeamDashboardPanel } from "./TeamPage";
