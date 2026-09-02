import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import type { CapabilityRegistry } from "./capability-registry";
import {
  QUANT_RESEARCH_INTEGRITY_CAPABILITY_ID,
  listQuantResearchIntegrityStages,
} from "./quant-research-integrity";
import type { HarnessCapabilityKind } from "./types";
import {
  MATH_AUDIT_PROFILE_ID,
  MATH_AUDIT_REQUIRED_SCENARIOS,
  QUANT_RESEARCH_INTEGRITY_PROFILE_ID,
  RESEARCH_INTEGRITY_SCENARIOS,
} from "./workflow-harness";

export type HarnessAdmissionKind = "global_toggle" | "workflow_lease";
export type HarnessAdmissionMode = "off" | "advisory" | "required";
export type HostProductionGateLayer = "research" | "backtest" | "execution" | "live";
export type HostProductionGateRole = "gate" | "observation";

export type HarnessInspectionCapability = {
  id: string;
  title: string;
  kind: HarnessCapabilityKind;
  description: string;
  tools: string[];
};

export type HarnessAdmissionPolicy = {
  kind: HarnessAdmissionKind;
  defaultMode: HarnessAdmissionMode;
  summary: string;
  configKey?: string;
  scenarios: Array<{ id: string; mode: Exclude<HarnessAdmissionMode, "off"> }>;
  workflowModes: Array<{ id: string; mode: Exclude<HarnessAdmissionMode, "off"> }>;
  unloadNote: string;
};

export type HarnessEvidenceStage = {
  stage: "research" | "paper" | "live";
  enforcement: "advisory" | "required";
  checks: Array<{ id: string; title: string }>;
};

export type HarnessProfileInspection = {
  profileId: string;
  extends: string[];
  capabilities: HarnessInspectionCapability[];
  tools: string[];
  admission: HarnessAdmissionPolicy;
  evidenceStages?: HarnessEvidenceStage[];
};

export type HostProductionGate = {
  id: string;
  title: string;
  layer: HostProductionGateLayer;
  role: HostProductionGateRole;
  toggleable: false;
  failClosedWhenMissing: boolean;
  description: string;
};

export type HarnessCapabilityCatalog = {
  profiles: HarnessProfileInspection[];
  hostGates: HostProductionGate[];
};

/**
 * Host-owned production adapters. They are visible in configuration so operators
 * can see the fail-closed surface, but they are not Capability Profiles and
 * cannot be unloaded from this catalogue.
 */
export const HOST_PRODUCTION_GATES: HostProductionGate[] = [
  {
    id: "anti-leakage-v2",
    title: "反泄漏报告",
    layer: "backtest",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description:
      "lookahead、幸存者偏差、财报修订、参数泄漏与交易成本血缘。缺证据只能标 research_only。",
  },
  {
    id: "statistical-validation-v3",
    title: "统计验证",
    layer: "backtest",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description:
      "训练窗 FDR、White Reality Check、OOS block-bootstrap 与 Deflated Sharpe。未通过不得晋级。",
  },
  {
    id: "asset-lifecycle-v2",
    title: "资产生命周期",
    layer: "backtest",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "合约乘数、期权/期货结算、换月、停牌与涨跌停。字段缺失保持 research_only。",
  },
  {
    id: "exchange-calendar-release",
    title: "交易所日历 release",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "实盘必须绑定官方或持牌日历。缺失、闭市或窗口外停止下单，不回退工作日推断。",
  },
  {
    id: "live-account-risk",
    title: "账户风险快照",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "派发前读取券商可用现金与持仓市值。缺 mark 或超限立即拒绝，不用成本价替代。",
  },
  {
    id: "live-pre-trade-rules",
    title: "项目级盘前规则",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "真钱 intent 不能继承演示默认放行。零条 pre_trade 规则时 live 直接拒绝。",
  },
  {
    id: "live-runtime-guardrails",
    title: "limited_live envelope",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "运行时必须写入允许标的、单笔/单日名义金额、日订单数、日亏损上限和强制人工确认。",
  },
  {
    id: "trading-module-control",
    title: "交易模块暂停",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "global / 账户 / 策略三级持久化暂停。环境关闭优先，重启不会意外恢复交易。",
  },
  {
    id: "final-holdout",
    title: "最终独立 Holdout",
    layer: "live",
    role: "gate",
    toggleable: false,
    failClosedWhenMissing: true,
    description: "同一 source backtest 只能看一次保留集。live promotion 必须绑定通过记录。",
  },
  {
    id: "tca-execution-quality",
    title: "执行质量 TCA",
    layer: "execution",
    role: "observation",
    toggleable: false,
    failClosedWhenMissing: false,
    description: "成交率、实现短缺、延迟、拒单与费用写入评估证据。当前观察用，不悄然改晋级阈值。",
  },
];

