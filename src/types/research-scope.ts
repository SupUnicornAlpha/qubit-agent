/**
 * 研究团队分析范围：单标的、多标的篮子、板块，以及现货多/空、期权等工具类型。
 */

export type ResearchPositionSide = "long" | "short";
export type ResearchInstrumentKind = "equity" | "option";

export type ResearchScopeInput = {
  /**
   * - "single"   单标的
   * - "basket"   多标的篮子
   * - "sector"   板块（含可选成分股）
   * - "explore"  无标的自由探索：交给 Orchestrator 自主选标的 / 选板块 / 选主题。
   *              **必须提供 `theme`**（用户给的主题描述），不强制 symbols。
   */
  kind?: "single" | "basket" | "sector" | "explore";
  /** 单标的或篮子逗号分隔（与 ticker 二选一） */
  symbols?: string[];
  ticker?: string;
  sector?: string;
  /** 板块成分股 / 对比标的 */
  peers?: string[];
  /** explore 模式专用：用户给的研究主题（"AI 半导体的轮动" / "美联储会议前的避险" 等） */
  theme?: string;
  instrument?: ResearchInstrumentKind;
  positionSide?: ResearchPositionSide;
  exchange?: string;
  option?: {
    underlying?: string;
    contractSymbol?: string;
    expiry?: string;
    strike?: number;
    right?: "call" | "put";
  };
};

export type NormalizedResearchScope = {
  kind: "single" | "basket" | "sector" | "explore";
  symbols: string[];
  primarySymbol: string;
  displayLabel: string;
  sector?: string;
  theme?: string;
  instrument: ResearchInstrumentKind;
  positionSide: ResearchPositionSide;
  exchange?: string;
  option?: ResearchScopeInput["option"];
};

const MAX_BASKET_SYMBOLS = 8;

export function parseSymbolList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，;\s\n]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 24)
    ),
  ];
}

