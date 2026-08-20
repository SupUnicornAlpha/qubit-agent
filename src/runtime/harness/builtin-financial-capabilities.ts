import { CapabilityRegistry } from "./capability-registry";
import {
  getHarnessPackageRuntimeState,
  registerDeclarativeHarnessPackage,
} from "./package-manager";
import type { CapabilityProfile, HarnessCapabilityPlugin } from "./types";

/**
 * Declarations are deliberately data-only in Phase 1. They describe existing
 * Host tools; routing remains on the legacy path until shadow comparison is on.
 */
export const builtinFinancialCapabilities: HarnessCapabilityPlugin[] = [
  {
    manifest: {
      id: "market.core",
      version: "1.0.0",
      title: "市场基础能力",
      kind: "market-data",
      description: "市场识别、数据源说明、可用性与快照读取。",
      permissions: ["market:read"],
      tools: [
        { name: "fetch_klines", mode: "read" },
        { name: "fetch_quote", mode: "read" },
        { name: "fetch_ticks", mode: "read" },
        { name: "market.resolve_symbol", mode: "read" },
        { name: "market.data_sources", mode: "read" },
        { name: "market.readiness", mode: "read" },
        { name: "market.snapshot.get", mode: "read" },
      ],
    },
  },
  {
    manifest: {
      id: "market.ide-subscription",
      version: "1.0.0",
      title: "IDE 自选订阅",
      kind: "market-data",
      description: "读取用户在 IDE 内明确维护的自选订阅。",
      requires: ["market.core"],
      permissions: ["market:read", "watchlist:read"],
      tools: [{ name: "market.ide_subscription.get", mode: "read" }],
    },
  },
  {
    manifest: {
      id: "market.broker-quote",
      version: "1.0.0",
      title: "券商行情读取",
      kind: "market-data",
      description: "读取已经授权且市场覆盖的券商行情，不读取会话记忆代替账户数据。",
      requires: ["market.core"],
      permissions: ["market:read", "broker:quote:read"],
      tools: [{ name: "market.broker_quote.get", mode: "read" }],
    },
  },
  {
    manifest: {
      id: "market.us-options",
      version: "1.0.0",
      title: "美股期权链",
      kind: "market-data",
      description: "在受支持且已授权的数据源下读取期权链。",
      requires: ["market.core"],
      permissions: ["market:read", "options:read"],
      tools: [{ name: "fetch_option_chain", mode: "read" }],
    },
  },
  {
    manifest: {
      id: "research.core",
      version: "1.0.0",
      title: "金融研究",
      kind: "research",
      description: "结构化研究与证据链产出。",
      requires: ["market.core"],
      permissions: ["research:write"],
      tools: [
        { name: "fetch_news", mode: "read" },
        { name: "fetch_fundamentals", mode: "read" },
      ],
    },
  },
  {
    manifest: {
      id: "execution.paper",
      version: "1.0.0",
      title: "模拟交易",
      kind: "execution",
      description: "仅限回测和纸面交易的执行能力。",
      requires: ["market.core", "research.core"],
      permissions: ["execution:paper"],
      tools: [{ name: "run_backtest", mode: "write" }],
    },
  },
  {
    manifest: {
      id: "document.pdf",
      version: "1.0.0",
      title: "PDF 文档交付",
      kind: "document",
      description: "通过已安装的 PDF MCP 或 Skill 读取、生成和归档研究报告。",
      permissions: ["artifact:write", "document:pdf"],
      extensions: [{ kind: "mcp", id: "pdf", optional: true }],
      sandbox: {
        filesystem: "workspace-write",
        approvals: ["workspace-write", "external-plugin"],
      },
    },
  },
  {
    manifest: {
      id: "document.office",
      version: "1.0.0",
      title: "Office 文档交付",
      kind: "document",
      description: "通过已安装的文档扩展生成 Word、演示文稿等可交付 Artifact。",
      permissions: ["artifact:write", "document:office"],
      extensions: [{ kind: "skill", id: "documents", optional: true }],
      sandbox: {
        filesystem: "workspace-write",
        approvals: ["workspace-write", "external-plugin"],
      },
    },
  },
  {
    manifest: {
      id: "data.spreadsheet",
      version: "1.0.0",
      title: "表格分析",
      kind: "data",
      description: "通过已安装的表格扩展创建、读取和验证工作簿。",
      permissions: ["artifact:write", "data:spreadsheet"],
      extensions: [{ kind: "skill", id: "spreadsheets", optional: true }],
      sandbox: {
        filesystem: "workspace-write",
        approvals: ["workspace-write", "external-plugin"],
      },
    },
  },
  {
    manifest: {
      id: "browser.automation",
      version: "1.0.0",
      title: "受控浏览器",
      kind: "browser",
      description: "通过已安装浏览器插件在域名白名单内检索、核验与生成可追溯证据。",
      permissions: ["browser:control"],
      extensions: [{ kind: "skill", id: "browser:control-in-app-browser", optional: true }],
      sandbox: {
        network: "allowlist",
        approvals: ["network", "external-plugin"],
      },
    },
  },
  {
    manifest: {
      id: "developer.workspace",
      version: "1.0.0",
      title: "受控开发工作区",
      kind: "developer",
      description: "仅在受控容器内提供工作区代码编辑、测试与命令执行。",
      permissions: ["workspace:write", "command:execute"],
      tools: [
        { name: "shell.exec", mode: "write" },
        { name: "cli_agent.run", mode: "write" },
      ],
      extensions: [{ kind: "exec-provider", id: "workspace-exec" }],
      sandbox: {
        filesystem: "workspace-write",
        process: "allowlist",
        requireContainer: true,
        approvals: ["workspace-write", "command-execution", "external-plugin"],
      },
    },
  },
  {
    manifest: {
      id: "integration.mcp",
      version: "1.0.0",
      title: "MCP 扩展接入",
      kind: "integration",
      description: "承载经过安装、策略和审计校验的 MCP 扩展，不授予其默认工具权限。",
      permissions: ["integration:mcp"],
      sandbox: { approvals: ["external-plugin"] },
    },
  },
];

