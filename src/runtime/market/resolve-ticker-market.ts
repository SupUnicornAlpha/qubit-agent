/**
 * 统一的 ticker → market 推断（deterministic）。
 *
 * 评估报告 P0 — 在此之前仓库**没有**任何 ticker → market 的统一解析器，
 * 分散在 `isChinaAShareMarket` / `isCryptoMarket` / `symbolToYahooSymbol`
 * 三处 regex，且 `symbolToEastMoneySecId` 在 exchange 为空时一律给沪市
 * secid，导致 `000001`（平安银行 / 应为深市 0.000001）被错路由到上证综指
 * (`1.000001`)。
 *
 * 本模块给所有下游一个唯一的事实源：
 *   `resolveTickerMarket("000001")`
 *   → { market: "CN", exchange: "SZ", symbol: "000001",
 *       confidence: "inferred", reason: "CN A-share 6-digit code: leading 0 → Shenzhen" }
 *
 * 设计原则：
 *  - **纯函数 + 零网络**：用 regex / 后缀 / 数字段判断，无 DB 无 IO，方便单测/embed 进 hot path。
 *  - **优先级显式**：用户传入的 `hintExchange` > ticker 显式后缀 > 加密 regex > A 股数字段 > 短字母 ticker（US）> UNKNOWN。
 *  - **可信度 (confidence) 暴露**：调用方可据此决定是否额外向用户/LLM 澄清。
 *  - **A 股深沪精确按首位**：6XXXXX → SH，0/3XXXXX → SZ，4/8XXXXX → BJ。
 *
 * 非目标（不在 P0 内）：
 *  - 期权 OCC 21 位 symbol（如 `AAPL  240119C00185000`）—— 未来 P1 单独 resolver。
 *  - 期货 / 商品（USTBOND / GC=F 等）—— 未来按 Yahoo 后缀扩展。
 *  - ISIN / CUSIP 编码 —— 通常由 broker / FIGI lookup 解决，不在 prompt 路径上。
 */

/** 已知的市场代号；未来可继续扩展（保持纯字符串 union 便于 LLM JSON 输出对齐） */
export type MarketCode =
  | "CN"
  | "HK"
  | "US"
  | "CRYPTO"
  | "JP"
  | "UK"
  | "DE"
  | "FR"
  | "CA"
  | "AU"
  | "KR"
  | "TW"
  | "SG"
  | "IN"
  | "UNKNOWN";

/**
 * `explicit` — 来自用户/上游传入的 hintExchange 或 ticker 的显式后缀；
 * `inferred` — 由 regex / 数字段推断；
 * `fallback` — 上面都没命中，给的兜底（UNKNOWN）。
 */
export type MarketConfidence = "explicit" | "inferred" | "fallback";

export interface MarketResolution {
  /** 高层市场分类（用于路由 connector / 监管口径） */
  market: MarketCode;
  /**
   * 数据源风格的 exchange code（"SH" / "SZ" / "BJ" / "HK" / "US" / "CRYPTO" / "TYO" / "LSE" / ...）。
   * 主要用作下游 `queryKlines / fetchBars` 等连接器入参；和 `MarketCode` 是 1:N 关系。
   */
  exchange: string;
  /** 归一化后的 ticker（大写、去空格、保留原后缀） */
  symbol: string;
  confidence: MarketConfidence;
  /** 给 LLM/日志/UI 看的归因字符串（≤ 80 字符） */
  reason: string;
}

export interface ResolveTickerMarketOptions {
  /** 用户/上游显式指定的交易所（最高优先级；若可识别则 confidence=explicit） */
  hintExchange?: string | undefined;
}

const CRYPTO_QUOTE_SUFFIXES = ["USDT", "BUSD", "USDC", "USD", "BTC", "ETH"] as const;
const CRYPTO_HINT_EXCHANGES = new Set([
  "CRYPTO",
  "CC",
  "BINANCE",
  "BINANCEUS",
  "OKX",
  "BYBIT",
]);

