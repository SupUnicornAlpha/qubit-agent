import { queryKlines } from "../market/klines-query";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { snapshotIndicators } from "../market/technical-indicators";

/**
 * 研究团队分析前自动拉取行情与新闻，写入分析师 context（缺口 C）。
 */
export async function buildAnalystTeamDataContext(params: {
  ticker: string;
  exchange?: string;
}): Promise<string> {
  const ticker = params.ticker.trim();
  if (!ticker) return "";

  const exchange = params.exchange?.trim() ?? "";
  const blocks: string[] = ["## 自动数据快照（系统拉取，供分析引用，请勿臆造未列出数据）"];

  try {
    const { bars, meta, error } = await queryKlines({
      symbol: ticker,
      exchange: exchange || undefined,
      timeframe: "1d",
      limit: 250,
    });
    if (error) {
      blocks.push(`[行情] 拉取失败：${error.message}`);
    } else if (bars.length === 0) {
      blocks.push("[行情] 未返回 K 线（请检查标的代码、数据源配置或网络）");
    } else {
      const snap = snapshotIndicators(bars, ticker);
      const last = bars[bars.length - 1];
      blocks.push(
        `[行情] 数据源=${meta?.dataSource ?? "unknown"}，${bars.length} 根日线`,
        `- 最新：收盘 ${last.close}，时间 ${last.timestamp}`,
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
      symbol: ticker,
      exchange: exchange || undefined,
      limit: 6,
    });
    if (brief.items.length === 0) {
      blocks.push("[资讯] 暂无头条（可配置 qubit-news 或检查 RSS）");
    } else {
      blocks.push(`[资讯] 共 ${brief.items.length} 条：`);
      for (const item of brief.items.slice(0, 6)) {
        blocks.push(`- ${item.title}${item.source ? `（${item.source}）` : ""}`);
      }
    }
  } catch (e) {
    blocks.push(`[资讯] 异常：${e instanceof Error ? e.message : String(e)}`);
  }

  return blocks.filter((line) => line.length > 0).join("\n");
}
