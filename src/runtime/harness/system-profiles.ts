import type { CapabilityProfile } from "./types";

/**
 * Product-owned profiles are versioned with the Host, not installed as third-party
 * packages. Keeping this data module dependency-free lets both the registry and
 * the configuration service expose the same safe, editable catalogue.
 */
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
