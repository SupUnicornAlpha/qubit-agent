/**
 * Provider bootstrap：进程启动时调用一次
 *
 * 1. 注册所有内置 Provider 到 ProviderRegistry（内存）
 * 2. 同步到 DB `provider_registry`（upsert + 保留已有 status/priority）
 * 3. 从 DB 反向回读 status/priority，让运营在 UI 改过的设置生效
 *
 * 这样保证：
 * - 新增的内置 Provider 第一次启动会被 upsert 进 DB；
 * - 用户在配置中心改的 status/priority 不会被启动时覆盖。
 */

import { providerRegistry } from "./registry";
import { PythonInlineFactorProvider } from "./impls/factor/python-inline-factor-provider";
import { QlibExprFactorProvider } from "./impls/factor/qlib-expr-factor-provider";
import { QlibPythonFactorProvider } from "./impls/factor/qlib-python-factor-provider";
import { BuiltinFactorEvalProvider } from "./impls/factor/builtin-factor-eval-provider";
import { JsonLogicRuleProvider } from "./impls/rule/jsonlogic-rule-provider";
import { SmaLegacyBacktestProvider } from "./impls/backtest/sma-legacy-backtest-provider";
import { EventDrivenBacktestProvider } from "./impls/backtest/event-driven-backtest-provider";

let bootstrapPromise: Promise<void> | null = null;

/**
 * 注册所有内置 Provider 并同步 DB。幂等，多次调用只会执行一次。
 *
 * 启动顺序约束：必须在 runMigrations() 之后调用。
 */
export function bootstrapProviders(): Promise<void> {
  bootstrapPromise ??= (async () => {
    // 1. 注册内置实现到内存 registry
    providerRegistry.register(new PythonInlineFactorProvider());
    providerRegistry.register(new QlibExprFactorProvider());
    providerRegistry.register(new QlibPythonFactorProvider());
    providerRegistry.register(new BuiltinFactorEvalProvider());
    providerRegistry.register(new JsonLogicRuleProvider());
    providerRegistry.register(new SmaLegacyBacktestProvider());
    providerRegistry.register(new EventDrivenBacktestProvider());

    // 2. 同步 DB
    await providerRegistry.syncToDb();

    // 3. 反向回读 DB 上的 status/priority（用户在 UI 改过的）
    await providerRegistry.reload();

    console.log("[Provider] bootstrap done: 7 builtin providers registered");
  })();
  return bootstrapPromise;
}

/** 测试用：重置 bootstrap 状态 */
export function _resetBootstrapForTests(): void {
  bootstrapPromise = null;
  providerRegistry._resetForTests();
}
