import type { NormalizedResearchScope } from "../../types/research-scope";

/** 写入分析师 context 的研究范围说明 */
export function formatResearchScopePreamble(scope: NormalizedResearchScope): string {
  const lines: string[] = ["## 研究范围（请务必遵守）"];

  if (scope.kind === "explore") {
    lines.push(`- **类型**：自由探索（无固定标的）`);
    lines.push(`- **研究主题**：${scope.theme || "（未明确，请按 Orchestrator 简报与已有数据自行收敛）"}`);
    if (scope.symbols.length > 0 && scope.symbols[0] !== "AUTO_EXPLORE") {
      lines.push(`- **候选标的**（用户提供的初步线索，可保留可剔除）：${scope.symbols.join(", ")}`);
    }
    lines.push(
      "- **本角色的探索约束**：",
      "  1. 在职责范围内自主提出 1-3 个备选标的或主题切片；",
      "  2. 用 `factor.list` / `skill.search` / `search_memory` 优先复用历史成功路径；",
      "  3. 任何虚构的 ticker 必须立即用 `fetch_klines` 验证是否真实存在，无法验证则放弃；",
      '  4. 最终交付物里必须明确列出"我选择了哪些标的 + 为何选" — 不能含糊带过。'
    );
  } else if (scope.kind === "sector" && scope.sector) {
    lines.push(`- **类型**：板块研究 — ${scope.sector}`);
    if (scope.symbols.length > 0) {
      lines.push(`- **成分/对比标的**：${scope.symbols.join(", ")}`);
    } else {
      lines.push("- **成分/对比标的**：未指定代码，请结合板块新闻与行业逻辑分析，并标注 [待核实]");
    }
  } else if (scope.symbols.length > 1) {
    lines.push(`- **类型**：多标的对比 / 篮子（${scope.symbols.length} 个）`);
    lines.push(`- **标的列表**：${scope.symbols.join(", ")}`);
    lines.push("- 请在 reasoning 中**逐标的**给出观点，或说明相对强弱排序");
  } else {
    lines.push(`- **类型**：单标的 — ${scope.primarySymbol}`);
  }

  if (scope.instrument === "option") {
    lines.push("- **工具**：上市期权");
    const o = scope.option;
    if (o?.underlying) lines.push(`  - 标的资产：${o.underlying}`);
    if (o?.contractSymbol) lines.push(`  - 合约代码：${o.contractSymbol}`);
    if (o?.expiry) lines.push(`  - 到期：${o.expiry}`);
    if (o?.strike != null) lines.push(`  - 行权价：${o.strike}`);
    if (o?.right) lines.push(`  - 方向：${o.right === "call" ? "认购 Call" : "认沽 Put"}`);
    lines.push(
      "- 关注：隐含波动率、时间价值衰减、Delta/Gamma 风险、流动性；缺数据则标 [待核实]"
    );
  } else if (scope.positionSide === "short") {
    lines.push(
      "- **工具**：股票做空 / 融券 / 可卖空标的",
      "- 从**空头建仓与平仓**视角分析：上行风险、借券成本、轧空、财报与催化剂"
    );
  } else {
    lines.push("- **工具**：股票多头现货");
  }

  if (scope.exchange) lines.push(`- **交易所/市场**：${scope.exchange}`);

  return lines.join("\n");
}

export function defaultResearchUserContext(scope: NormalizedResearchScope): string {
  if (scope.kind === "explore") {
    const themePart = scope.theme ? `「${scope.theme}」` : "用户未明确主题";
    const sidePart = scope.positionSide === "short" ? "（偏向空头机会）" : "（偏向多头机会）";
    const candidates =
      scope.symbols.length > 0 && scope.symbols[0] !== "AUTO_EXPLORE"
        ? `用户提供的候选线索：${scope.symbols.join(", ")}。`
        : "";
    return [
      `本次为自由探索任务：研究主题 ${themePart}${sidePart}。`,
      candidates,
      "请由 Orchestrator 先收敛到 1-3 个具体标的/板块，再分发给分析师；分析师在自己职责内输出观点。",
      "禁止凭空捏造 ticker；任何候选标的必须用真实工具验证存在与流动性。",
    ]
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (scope.kind === "sector" && scope.sector) {
    return `请对「${scope.sector}」板块及相关标的（${scope.symbols.join(", ") || "见数据快照"}）进行研究，给出综合配置观点与各标的相对判断。`;
  }
  if (scope.symbols.length > 1) {
    return `请对以下标的进行对比研究：${scope.symbols.join(", ")}。分别给出买卖观点与置信度，并说明标的间相对强弱。`;
  }
  const inst =
    scope.instrument === "option"
      ? "期权合约"
      : scope.positionSide === "short"
        ? "做空标的"
        : "标的";
  return `请对 ${scope.primarySymbol}（${inst}）进行全面分析。`;
}