export function resolveResearchScope(input: {
  ticker?: string;
  scope?: ResearchScopeInput | null;
}): NormalizedResearchScope {
  const scope = input.scope;
  const instrument: ResearchInstrumentKind =
    scope?.instrument === "option" ? "option" : "equity";
  const positionSide: ResearchPositionSide =
    scope?.positionSide === "short" ? "short" : "long";
  const exchange = scope?.exchange?.trim() || undefined;

  let kind: NormalizedResearchScope["kind"] = scope?.kind ?? "single";
  let symbols: string[] = [];
  let sector: string | undefined;
  const theme = scope?.theme?.trim() || undefined;

  if (scope?.symbols && scope.symbols.length > 0) {
    symbols = scope.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (scope?.ticker?.trim()) {
    symbols = parseSymbolList(scope.ticker);
  } else if (input.ticker?.trim()) {
    symbols = parseSymbolList(input.ticker);
  }

  if (kind === "sector") {
    sector = (scope?.sector ?? "").trim() || undefined;
    const peers = (scope?.peers ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (peers.length > 0) {
      symbols = [...new Set([...symbols, ...peers])];
    }
    if (symbols.length === 0 && sector) {
      symbols = [];
    }
  }

  if (kind === "basket" && symbols.length <= 1 && scope?.sector) {
    kind = "sector";
    sector = scope.sector.trim();
  }

  /**
   * explore 模式：保留 kind，不强制 symbols。symbols 可空（让 orchestrator 自己选），
   * primarySymbol 也保持空字符串 —— 用 "AUTO_EXPLORE" 哨兵字符串会污染下游：
   *   1. 行情快照工具拿 "AUTO_EXPLORE" 去 fetch_klines → 报红色错误 → 误导 LLM
   *   2. task 简报里 "分析标的 AUTO_EXPLORE" 让 agent 困惑
   *   3. orchestrator 在简报里复述 "未绑定固定标的；行情快照返回为空"
   *      把 LLM 引向"信息不足，不能做"的死循环
   * 现在改为：explore 模式所有下游函数自己检查 `symbols.length === 0` /
   * `primarySymbol === ""`，并走"让 LLM 主动选标"的路径。
   */
  if (kind !== "explore") {
    if (symbols.length > 1) kind = "basket";
    else if (symbols.length === 1) kind = kind === "sector" && sector ? "sector" : "single";
  }

  if (kind === "basket" && symbols.length > MAX_BASKET_SYMBOLS) {
    symbols = symbols.slice(0, MAX_BASKET_SYMBOLS);
  }

  const option = scope?.option;
  if (instrument === "option") {
    const underlying = (option?.underlying ?? symbols[0] ?? input.ticker ?? "").trim().toUpperCase();
    if (underlying && !symbols.includes(underlying)) {
      symbols = [underlying, ...symbols];
    }
    if (option?.contractSymbol?.trim()) {
      const c = option.contractSymbol.trim().toUpperCase();
      if (!symbols.includes(c)) symbols = [c, ...symbols];
    }
  }

  /**
   * primarySymbol：
   *   - explore 模式且无 symbols → 空字符串（下游必须检查）
   *   - 其他模式 → 沿用第一个 symbol / ticker / "UNKNOWN" 兜底
   */
  const primarySymbol =
    symbols[0] ??
    (input.ticker?.trim().toUpperCase() ||
      (kind === "explore" ? "" : "UNKNOWN"));

  const displayLabel = buildDisplayLabel({
    kind,
    symbols,
    instrument,
    positionSide,
    primarySymbol,
    ...(sector !== undefined ? { sector } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(option !== undefined ? { option } : {}),
  });

  /**
   * symbols 输出策略：
   *   - explore 模式 → 保持原数组（可为空），不再用 primarySymbol 强行兜底
   *     —— 之前 fallback 成 ["AUTO_EXPLORE"] 是所有问题的根源
   *   - 其他模式 → 沿用 fallback 行为，保证至少有 1 个元素（避免下游误判）
   */
  const finalSymbols =
    kind === "explore"
      ? symbols
      : symbols.length > 0
        ? symbols
        : primarySymbol
          ? [primarySymbol]
          : [];

  return {
    kind,
    symbols: finalSymbols,
    primarySymbol,
    displayLabel,
    instrument,
    positionSide,
    ...(sector !== undefined ? { sector } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(option !== undefined ? { option } : {}),
  };
}

function buildDisplayLabel(p: {
  kind: NormalizedResearchScope["kind"];
  symbols: string[];
  sector?: string;
  theme?: string;
  instrument: ResearchInstrumentKind;
  positionSide: ResearchPositionSide;
  option?: ResearchScopeInput["option"];
  primarySymbol: string;
}): string {
  const side =
    p.positionSide === "short" ? "做空" : p.instrument === "option" ? "期权" : "多头";
  if (p.kind === "explore") {
    const theme = p.theme && p.theme.length > 0 ? p.theme : "自由探索";
    const hint = p.symbols.length > 0 ? `（候选 ${p.symbols.slice(0, 4).join(", ")}）` : "";
    return `探索·${theme}${hint}·${side}`;
  }
  if (p.kind === "sector" && p.sector) {
    const peers =
      p.symbols.length > 0 ? `（${p.symbols.slice(0, 6).join(", ")}${p.symbols.length > 6 ? "…" : ""}）` : "";
    return `板块·${p.sector}${peers}·${side}`;
  }
  if (p.symbols.length > 1) {
    return `篮子·${p.symbols.join("+")}·${side}`;
  }
  if (p.instrument === "option") {
    const u = p.option?.underlying ?? p.primarySymbol;
    const right = p.option?.right === "put" ? "Put" : p.option?.right === "call" ? "Call" : "";
    const strike = p.option?.strike != null ? `@${p.option.strike}` : "";
    const exp = p.option?.expiry ? ` ${p.option.expiry}` : "";
    const contract = p.option?.contractSymbol ? ` ${p.option.contractSymbol}` : "";
    return `期权·${u}${right}${strike}${exp}${contract}`.trim();
  }
  return `${p.primarySymbol}·${side}`;
}
