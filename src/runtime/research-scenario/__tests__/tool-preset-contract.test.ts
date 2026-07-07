/**
 * 契约测试：所有内置场景声明的 builtinTools 都必须在 builtin-tools.ts
 * 或 tool-routes.ts 真实注册。
 *
 * 背景：scenarios-seed.ts 历史上曾出现 factor.query / portfolio.optimize /
 * broker.placeOrder / queryBars / newsBrief / runStockScreener / runSmaBacktest /
 * queryAuditLog / queryFills 等"理想化"工具名，但 builtin-tools / tool-routes
 * 中并不存在。LLM 按 preset 调用时会被 parseToolCallFromReason 直接 reject，
 * 导致场景看起来"卡住、半成品输出"。
 *
 * 详见 docs/AGENT_STABILITY_REVIEW.md §三-根因5 / §六-行动建议1。
 */

import { describe, expect, test } from "bun:test";
import { isBuiltinTool } from "../../tools/builtin-tools";
import { resolveToolExecutionRoute } from "../../tools/tool-dispatch-resolver";
import { BUILTIN_RESEARCH_SCENARIOS } from "../scenarios-seed";

/** call_mcp / mcp:* 由 act 节点单独处理，不在 builtin/connector 注册表里 */
function isMcpAlias(name: string): boolean {
  return name === "call_mcp" || name.startsWith("mcp:");
}

function isToolImplemented(name: string): boolean {
  if (isMcpAlias(name)) return true;
  const route = resolveToolExecutionRoute(name);
  if (route.route === "builtin") return isBuiltinTool(route.effectiveName);
  if (route.route === "connector") return Boolean(route.connectorName);
  return false;
}

describe("内置场景 toolPreset 与真实工具白名单对齐（防脱钩）", () => {
  for (const scenario of BUILTIN_RESEARCH_SCENARIOS) {
    const tools = scenario.toolPreset?.builtinTools ?? [];
    if (tools.length === 0) continue;

    test(`scenario=${scenario.key} 的所有 builtinTools 已实装`, () => {
      const missing = tools.filter((t) => !isToolImplemented(t));
      if (missing.length > 0) {
        throw new Error(
          `场景 "${scenario.key}" 声明了未实装的工具：${missing.join(", ")}。` +
            ` 请检查 builtin-tools.ts / tool-routes.ts，或修正 scenarios-seed.ts。`
        );
      }
      expect(missing).toEqual([]);
    });
  }
});
