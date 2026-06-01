/**
 * EnvironmentManager 共享类型 — 期望清单 / 已装快照 / diff。
 *
 * 详见 docs/ENVIRONMENT_MANAGER_DESIGN.md §6.0–§6.5。
 */

export type EnvKind = "python" | "npm";
export type EnvStatus = "enabled" | "disabled";
export type EnvSource = "requirements" | "connector-meta" | "seed-mcp" | "user";

/**
 * 期望清单中的一项（来自 env_registry 表）。
 * effectiveVersionSpec 由 service 层计算：`userVersionSpec ?? versionSpec`。
 */
export interface ExpectedPackage {
  id: string;
  kind: EnvKind;
  name: string;
  displayName: string;
  description: string;
  versionSpec: string | null;
  userVersionSpec: string | null;
  effectiveVersionSpec: string | null;
  optional: boolean;
  capability: string;
  source: EnvSource;
  status: EnvStatus;
  isBuiltin: boolean;
  /** 透传字段，例如 npm 包的 npxArgs 默认值 */
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 磁盘扫描得到的实际已装包；name + version 是必填，其余可选。 */
export interface InstalledPackage {
  name: string;
  version: string;
  /** site-packages / node_modules 下的绝对路径（debug 用） */
  installPath?: string;
}

/** Diff 结果：满足 / 缺失 / 版本不匹配 / 多装。 */
export interface PackageDiff {
  expected: ExpectedPackage[];
  installed: InstalledPackage[];
  satisfied: ExpectedPackage[];
  missing: ExpectedPackage[];
  versionMismatch: Array<{ expected: ExpectedPackage; installed: InstalledPackage }>;
  /** 已装但不在期望清单的"孤儿包"（仅 warn，不 surface 为 error） */
  orphan: InstalledPackage[];
}

/**
 * Seed 期望项 — `seed-env-registry.ts` 把代码里的常量元信息合并到 DB。
 * 与 ExpectedPackage 区别：seed 不带 id / userVersionSpec / status 等
 * 由 DB 维护的字段。
 */
export interface SeedExpectedPackage {
  kind: EnvKind;
  name: string;
  displayName: string;
  description: string;
  versionSpec?: string;
  optional: boolean;
  capability: string;
  source: EnvSource;
  /** 透传 npm 推荐项的 `npx -y pkg@ver args...` 等 */
  extra?: Record<string, unknown>;
}
