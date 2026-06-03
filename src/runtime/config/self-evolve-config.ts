/**
 * Self-Evolving Agent 总开关 + 各 worker 灰度模式（详见 docs §7.2 / §6.7）。
 *
 * 三层开关：
 *   1. SELF_EVOLVE_ENABLED        全局总闸（关 → 4 个 self-evolve worker / reason 注入 / AutoInstaller 全停）
 *   2. AUTO_INSTALL_MODE           AutoInstaller 行为：
 *        - off       : worker 不跑（连 propose 都不出）
 *        - propose   : 写 auto_install_proposal=pending_review，等人审批（P8 稳态，默认）
 *        - auto      : safetyLevel=low + 在 allowlist 内 + score ≥ MIN_SCORE_FOR_AUTO → 自动 approve + 真装（P9 实验）
 *   3. PNL_AWARE_REASON_ENABLED   reason 节点是否注入 top-N PnL skill（默认随总闸）
 *
 * 实现纪律（重要）：
 *   - 这些值是 **import-time singleton**；单测通过 `setSelfEvolveConfigForTest` monkey-patch
 *   - reader 而非 binder：4 个 worker 自己在 runOnce 入口 gate `if (!enabled) return early`，
 *     不要在 cron / 路由层做静默 short-circuit（保证可观测性 + 留 audit trail）
 *
 * 阈值：
 *   - MIN_SCORE_FOR_AUTO: 0.85（高于 P8 候选下限 0.3 很多，避免把"看起来像"的也装上）
 *   - REASON_PNL_TOP_N:   3
 *   - REASON_PNL_WINDOW_DAYS: 7
 */

export type AutoInstallMode = "off" | "propose" | "auto";

export interface SelfEvolveConfig {
  enabled: boolean;
  autoInstallMode: AutoInstallMode;
  pnlAwareReasonEnabled: boolean;
  /** auto 模式准入分数 */
  minScoreForAuto: number;
  reasonPnlTopN: number;
  reasonPnlWindowDays: number;
}

const DEFAULT_CONFIG: SelfEvolveConfig = {
  enabled: false,
  autoInstallMode: "propose",
  pnlAwareReasonEnabled: false,
  minScoreForAuto: 0.85,
  reasonPnlTopN: 3,
  reasonPnlWindowDays: 7,
};

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "off" || s === "no") return false;
  return def;
}

function parseMode(v: string | undefined, def: AutoInstallMode): AutoInstallMode {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (s === "off" || s === "propose" || s === "auto") return s;
  return def;
}

function parseNumber(v: string | undefined, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function loadFromEnv(): SelfEvolveConfig {
  const enabled = parseBool(process.env["SELF_EVOLVE_ENABLED"], DEFAULT_CONFIG.enabled);
  return {
    enabled,
    autoInstallMode: parseMode(
      process.env["AUTO_INSTALL_MODE"],
      DEFAULT_CONFIG.autoInstallMode
    ),
    // pnl-aware reason 默认随总闸（避免单独配置；想关给个 false 的 PNL_AWARE_REASON_ENABLED 即可）
    pnlAwareReasonEnabled: parseBool(
      process.env["PNL_AWARE_REASON_ENABLED"],
      enabled ? true : false
    ),
    minScoreForAuto: parseNumber(
      process.env["AUTO_INSTALL_MIN_SCORE"],
      DEFAULT_CONFIG.minScoreForAuto,
      0,
      1
    ),
    reasonPnlTopN: parseNumber(
      process.env["REASON_PNL_TOP_N"],
      DEFAULT_CONFIG.reasonPnlTopN,
      1,
      20
    ),
    reasonPnlWindowDays: parseNumber(
      process.env["REASON_PNL_WINDOW_DAYS"],
      DEFAULT_CONFIG.reasonPnlWindowDays,
      1,
      90
    ),
  };
}

let _cached: SelfEvolveConfig | null = null;

export function getSelfEvolveConfig(): SelfEvolveConfig {
  if (!_cached) _cached = loadFromEnv();
  return _cached;
}

/** 仅供测试用：替换全局 config。传 null 重置回 env 加载。 */
export function setSelfEvolveConfigForTest(override: Partial<SelfEvolveConfig> | null): void {
  if (override == null) {
    _cached = null;
    return;
  }
  _cached = { ...(getSelfEvolveConfig()), ...override };
}

/**
 * 便捷断言：4 个 self-evolve worker 入口都该用这个 gate。
 * 关时返回一个静态结论结构，让 worker 不写表 / 不 emit，但仍 return 正常 summary（无副作用）。
 */
export function selfEvolveDisabledReason(): string | null {
  const c = getSelfEvolveConfig();
  if (!c.enabled) return "SELF_EVOLVE_ENABLED=false";
  return null;
}
