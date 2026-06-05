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

/**
 * 拆分用户输入的多标的字符串。
 *
 * 分隔符白名单：英文逗号 `,` / 中文逗号 `，` / 分号 `;` / 中文顿号 `、` /
 * 中文分号 `；` / 斜杠 `/` / 反斜杠 `\` / 竖线 `|` / 空格 / 制表符 / 换行。
 *
 * 历史 bug：前端把"NVDA、AMD"（中文顿号）作为单个 string 传进 scope.symbols
 * 数组（即 `scope.symbols = ["NVDA、AMD"]`），由于 resolveResearchScope 对
 * `scope.symbols` 直接 trim().toUpperCase() 不再 parseSymbolList，
 * 下游 primarySymbol 就变成 "NVDA、AMD"，内置 SMA 兜底回测取数失败、
 * Risk 分析时 fetch_klines 也按 "NVDA、AMD" 走拿不到数据。
 * 解决方式：分隔符里加 `、`，且 resolveResearchScope 对 scope.symbols 元素
 * 再做一次 parseSymbolList 兜底拆分。
 */
export function parseSymbolList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，;；、\/\\|\s\n]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 24)
    ),
  ];
}

/**
 * 2026-06-05 监控复盘 #4：判断单个字符串是否"看起来像真实 ticker"。
 *
 * 背景：之前没有这层判断，导致：
 *   - 用户在 UI 输入「AI 半导体板块机会」当 ticker → orchestrator 把它当合法
 *     ticker 派给分析师 → fetch_klines 永远拿不到 → LLM 困在 no-data 死循环；
 *   - 测试 / LLM 自己经常构造 `ZZZ_NONEXISTENT_BAD` 之类的虚假 ticker → 一样的
 *     no-data 死循环；
 *   - 即使后端有 `scope.kind="explore"` 完整支持（必填 theme），入口层从不
 *     主动 promote 不合法 ticker 到 explore 模式。
 *
 * 这里只识别**表面格式**（cheap pre-check），真实存在性仍由下游 fetch_klines
 * 验证（fail-soft prompt 在 B 改动里加）。
 *
 * 识别 universe（覆盖 ≥ 95% 真实 case）：
 *   - US 股 / NASDAQ / NYSE：`^[A-Z][A-Z.\-]{0,9}$`（如 AAPL / BRK.B / BF-A）
 *   - A 股沪深：`^\d{6}$`（如 600519）
 *   - 港股：`^\d{4,5}\.HK$` 或 `^[A-Z]{1,6}\.HK$`（少数 H 股带字母）
 *   - 加密：`^[A-Z]{2,6}[-/](USDT?|BTC|ETH)$`（如 BTC-USD / ETH/USDT）
 *   - 期货：`^[A-Z]{1,4}\d{2,4}$`（如 ES2412 / CL2503，连续合约 ESH5 类不识别）
 *   - 期权 OPRA 21 字符（如 AAPL241220C00200000）：长度 + 形态判断
 *
 * 显式拒绝：含空格 / 中文 / 任何描述性字眼（"AI 半导体" / "机会" / 长 > 24）。
 */
/**
 * Placeholder 黑名单：与 act.ts `looksLikePlaceholderProjectId` 同源思路。
 * 这些字符串虽然表面格式合法（4-5 字母全大写匹配 US ticker 形态），但实际
 * 是 LLM / 用户填的占位符，要主动剔除避免下游 fetch_klines 拿空。
 */
const TICKER_PLACEHOLDER_DENYLIST = new Set([
  "TODO",
  "TBD",
  "FIXME",
  "NULL",
  "NONE",
  "TICKER",
  "SYMBOL",
  "TEST",
  "DEFAULT",
  "UNKNOWN",
  "XXXX",
  "XXXXX",
  "AAAA",
  "ZZZZ",
]);

export function looksLikeTicker(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (!s) return false;
  if (s.length > 24) return false;
  // 含空白 / 中文 / 标点（除常见 . - / 之外）→ 一定不是 ticker
  if (/\s/.test(s)) return false;
  if (/[\u4e00-\u9fa5]/.test(s)) return false;
  const upper = s.toUpperCase();
  if (TICKER_PLACEHOLDER_DENYLIST.has(upper)) return false;

  if (/^\d{6}$/.test(upper)) return true; // A 股
  if (/^(?:\d{4,5}|[A-Z]{1,6})\.HK$/.test(upper)) return true; // 港股
  if (/^[A-Z][A-Z.\-]{0,9}$/.test(upper)) return true; // US 含 BRK.B / BF-A
  if (/^[A-Z]{2,6}[-/](?:USDT?|BTC|ETH|EUR|GBP|JPY)$/.test(upper)) return true; // 加密
  if (/^[A-Z]{1,4}\d{2,4}$/.test(upper)) return true; // 期货数字合约
  if (upper.length === 21 && /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(upper)) return true; // OPRA 期权

  return false;
}

/**
 * 给定原始入参，决定**最终应该走的 scope.kind 与 theme**：
 *   - 用户已显式传 `scope.kind="explore"` → 透传
 *   - 用户传 ticker 且看起来像真 ticker → 沿用原 ticker（不动 scope）
 *   - 用户传 ticker 但**不像 ticker**（典型："AI半导体板块机会" / "ZZZ_BAD"）
 *     → auto-promote 为 explore，把原文当 theme
 *   - 没传 ticker 也没 scope → caller 自己 reject（保留现有 400 行为）
 *
 * 返回 `{shouldPromoteToExplore: boolean, theme?: string, reason?: string}`，
 * caller 拿去重组入参并保留 audit log。
 */
export function classifyResearchInput(input: {
  ticker?: string | null;
  scope?: ResearchScopeInput | null;
}): {
  shouldPromoteToExplore: boolean;
  theme?: string;
  reason?: string;
} {
  const userKind = input.scope?.kind;
  if (userKind === "explore") return { shouldPromoteToExplore: false };

  // 用户在 scope.symbols 里给了任一合法 ticker → 信任 user，不 promote
  const scopeSymbols = (input.scope?.symbols ?? [])
    .map((s) => (typeof s === "string" ? s : ""))
    .filter((s) => s.length > 0);
  if (scopeSymbols.some(looksLikeTicker)) {
    return { shouldPromoteToExplore: false };
  }

  const ticker = (input.ticker ?? input.scope?.ticker ?? "").trim();
  if (!ticker) return { shouldPromoteToExplore: false };

  if (looksLikeTicker(ticker)) return { shouldPromoteToExplore: false };

  return {
    shouldPromoteToExplore: true,
    theme: ticker,
    reason: `ticker "${ticker.slice(0, 60)}" 不符合任何已知 ticker 表面格式 (US/CN-A/HK/crypto/futures/OPRA)，按"探索主题"处理`,
  };
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
    /**
     * 前端有可能把"NVDA、AMD"或"NVDA, AMD"塞进 symbols 数组的单元素
     * （例如板块快捷选项里"成分股"输入框被当作整段字符串提交）。
     * 这里对每个元素再走一遍 parseSymbolList，确保拿到的是真正的 ticker 列表。
     */
    symbols = [...new Set(scope.symbols.flatMap((s) => parseSymbolList(String(s ?? ""))))];
  } else if (scope?.ticker?.trim()) {
    symbols = parseSymbolList(scope.ticker);
  } else if (input.ticker?.trim()) {
    symbols = parseSymbolList(input.ticker);
  }

  if (kind === "sector") {
    sector = (scope?.sector ?? "").trim() || undefined;
    const peers = [
      ...new Set((scope?.peers ?? []).flatMap((s) => parseSymbolList(String(s ?? "")))),
    ];
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
