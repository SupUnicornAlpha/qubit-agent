import type { NormalizedResearchScope } from "../../types/research-scope";
import { formatResearchScopePreamble } from "./analyst-team-scope";
import { isCryptoMarket } from "../market/crypto-market";
import { queryKlines } from "../market/klines-query";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { resolveTickerMarket } from "../market/resolve-ticker-market";
import { snapshotIndicators } from "../market/technical-indicators";

/**
 * 用 deterministic resolver 渲染一段"系统市场识别"块塞进 prompt。
 *
 * 评估报告 P0 修复点：之前 prompt 不显式告诉 LLM 主标的属于哪个市场，
 * LLM 在 `fetch_klines` 等工具调用上自由发挥，常见错误：
 *   - 把 `000001` 当上证综指（应为深市平安银行）
 *   - 把港股 `00700.HK` 当美股
 *   - 加密 `BTCUSDT` 用 yfinance 拉空
 *
 * 现在把 resolver 的结果（含 confidence + reason）写在 "## 自动数据快照" 之前，
 * 让 LLM 在做工具调用前看到事实而不是凭直觉。
 *
 * 返回空字符串 = 不输出（primary 为空时跳过）。
 */
export function buildMarketIdentificationBlock(
  primary: string,
  hintExchange?: string | undefined
): string {
  if (!primary) return "";
  const r = resolveTickerMarket(primary, { hintExchange });
  const head = `### 系统市场识别`;
  if (r.market === "UNKNOWN") {
    return [
      head,
      `- 主标的：${primary}`,
      `- market 推断失败（fallback）；**请先调 fetch_klines + 候选 exchange (US/CN/HK/CRYPTO) 探测**，或向用户澄清。`,
    ].join("\n");
  }
  return [
    head,
    `- 主标的：${primary}`,
    `- market=**${r.market}** / exchange=**${r.exchange}**（confidence=${r.confidence}）`,
    `- 推断依据：${r.reason}`,
    `- 工具调用时请优先使用上述 exchange；如需覆盖，请在 reasoning 中显式说明理由。`,
  ].join("\n");
}

