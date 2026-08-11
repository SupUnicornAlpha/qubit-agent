/**
 * 交易工作面的进程级总开关。
 *
 * 这是对风控/券商 kill switch 的补充：关闭后连 paper intent 与策略运行时也不能
 * 新建，保证 UI 的“关闭模块”是一个真实的操作闸门，而非纯展示状态。
 * 环境变量 QUBIT_TRADING_MODULE_ENABLED=false 可在服务启动时保持关闭。
 */
function initialEnabled(): boolean {
  const raw = (process.env.QUBIT_TRADING_MODULE_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

let tradingModuleEnabled = initialEnabled();
let changedAt = new Date().toISOString();

export type TradingModuleStatus = {
  enabled: boolean;
  changedAt: string;
};

export function getTradingModuleStatus(): TradingModuleStatus {
  return { enabled: tradingModuleEnabled, changedAt };
}

export function setTradingModuleEnabled(enabled: boolean): TradingModuleStatus {
  tradingModuleEnabled = enabled;
  changedAt = new Date().toISOString();
  return getTradingModuleStatus();
}

export function assertTradingModuleEnabled(): void {
  if (!tradingModuleEnabled) throw new Error("trading_module_paused");
}

/** Test-only reset to avoid state leaking between cases. */
export function resetTradingModuleForTest(enabled = true): void {
  tradingModuleEnabled = enabled;
  changedAt = new Date().toISOString();
}
