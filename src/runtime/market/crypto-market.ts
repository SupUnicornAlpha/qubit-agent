/** 加密货币市场识别与符号规范化（Binance / CCXT 风格） */

const CRYPTO_EXCHANGES = new Set(["CRYPTO", "CC", "BINANCE", "BINANCEUS", "OKX", "BYBIT"]);

export function isCryptoMarket(symbol: string, exchange?: string): boolean {
  const ex = (exchange ?? "").trim().toUpperCase();
  if (CRYPTO_EXCHANGES.has(ex)) return true;
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (s.includes("/")) return true;
  if (/^[A-Z0-9]{2,15}(USDT|USD|BUSD|USDC|BTC|ETH)$/i.test(s)) return true;
  if (s.endsWith("-USD") && s.length <= 12) return true;
  return false;
}

/**
 * 转为 Binance REST 交易对，默认 USDT 计价（如 BTCUSDT）。
 * @param quote USDT | BUSD | USD
 */
export function symbolToBinancePair(symbol: string, exchange?: string, quote = "USDT"): string {
  let s = symbol.trim().toUpperCase().replace(/\s/g, "");
  const ex = (exchange ?? "").trim().toUpperCase();
  if (!s) return `BTC${quote}`;

  if (s.includes("/")) {
    const [base, q] = s.split("/");
    const qUp = (q || quote).toUpperCase();
    if (qUp === "USD") return `${base}USDT`;
    return `${base}${qUp}`;
  }
  if (s.includes("-")) {
    const [base, q] = s.split("-");
    const qUp = (q ?? quote).toUpperCase();
    if (qUp === "USD" || qUp === "USDT") return `${base}USDT`;
    return `${base}${qUp}`;
  }

  const q = quote.toUpperCase();
  for (const suffix of ["USDT", "BUSD", "USDC", "USD", "BTC", "ETH"]) {
    if (s.endsWith(suffix) && s.length > suffix.length) return s;
  }

  if (ex === "CRYPTO" || ex === "BINANCE" || isCryptoMarket(s, ex)) {
    return `${s.replace(/-USD$/i, "")}${q}`;
  }
  return s;
}

/** CCXT 展示用 BASE/QUOTE */
export function symbolToCcxtPair(symbol: string, exchange?: string): string {
  const pair = symbolToBinancePair(symbol, exchange, "USDT");
  if (pair.endsWith("USDT")) return `${pair.slice(0, -4)}/USDT`;
  if (pair.endsWith("BUSD")) return `${pair.slice(0, -4)}/BUSD`;
  return pair;
}