/** Yahoo 风格后缀 → (market, exchange) 映射；用于显式后缀路径 */
const YAHOO_SUFFIX_MAP: Record<string, { market: MarketCode; exchange: string }> = {
  SH: { market: "CN", exchange: "SH" },
  SS: { market: "CN", exchange: "SH" },
  SZ: { market: "CN", exchange: "SZ" },
  XSHE: { market: "CN", exchange: "SZ" },
  XSHG: { market: "CN", exchange: "SH" },
  BJ: { market: "CN", exchange: "BJ" },
  BSE: { market: "CN", exchange: "BJ" },
  HK: { market: "HK", exchange: "HK" },
  T: { market: "JP", exchange: "TYO" },
  TYO: { market: "JP", exchange: "TYO" },
  TSE: { market: "JP", exchange: "TYO" },
  L: { market: "UK", exchange: "LSE" },
  LSE: { market: "UK", exchange: "LSE" },
  DE: { market: "DE", exchange: "XETRA" },
  XETRA: { market: "DE", exchange: "XETRA" },
  PA: { market: "FR", exchange: "EPA" },
  EPA: { market: "FR", exchange: "EPA" },
  TO: { market: "CA", exchange: "TSX" },
  TSX: { market: "CA", exchange: "TSX" },
  AX: { market: "AU", exchange: "ASX" },
  ASX: { market: "AU", exchange: "ASX" },
  KS: { market: "KR", exchange: "KRX" },
  KQ: { market: "KR", exchange: "KOSDAQ" },
  TW: { market: "TW", exchange: "TWSE" },
  TWSE: { market: "TW", exchange: "TWSE" },
  SI: { market: "SG", exchange: "SGX" },
  SGX: { market: "SG", exchange: "SGX" },
  NS: { market: "IN", exchange: "NSE" },
  NSE: { market: "IN", exchange: "NSE" },
  AS: { market: "DE", exchange: "AMS" },
  SW: { market: "DE", exchange: "SIX" },
  MI: { market: "DE", exchange: "MIL" },
  MC: { market: "DE", exchange: "BME" },
};

/** hintExchange → (market, exchange)；只识别明确的；不识别就返回 null 让下游继续推断 */
function hintExchangeToMarket(rawHint: string): { market: MarketCode; exchange: string } | null {
  const hint = rawHint.trim().toUpperCase();
  if (!hint || hint === "UNKNOWN") return null;
  if (CRYPTO_HINT_EXCHANGES.has(hint)) return { market: "CRYPTO", exchange: "CRYPTO" };
  if (YAHOO_SUFFIX_MAP[hint]) return YAHOO_SUFFIX_MAP[hint];
  if (hint === "US" || hint === "NASDAQ" || hint === "NYSE" || hint === "AMEX" || hint === "OTC") {
    return { market: "US", exchange: "US" };
  }
  if (hint === "HK" || hint === "HKEX" || hint === "HKG") return { market: "HK", exchange: "HK" };
  if (hint === "CN" || hint === "A-SHARE" || hint === "ASHARE") {
    // 没说 SH/SZ/BJ 时，留 SH（最常见），但 confidence 仍是 explicit
    return { market: "CN", exchange: "SH" };
  }
  return null;
}

/**
 * 看 symbol 是否带可识别的显式后缀（如 `600519.SH` / `AAPL.US` / `0700.HK`）。
 * 返回 null 表示无显式后缀或后缀不在白名单。
 */
function tryExplicitSuffix(symbolUpper: string): { market: MarketCode; exchange: string } | null {
  if (!symbolUpper.includes(".")) return null;
  const dot = symbolUpper.lastIndexOf(".");
  const suffix = symbolUpper.slice(dot + 1);
  if (!suffix) return null;
  if (YAHOO_SUFFIX_MAP[suffix]) return YAHOO_SUFFIX_MAP[suffix];
  if (suffix === "US" || suffix === "NASDAQ" || suffix === "NYSE") {
    return { market: "US", exchange: "US" };
  }
  return null;
}

/** 加密 regex；与 `crypto-market.ts:isCryptoMarket` 保持一致并稍微收紧（避免误伤短字母 US ticker） */
function looksLikeCrypto(symbolUpper: string): boolean {
  if (!symbolUpper) return false;
  if (symbolUpper.includes("/")) return true;
  if (/^[A-Z0-9]{2,15}(USDT|BUSD|USDC|USD)$/.test(symbolUpper) && symbolUpper.length >= 5) {
    // BTCUSDT / ETHUSD / 但排除 `USDU` 等不像 quote 的；最短 5 字符（如 1USDT）
    return true;
  }
  if (/^[A-Z0-9]{2,12}(BTC|ETH)$/.test(symbolUpper) && symbolUpper.length >= 5) {
    return true;
  }
  if (/^[A-Z0-9]{2,12}-(USD|USDT|USDC|BUSD)$/.test(symbolUpper)) return true;
  return false;
}

/**
 * A 股 6 位代码 → 沪/深/北分流。**这是修复 000001 错路 bug 的核心**：
 *  - 6XXXXX  → SH（上交所主板/科创板 60/688/689）
 *  - 0XXXXX  → SZ（深交所主板 0000-0029）
 *  - 3XXXXX  → SZ（创业板 30）
 *  - 8XXXXX  → BJ（北交所 8）
 *  - 4XXXXX  → BJ（新三板精选层 → 北交所 4）
 *  - 5/1/9 头通常是 ETF/封基/A 股转债：先归 SH（最常见，9XXXXX = B 股沪市；5XXXXX = SH ETF）。
 */
