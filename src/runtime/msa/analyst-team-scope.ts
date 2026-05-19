import type { NormalizedResearchScope } from "../../types/research-scope";

/** 写入分析师 context 的研究范围说明 */
export function formatResearchScopePreamble(scope: NormalizedResearchScope): string {
  const lines: string[] = ["## 研究范围（请务必遵守）"];

  if (scope.kind === "sector" && scope.sector) {
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