async function buildSingleSymbolSnapshot(
  symbol: string,
  exchange?: string
): Promise<string[]> {
  const blocks: string[] = [`### ${symbol}`];
  try {
    const { bars, meta, error } = await queryKlines({
      symbol,
      exchange: exchange || undefined,
      timeframe: "1d",
      limit: 250,
    });
    if (error) {
      blocks.push(`[行情] 拉取失败：${error.message}`);
    } else if (bars.length === 0) {
      blocks.push("[行情] 未返回 K 线");
    } else {
      const snap = snapshotIndicators(bars, symbol);
      const last = bars[bars.length - 1];
      blocks.push(
        `[行情] 数据源=${meta?.dataSource ?? "unknown"}，${bars.length} 根日线`,
        `- 最新收盘 ${last.close}（${last.timestamp}）`,
        `- 近20日收益 ${(snap.return20d * 100).toFixed(2)}%`,
        snap.sma20 != null ? `- SMA20 ${snap.sma20.toFixed(4)}` : "",
        snap.rsi14 != null ? `- RSI14 ${snap.rsi14.toFixed(2)}` : "",
        snap.macd != null ? `- MACD ${snap.macd.toFixed(4)}` : ""
      );
    }
  } catch (e) {
    blocks.push(`[行情] 异常：${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const brief = await queryMarketNewsBrief({
      symbol,
      exchange: exchange || undefined,
      limit: 5,
    });
    const newsItems = [...brief.symbolNews, ...brief.sectorNews];
    if (newsItems.length === 0) {
      blocks.push("[资讯] 暂无头条");
    } else {
      const sectorHint = brief.sectorLabel != null ? `，板块 ${brief.sectorLabel}` : "";
      blocks.push(`[资讯] ${newsItems.length} 条${sectorHint}：`);
      for (const item of newsItems.slice(0, 4)) {
        blocks.push(`- ${item.title}${item.source ? `（${item.source}）` : ""}`);
      }
    }
  } catch (e) {
    blocks.push(`[资讯] 异常：${e instanceof Error ? e.message : String(e)}`);
  }

  return blocks.filter((line) => line.length > 0);
}

/**
 * 研究团队分析前自动拉取行情与新闻（支持单标的、篮子、板块）。
 */
export async function buildAnalystTeamDataContext(params: {
  ticker?: string;
  scope?: NormalizedResearchScope;
  exchange?: string;
}): Promise<string> {
  const scope =
    params.scope ??
    ({
      kind: "single",
      symbols: [params.ticker?.trim() || "UNKNOWN"],
      primarySymbol: params.ticker?.trim().toUpperCase() || "UNKNOWN",
      displayLabel: params.ticker?.trim() || "UNKNOWN",
      instrument: "equity",
      positionSide: "long",
    } satisfies NormalizedResearchScope);

  const primary = scope.primarySymbol || params.ticker?.trim() || "";
  const hintExchange = params.exchange ?? scope.exchange;

  /**
   * 评估报告 P0 修复点：之前 exchange 推断只覆盖加密一种，其它一律 undefined，
   * 让 LLM 自己猜市场。现在用统一 resolver 一次性解析（含 hintExchange 优先级），
   * 把结果**显式注入到 prompt** 让 LLM 看到 market 事实而不是凭直觉。
   */
  const resolved = primary ? resolveTickerMarket(primary, { hintExchange }) : null;
  const inferredCrypto =
    !hintExchange && primary && isCryptoMarket(primary, "");
  const exchange =
    hintExchange ??
    (resolved && resolved.market !== "UNKNOWN" ? resolved.exchange : undefined) ??
    (inferredCrypto ? "CRYPTO" : undefined);

  const blocks: string[] = [
    "## 自动数据快照（系统拉取，供分析引用，请勿臆造未列出数据）",
    formatResearchScopePreamble(scope),
  ];

  const marketBlock = buildMarketIdentificationBlock(primary, hintExchange);
  if (marketBlock) blocks.push(marketBlock, "");

  /**
   * explore 模式 + 空 symbols → 跳过自动行情快照。
   *
   * 之前 fallback 到 [primarySymbol] = ["AUTO_EXPLORE"]，结果 fetch_klines
   * 必然失败，然后 orchestrator 简报顶部就显示"拉取失败：未获取到 K 线：
   * AUTO_EXPLORE"，把 LLM 引向"无数据 → 不能做"的死循环。
   *
   * 正确做法：explore 没指定标的就显式告诉 LLM"请自主选标 + 用 fetch_klines
   * 验证存在性"，不要去 fetch 一个空 ticker。
   */
  const symbolsToFetch = scope.symbols.filter(
    (s) => typeof s === "string" && s.trim().length > 0
  );
  const skipSnapshotForExplore =
    scope.kind === "explore" && symbolsToFetch.length === 0;

  if (skipSnapshotForExplore) {
    blocks.push(
      "### 自由探索：标的池待 LLM 自主选择",
      "[提示] 当前任务未绑定固定标的，**请勿在此处期待任何系统拉取的行情/新闻**。",
      "请按以下步骤自主推进：",
      "1. 调用 `factor.list` / `skill.search` / `search_memory` 复用历史成功路径；",
      "2. 自主提出 1-3 个候选 ticker；",
      "3. 用 `fetch_klines` 验证每个 ticker 真实存在 + 有足够日均成交额，无法验证立即剔除；",
      "4. 选定后再开展基本面/技术面/情绪面分析。",
      ""
    );
  } else {
    for (const sym of symbolsToFetch.slice(0, 12)) {
      const snap = await buildSingleSymbolSnapshot(sym, exchange);
      blocks.push(...snap, "");
    }
  }

  if (scope.kind === "sector" && scope.sector && symbolsToFetch.length === 0) {
    blocks.push(
      `### 板块 ${scope.sector}`,
      "[提示] 未配置成分股代码，请结合宏观/行业新闻与逻辑推演；可让用户补充 peer 列表。"
    );
  }

  return blocks.filter((line) => line.length > 0).join("\n");
}