function admissionFor(profileId: string): HarnessAdmissionPolicy {
  if (profileId === MATH_AUDIT_PROFILE_ID) {
    return {
      kind: "workflow_lease",
      defaultMode: "off",
      configKey: "harness.mathAudit",
      summary:
        "普通对话保持关闭。已登记的高保证研究场景与 backtest 默认 required；可用 loop_options 显式开关。",
      scenarios: [...MATH_AUDIT_REQUIRED_SCENARIOS]
        .sort()
        .map((id) => ({ id, mode: "required" as const })),
      workflowModes: [{ id: "backtest", mode: "required" }],
      unloadNote: "显式 off 会撤销本工作流的数学工具租约；终态工作流自动 dispose。",
    };
  }
  if (profileId === QUANT_RESEARCH_INTEGRITY_PROFILE_ID) {
    return {
      kind: "workflow_lease",
      defaultMode: "off",
      configKey: "harness.researchIntegrity",
      summary:
        "研究场景只出 advisory 缺口报告；backtest / simulation / live 默认 required。关闭报告不会放宽宿主晋级闸门。",
      scenarios: [...RESEARCH_INTEGRITY_SCENARIOS]
        .sort()
        .map((id) => ({ id, mode: "advisory" as const })),
      workflowModes: [
        { id: "backtest", mode: "required" },
        { id: "simulation", mode: "required" },
        { id: "live", mode: "required" },
      ],
      unloadNote: "卸载只隐藏审计投影。paper/live 准入仍由宿主服务 fail-closed 执行。",
    };
  }
  return {
    kind: "global_toggle",
    defaultMode: "off",
    summary: "由配置页启用后进入影子工具面；真正进入执行工具面还需灰度白名单。",
    scenarios: [],
    workflowModes: [],
    unloadNote: "关闭后不再出现在全局影子组合；不影响宿主侧执行闸门。",
  };
}

export function inspectHarnessProfile(
  registry: CapabilityRegistry,
  profileId: string
): HarnessProfileInspection {
  const profile = registry.getProfile(profileId);
  if (!profile) {
    throw new Error(`Unknown capability profile: ${profileId}`);
  }
  const composition = registry.resolve(profileId);
  return {
    profileId,
    extends: [...(profile.extends ?? [])],
    capabilities: composition.capabilities.map((capability) => ({
      id: capability.manifest.id,
      title: capability.manifest.title,
      kind: capability.manifest.kind,
      description: capability.manifest.description,
      tools: (capability.manifest.tools ?? []).map((tool) => tool.name),
    })),
    tools: composition.tools.map((tool) => tool.name),
    admission: admissionFor(profileId),
    evidenceStages:
      profile.enable.includes(QUANT_RESEARCH_INTEGRITY_CAPABILITY_ID) ||
      profileId === QUANT_RESEARCH_INTEGRITY_PROFILE_ID
        ? listQuantResearchIntegrityStages()
        : undefined,
  };
}

export function buildHarnessCapabilityCatalog(
  registry: CapabilityRegistry = createBuiltinFinancialHarnessRegistry()
): HarnessCapabilityCatalog {
  return {
    profiles: registry.listProfiles().map((profile) => inspectHarnessProfile(registry, profile.id)),
    hostGates: HOST_PRODUCTION_GATES,
  };
}
