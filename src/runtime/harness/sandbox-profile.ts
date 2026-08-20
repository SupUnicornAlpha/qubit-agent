import type { CapabilityManifest, SandboxApprovalKind } from "./types";

export type HarnessSandboxRuntime = "host" | "container";
export type HarnessSandboxFilesystem = "read-only" | "workspace-write";
export type HarnessSandboxNetwork = "none" | "allowlist";
export type HarnessSandboxProcess = "none" | "allowlist";
export type HarnessSandboxApprovalMode = "never" | "on-request";

/**
 * This is a policy contract, not a promise that a host process is isolated.
 * The execution adapter must prove it can honour `runtime: container`; it may
 * not silently fall back to the host.
 */
export type HarnessSandboxProfile = {
  id: string;
  title: string;
  description: string;
  runtime: HarnessSandboxRuntime;
  filesystem: HarnessSandboxFilesystem;
  network: HarnessSandboxNetwork;
  allowedHosts: readonly string[];
  process: HarnessSandboxProcess;
  allowedCommands: readonly string[];
  approvalMode: HarnessSandboxApprovalMode;
  limits: {
    maxWallClockMs: number;
    memoryMiB: number;
    cpuCount: number;
    pidsLimit: number;
    maxOutputBytes: number;
  };
};

export type SandboxAdmission =
  | { allowed: true; requiredApprovals: SandboxApprovalKind[] }
  | { allowed: false; reasons: string[] };

export const builtinHarnessSandboxProfiles: readonly HarnessSandboxProfile[] = [
  {
    id: "read-only",
    title: "只读工作区",
    description: "适用于研究、数据查询和只读文档能力。",
    runtime: "host",
    filesystem: "read-only",
    network: "none",
    allowedHosts: [],
    process: "none",
    allowedCommands: [],
    approvalMode: "never",
    limits: {
      maxWallClockMs: 30_000,
      memoryMiB: 512,
      cpuCount: 1,
      pidsLimit: 32,
      maxOutputBytes: 64_000,
    },
  },
  {
    id: "workspace-write",
    title: "工作区写入",
    description: "只允许当前工作区内生成 Artifact，不允许网络或子进程。",
    runtime: "host",
    filesystem: "workspace-write",
    network: "none",
    allowedHosts: [],
    process: "none",
    allowedCommands: [],
    approvalMode: "on-request",
    limits: {
      maxWallClockMs: 60_000,
      memoryMiB: 1_024,
      cpuCount: 1,
      pidsLimit: 32,
      maxOutputBytes: 128_000,
    },
  },
  {
    id: "guarded-container",
    title: "受控容器",
    description: "容器工作区、网络域名白名单和命令白名单；用于代码、浏览器和文档转换。",
    runtime: "container",
    filesystem: "workspace-write",
    network: "allowlist",
    allowedHosts: [],
    process: "allowlist",
    allowedCommands: [],
    approvalMode: "on-request",
    limits: {
      maxWallClockMs: 300_000,
      memoryMiB: 2_048,
      cpuCount: 2,
      pidsLimit: 96,
      maxOutputBytes: 256_000,
    },
  },
  {
    id: "broker-execution",
    title: "券商受控执行",
    description: "仅允许通过已授权券商工具执行；禁止任意 shell，真实下单必须经 Core HITL。",
    runtime: "host",
    filesystem: "workspace-write",
    network: "allowlist",
    allowedHosts: [],
    process: "none",
    allowedCommands: [],
    approvalMode: "on-request",
    limits: {
      maxWallClockMs: 45_000,
      memoryMiB: 1_024,
      cpuCount: 1,
      pidsLimit: 32,
      maxOutputBytes: 128_000,
    },
  },
];

export function getBuiltinHarnessSandboxProfile(id: string): HarnessSandboxProfile | null {
  return builtinHarnessSandboxProfiles.find((profile) => profile.id === id) ?? null;
}

/** Pure admission: the host adapter enforces the returned decision at runtime. */
export function evaluateCapabilitySandbox(
  manifest: CapabilityManifest,
  profile: HarnessSandboxProfile
): SandboxAdmission {
  const required = manifest.sandbox;
  if (!required) return { allowed: true, requiredApprovals: [] };
  const reasons: string[] = [];
  if (required.filesystem === "workspace-write" && profile.filesystem !== "workspace-write") {
    reasons.push("requires workspace-write filesystem access");
  }
  if (required.network === "allowlist" && profile.network !== "allowlist") {
    reasons.push("requires allowlisted network access");
  }
  if (required.process === "allowlist" && profile.process !== "allowlist") {
    reasons.push("requires allowlisted process execution");
  }
  if (required.requireContainer && profile.runtime !== "container") {
    reasons.push("requires guarded container execution");
  }
  const requiredApprovals = [...new Set(required.approvals ?? [])];
  if (requiredApprovals.length > 0 && profile.approvalMode !== "on-request") {
    reasons.push("requires interactive approval, but the sandbox profile does not permit it");
  }
  return reasons.length > 0 ? { allowed: false, reasons } : { allowed: true, requiredApprovals };
}
