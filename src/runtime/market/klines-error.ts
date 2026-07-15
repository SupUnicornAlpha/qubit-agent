import type { KlinesDataSourceMeta } from "./klines-data-source";

/** 对外暴露的 K 线错误类型（机器可读，供前端展示与 Agent 解析） */
export const KLINES_ERROR_TYPE = {
  EMPTY: "klines_empty",
  INVALID_REQUEST: "klines_invalid_request",
  CONNECTOR_UNAVAILABLE: "klines_connector_unavailable",
  UPSTREAM_FAILED: "klines_upstream_failed",
} as const;

export type KlinesErrorType = (typeof KLINES_ERROR_TYPE)[keyof typeof KLINES_ERROR_TYPE];

export interface KlinesErrorPayload {
  type: KlinesErrorType;
  code: string;
  message: string;
  hint?: string;
}

const DATA_SOURCE_HINTS: Partial<Record<KlinesDataSourceMeta, string>> = {
  akshare:
    "AKShare 主要覆盖 A 股；美股/港股/加密等请在配置中心将 K 线数据源设为 auto 或 yahoo_chart。",
  eastmoney: "东方财富适用于 A 股/北交所；其它市场请使用 auto 或 yahoo_chart。",
  tushare_daily: "请确认 Tushare Token 有效，且标的为 A 股日线。",
  binance_crypto:
    "Binance 未返回数据：请确认交易对（如 BTCUSDT）、市场 CRYPTO，以及网络可访问 api.binance.com；测试网可在配置中启用 cryptoUseTestnet。",
  wind:
    "Wind 未返回数据：请确认本地已安装 Wind 终端并已登录，WindPy 可用；可在配置中心查看 Wind 登录态并尝试「重新连接」。",
  synthetic: "当前配置禁用了外部 K 线（synthetic）；请在配置中心调整 qubit-data.klinesDataSource。",
  yahoo_chart: "Yahoo 未返回数据：请检查代码、市场与周期是否匹配（如美股代码 + 市场 US）。",
};

export function buildKlinesEmptyError(params: {
  symbol: string;
  exchange: string;
  timeframe: string;
  period: string;
  dataSource: KlinesDataSourceMeta;
  requestedLimit: number;
}): KlinesErrorPayload {
  const ex = params.exchange.trim() || "—";
  const hint = DATA_SOURCE_HINTS[params.dataSource];
  return {
    type: KLINES_ERROR_TYPE.EMPTY,
    code: `${params.dataSource}_no_bars`,
    message: `未获取到 K 线：${params.symbol} · 市场 ${ex} · 周期 ${params.timeframe}（请求 ${params.requestedLimit} 根，返回 0）`,
    ...(hint ? { hint } : {}),
  };
}

export function buildKlinesInvalidRequestError(message: string): KlinesErrorPayload {
  return {
    type: KLINES_ERROR_TYPE.INVALID_REQUEST,
    code: "invalid_request",
    message,
  };
}

export function buildKlinesConnectorUnavailableError(): KlinesErrorPayload {
  return {
    type: KLINES_ERROR_TYPE.CONNECTOR_UNAVAILABLE,
    code: "connector_not_registered",
    message: "行情连接器 qubit-data 未注册",
    hint: "请确认后端已启动并完成连接器初始化。",
  };
}

export function buildKlinesUpstreamFailedError(message: string): KlinesErrorPayload {
  return {
    type: KLINES_ERROR_TYPE.UPSTREAM_FAILED,
    code: "upstream_failed",
    message,
  };
}

/** 将任意异常包装为统一 K 线错误结构 */
export function wrapKlinesThrownError(e: unknown): KlinesErrorPayload {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    msg.startsWith("market_data_unavailable") ||
    /HTTP (429|451|5\d\d)|rate limit|timeout|circuit/i.test(msg)
  ) {
    return buildKlinesUpstreamFailedError(msg);
  }
  if (msg.includes("required") || msg.includes("symbol")) {
    return buildKlinesInvalidRequestError(msg);
  }
  if (msg.includes("not registered")) {
    return buildKlinesConnectorUnavailableError();
  }
  return buildKlinesUpstreamFailedError(msg);
}