function inferCnExchangeFromSixDigit(digits: string): "SH" | "SZ" | "BJ" {
  const head = digits[0];
  if (head === "6") return "SH";
  if (head === "0" || head === "3") return "SZ";
  if (head === "8" || head === "4") return "BJ";
  // 5/1/9/2/7 ETF / 封基 / B 股：默认沪市
  return "SH";
}

/** 短字母 ticker（≤5 字符纯字母）→ 默认 US */
function looksLikeShortUsTicker(symbolUpper: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbolUpper);
}

/**
 * 唯一对外入口：把任意 ticker 归一化到 (market, exchange, confidence, reason)。
 *
 * @example
 * ```ts
 * resolveTickerMarket("AAPL");            // US / US / inferred (short alpha)
 * resolveTickerMarket("600519");          // CN / SH / inferred (6-digit, head 6)
 * resolveTickerMarket("000001");          // CN / SZ / inferred (6-digit, head 0) ← 修复点
 * resolveTickerMarket("000001.SH");       // CN / SH / explicit (suffix override)
 * resolveTickerMarket("00700.HK");        // HK / HK / explicit
 * resolveTickerMarket("BTCUSDT");         // CRYPTO / CRYPTO / inferred
 * resolveTickerMarket("AAPL", { hintExchange: "NASDAQ" }); // US / US / explicit
 * resolveTickerMarket("XYZ123456");       // UNKNOWN / UNKNOWN / fallback
 * ```
 */
export function resolveTickerMarket(
  rawTicker: string,
  options: ResolveTickerMarketOptions = {}
): MarketResolution {
  const symbol = (rawTicker ?? "").trim().toUpperCase();
  if (!symbol) {
    return {
      market: "UNKNOWN",
      exchange: "UNKNOWN",
      symbol: "",
      confidence: "fallback",
      reason: "empty ticker",
    };
  }

  // 1) 显式后缀（最强信号；优先于 hint，因为后缀就是用户/上游写在 ticker 里的"显式声明"）
  const fromSuffix = tryExplicitSuffix(symbol);
  if (fromSuffix) {
    return {
      ...fromSuffix,
      symbol,
      confidence: "explicit",
      reason: `explicit suffix .${symbol.slice(symbol.lastIndexOf(".") + 1)}`,
    };
  }

  // 2) hintExchange 显式
  const hint = options.hintExchange?.trim();
  if (hint) {
    const fromHint = hintExchangeToMarket(hint);
    if (fromHint) {
      return {
        ...fromHint,
        symbol,
        confidence: "explicit",
        reason: `hintExchange=${hint.toUpperCase()}`,
      };
    }
  }

  // 3) 加密
  if (looksLikeCrypto(symbol)) {
    return {
      market: "CRYPTO",
      exchange: "CRYPTO",
      symbol,
      confidence: "inferred",
      reason: "crypto pair pattern (USDT/BUSD/USDC/USD/BTC/ETH suffix or slash)",
    };
  }

  // 4) A 股 6 位代码
  const digitsOnly = symbol.replace(/\D/g, "");
  if (/^\d{6}$/.test(symbol)) {
    const ex = inferCnExchangeFromSixDigit(digitsOnly);
    const exDesc = ex === "SH" ? "Shanghai" : ex === "SZ" ? "Shenzhen" : "Beijing";
    return {
      market: "CN",
      exchange: ex,
      symbol,
      confidence: "inferred",
      reason: `CN A-share 6-digit code: leading ${digitsOnly[0]} → ${exDesc}`,
    };
  }

  // 5) 港股 4-5 位数字（没带 .HK 后缀的常见简写如 "0700" / "700"）
  if (/^\d{1,5}$/.test(symbol) && symbol.length <= 5) {
    return {
      market: "HK",
      exchange: "HK",
      symbol: symbol.padStart(5, "0"),
      confidence: "inferred",
      reason: `HK short numeric code (length ${symbol.length})`,
    };
  }

  // 6) 短字母 ticker → US
  if (looksLikeShortUsTicker(symbol)) {
    return {
      market: "US",
      exchange: "US",
      symbol,
      confidence: "inferred",
      reason: "short alphabetic ticker (≤5) → US default",
    };
  }

  // 7) 兜底 UNKNOWN（不强行 fallback 到 US，让上层显式决定）
  return {
    market: "UNKNOWN",
    exchange: "UNKNOWN",
    symbol,
    confidence: "fallback",
    reason: "no rule matched; caller should ask user to clarify market",
  };
}

/**
 * 便捷：把 resolution 渲染成一行人类可读字符串（给 prompt / 日志用）。
 *
 * @example
 * `[market=CN/SZ confidence=inferred reason="CN A-share 6-digit code: leading 0 → Shenzhen"]`
 */
export function formatMarketResolution(r: MarketResolution): string {
  return `[market=${r.market}/${r.exchange} confidence=${r.confidence} reason="${r.reason}"]`;
}