export const builtinFinancialProfiles: CapabilityProfile[] = [
  {
    id: "financial-research",
    title: "金融研究",
    description: "行情基础、IDE 自选和研究工具。",
    enable: ["market.core", "market.ide-subscription", "research.core"],
  },
  {
    id: "broker-connected-research",
    title: "已授权券商研究",
    description: "在金融研究基础上附加券商行情读取。",
    extends: ["financial-research"],
    enable: ["market.broker-quote"],
  },
  {
    id: "us-options-research",
    title: "美股期权研究",
    description: "在金融研究基础上附加期权链。",
    extends: ["financial-research"],
    enable: ["market.us-options"],
  },
  {
    id: "paper-trading",
    title: "模拟交易",
    description: "在金融研究基础上附加回测/纸面交易。",
    extends: ["financial-research"],
    enable: ["execution.paper"],
  },
  {
    id: "document-production",
    title: "研究文档交付",
    description: "在金融研究基础上组合 PDF、Office 与表格 Artifact 能力。",
    extends: ["financial-research"],
    enable: ["document.pdf", "document.office", "data.spreadsheet"],
  },
  {
    id: "developer-assist",
    title: "受控开发辅助",
    description: "工作区代码与受控命令能力；必须使用 guarded-container 沙箱。",
    enable: ["developer.workspace", "integration.mcp"],
  },
];

export function createBuiltinFinancialHarnessRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const capability of builtinFinancialCapabilities) registry.register(capability);
  for (const profile of builtinFinancialProfiles) registry.registerProfile(profile);
  for (const pkg of getHarnessPackageRuntimeState().packages) {
    registerDeclarativeHarnessPackage(registry, pkg);
  }
  return registry;
}
