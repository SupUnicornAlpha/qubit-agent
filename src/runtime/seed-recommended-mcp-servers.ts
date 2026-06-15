/**
 * 推荐 MCP：数学计算 + 金融数据（来自 Anthropic 官方 Registry 与 npm 生态）。
 * @see https://registry.modelcontextprotocol.io
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { mcpServerConfig } from "../db/sqlite/schema";

/** 全局 MCP 服务名（projectId=null，全工作区可用） */
export const RECOMMENDED_MCP_NAMES = {
  MATHJS: "mathjs",
  TRADINGCALC: "tradingcalc",
  FINANCEX: "mcp-financex",
  FMP: "fmp-mcp",
  /**
   * 2026-06-10 Wave-1：3 个零-key 公开金融 MCP（Agent 智能补强）
   *   - PUBLIC_FINANCE：SEC EDGAR + US Treasury + BLS（@leviai/publicfinance-mcp）
   *   - US_GOV_OPEN_DATA：40+ 美国政府 API（lzinga/us-gov-open-data-mcp）
   *   - INVESTOR_AGENT：Yahoo Finance + 期权 + Fear&Greed（ferdousbhai/investor-agent v2）
   * 三者都不需要 API key 即可基础使用，是 mcp-financex 1.0.11 不稳定时的可靠替代/补充。
   */
  PUBLIC_FINANCE: "publicfinance",
  US_GOV_OPEN_DATA: "us-gov-open-data",
  INVESTOR_AGENT: "investor-agent",
} as const;

export type RecommendedMcpPreset = {
  name: string;
  transport: "stdio" | "http" | "ws";
  command?: string;
  url?: string;
  capabilitiesJson?: Record<string, unknown>;
  /** Anthropic MCP Registry slug（文档用） */
  registrySlug?: string;
  description: string;
};

/** 默认写入 DB 的预设（FMP 仅在环境变量存在时追加） */
export function buildRecommendedMcpPresets(): RecommendedMcpPreset[] {
  const presets: RecommendedMcpPreset[] = [
    {
      name: RECOMMENDED_MCP_NAMES.MATHJS,
      transport: "http",
      url: "https://gateway.pipeworx.io/mathjs/mcp",
      registrySlug: "io.github.pipeworx-io/mathjs",
      description: "Math.js 表达式求值（官方 Registry，免 API Key）",
    },
    {
      name: RECOMMENDED_MCP_NAMES.TRADINGCALC,
      transport: "http",
      url: "https://tradingcalc.io/api/mcp",
      registrySlug: "io.github.SKalinin909/tradingcalc",
      description: "合约/期货数学：PnL、强平、仓位、carry 等 19 个工具（官方 Registry）",
    },
    {
      name: RECOMMENDED_MCP_NAMES.FINANCEX,
      transport: "stdio",
      command: "npx -y mcp-financex@1.0.11",
      registrySlug: "npm:mcp-financex",
      description: "股票/加密行情、技术指标、期权、SEC 披露与 DCF（Yahoo，免 API Key）",
      /**
       * mcp-financex 1.0.11 真实暴露的工具清单。
       *
       * 历史 bug：LLM 凭训练记忆把基本面工具喊成 `get_financials` /
       * `list_available_tools`（这两个都不存在），mcp-financex 抛
       * "Unknown tool" 直接断分析师推理一轮。
       *
       * 这里把真实工具名注入 capabilitiesJson.tools，让 prompt 拼装层
       * （buildAgentToolsPromptBlock）能列出真实清单，LLM 不再瞎猜。
       */
      /**
       * 2026-06-05 监控复盘 #3：mcp-financex 1.0.11 在最近 1d 12 次调用 12 次失败，
       * 子进程在 tools/call 阶段提前退出（exit code=?），circuit breaker 频繁打开。
       * 1.0.11 已经是 npm 最新版（最低 1.0.2），没有更高版本可升级。
       * 受影响工具实测：get_financial_statements / analyze_news_impact /
       * get_historical_data / search_ticker。
       *
       * 修复：在 desc 里给这 4 个工具加 ⚠ unstable 标记 + 指向稳定替代方案，
       * 让 prompt 拼装层 (buildAgentToolsPromptBlock) 把警告带给 LLM，下次选工具时
       * 优先用 qubit-data/qubit-news 等内置 connector，避免无谓重试。
       */
      capabilitiesJson: {
        tools: [
          { name: "get_quote", desc: "单标的实时行情快照（稳定）" },
          { name: "get_quote_batch", desc: "批量标的实时行情（稳定）" },
          {
            name: "get_historical_data",
            desc:
              "⚠ mcp-financex 1.0.11 实测不稳定（子进程崩）。优先用 qubit-data/fetch_klines 拉 OHLCV。",
          },
          {
            name: "search_ticker",
            desc:
              "⚠ mcp-financex 1.0.11 实测不稳定（子进程崩）。可用 qubit-data/fetch_klines 直接传 symbol 验证存在性。",
          },
          { name: "get_market_news", desc: "标的新闻头条" },
          { name: "calculate_indicator", desc: "技术指标计算（RSI/MACD/MA…）" },
          { name: "get_extended_hours_data", desc: "盘前/盘后行情" },
          { name: "get_short_interest", desc: "做空利息与挤空指数" },
          { name: "get_analyst_ratings", desc: "分析师评级与目标价" },
          {
            name: "analyze_news_impact",
            desc:
              "⚠ mcp-financex 1.0.11 实测不稳定（子进程崩）。优先用 qubit-news/fetch_news_sentiment 做情绪聚合。",
          },
          { name: "get_options_chain", desc: "期权链（到期日 + 行权价）" },
          { name: "get_earnings_calendar", desc: "财报日历" },
          { name: "get_dividend_info", desc: "股息历史与下次派息" },
          { name: "calculate_greeks", desc: "期权希腊字母计算" },
          { name: "calculate_historical_volatility", desc: "历史波动率（多窗口）" },
          { name: "calculate_max_pain", desc: "Max Pain 期权痛点价" },
          { name: "get_implied_volatility", desc: "隐含波动率/IV Rank" },
          { name: "analyze_options_strategy", desc: "期权组合策略评估" },
          { name: "get_13f_institutional_holdings", desc: "13F 机构持仓" },
          { name: "get_13dg_ownership_changes", desc: "13D/13G 大宗持股变化" },
          { name: "get_8k_material_events", desc: "8-K 重大事件" },
          { name: "get_sec_form4_filings", desc: "SEC Form 4 内部人交易（首选名）" },
          { name: "get_insider_trades", desc: "Form 4 内部人交易（legacy alias）" },
          {
            name: "get_financial_statements",
            desc:
              "⚠ mcp-financex 1.0.11 实测不稳定（子进程在 financials.js:175 处崩）。没有可靠替代——若必须取财报，可降级为基于 get_quote 的估值代理或直接在 reasoning 里标注 unavailable。",
          },
          { name: "calculate_dcf_valuation", desc: "DCF 内在价值估算" },
          {
            name: "compare_peer_companies",
            desc:
              "可比公司估值/财务对比。⚠ 参数 symbols 必须是含 **≥2 个** 标的的数组（如 [\"AAPL\",\"MSFT\"]），只传 1 个会被服务端直接拒绝（At least 2 symbols are required）。",
          },
        ],
      },
    },
  ];
  const fmpKey = process.env.FMP_API_KEY?.trim();
  if (fmpKey) {
    presets.push({
      name: RECOMMENDED_MCP_NAMES.FMP,
      transport: "stdio",
      command: "npx -y @houtini/fmp-mcp@1.1.3",
      registrySlug: "io.github.houtini-ai/fmp",
      description: "Financial Modeling Prep 250+ 工具（需 FMP_API_KEY）",
      capabilitiesJson: {
        env: { FMP_API_KEY: fmpKey },
      },
    });
  }

  // ── Wave-1 (2026-06-10) 零-key 公开金融 MCP ──────────────────────────────
  presets.push({
    name: RECOMMENDED_MCP_NAMES.PUBLIC_FINANCE,
    transport: "stdio",
    command: "npx -y @leviai/publicfinance-mcp",
    registrySlug: "npm:@leviai/publicfinance-mcp",
    description:
      "SEC EDGAR / US Treasury 收益曲线 / BLS 失业 CPI PPI / 经济综览（零 API key，MIT）",
    capabilitiesJson: {
      tools: [
        { name: "company_filings", desc: "按 ticker / CIK 拉 SEC EDGAR 10-K/10-Q/8-K/S-1 等" },
        {
          name: "company_facts",
          desc: "XBRL 标准化财务数据：Revenue / NetIncome / Assets 等 1000+ 概念",
        },
        { name: "treasury_rates", desc: "美国国债收益曲线 / Bill / 长期 / TIPS 实际收益" },
        {
          name: "labor_statistics",
          desc: "BLS：失业率 / CPI / nonfarm payrolls / participation / PPI / 自定 series",
        },
        { name: "ticker_lookup", desc: "Ticker ↔ 公司名 ↔ CIK 三向解析" },
        { name: "economic_overview", desc: "一次性返回收益曲线 + 失业 + CPI + payrolls 快照" },
      ],
    },
  });

  presets.push({
    name: RECOMMENDED_MCP_NAMES.US_GOV_OPEN_DATA,
    transport: "stdio",
    command: "npx -y us-gov-open-data-mcp",
    registrySlug: "npm:us-gov-open-data-mcp",
    description:
      "40+ 美国政府开源 API（FRED / Treasury / SEC / BLS / EIA / EPA …）共 300+ 工具；FRED 等可选 API key 升级配额",
    capabilitiesJson: {
      env: {
        // 都是可选 key；缺失时 server 会限制相应 module 但不 fail
        ...(process.env.FRED_API_KEY?.trim()
          ? { FRED_API_KEY: process.env.FRED_API_KEY.trim() }
          : {}),
        ...(process.env.DATA_GOV_API_KEY?.trim()
          ? { DATA_GOV_API_KEY: process.env.DATA_GOV_API_KEY.trim() }
          : {}),
      },
      // 300+ tools 不完整枚举，只挑量化最常用的几个让 LLM 知道这台 server 能干什么
      tools: [
        { name: "fred.series.observations", desc: "FRED 时间序列观测值（GDP/CPI/失业等）" },
        { name: "fred.series.search", desc: "FRED 系列模糊搜索（80 万条）" },
        { name: "treasury.daily_rates", desc: "美国国债日度收益曲线" },
        { name: "sec.company_facts", desc: "SEC EDGAR 公司财务事实（XBRL）" },
        { name: "sec.filings_list", desc: "SEC EDGAR 公司过往申报清单" },
        { name: "bls.timeseries", desc: "BLS 劳工统计时序（失业 / CPI / payrolls）" },
        { name: "eia.electricity_prices", desc: "EIA 电力价格序列（与工业需求挂钩）" },
        {
          name: "congress.bill_search",
          desc: "国会立法搜索（含可能影响行业的法案，事件驱动型策略可用）",
        },
      ],
    },
  });

  presets.push({
    name: RECOMMENDED_MCP_NAMES.INVESTOR_AGENT,
    transport: "stdio",
    command: "npx -y investor-agent",
    registrySlug: "npm:investor-agent",
    description:
      "Yahoo Finance 股票/期权/财报 + CNN Fear&Greed + Crypto F&G + 技术指标（零 API key，作 mcp-financex 1.0.11 不稳定时的稳定替代）",
    capabilitiesJson: {
      tools: [
        { name: "get_stock_info", desc: "股票基本面：价格 / 财务 / 财报 / 持股 / 分析师评级" },
        { name: "historical_prices", desc: "OHLCV 价格历史（默认 1y weekly，limit 100）" },
        { name: "get_options", desc: "期权合约（按 open interest 排序，默认 top 25/类）" },
        { name: "market_movers", desc: "涨幅榜 / 跌幅榜 / 最活跃" },
        { name: "earnings_calendar", desc: "NASDAQ 财报日历" },
        { name: "fear_greed_index", desc: "CNN 股市 / Crypto F&G 指数" },
        {
          name: "technical_indicator",
          desc: "SMA / EMA / RSI / MACD / Bollinger Bands（trading-signals 库）",
        },
      ],
    },
  });

  return presets;
}

/** 供 Agent seed 合并的 MCP 名列表 */
export function defaultQuantMcpServers(): string[] {
  const names = [
    RECOMMENDED_MCP_NAMES.MATHJS,
    RECOMMENDED_MCP_NAMES.TRADINGCALC,
    RECOMMENDED_MCP_NAMES.FINANCEX,
    /**
     * Wave-1：3 个零-key 公开金融 MCP 默认全部派给 quant 角色 —— mcp-financex 1.0.11
     * 不稳定时这三家是稳定 fallback；同时它们各自侧重不同：
     *   - investor-agent：Yahoo 股票 / 期权 / 技术指标，最快替代 mcp-financex
     *   - publicfinance：SEC / Treasury / BLS，分析师做基本面 / 宏观必需
     *   - us-gov-open-data：FRED 80 万序列等 40+ 美国政府数据源
     */
    RECOMMENDED_MCP_NAMES.INVESTOR_AGENT,
    RECOMMENDED_MCP_NAMES.PUBLIC_FINANCE,
    RECOMMENDED_MCP_NAMES.US_GOV_OPEN_DATA,
  ];
  if (process.env.FMP_API_KEY?.trim()) names.push(RECOMMENDED_MCP_NAMES.FMP);
  return names;
}

export function mergeMcpServers(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra])];
}

export async function seedRecommendedMcpServers(): Promise<void> {
  const db = await getDb();
  const presets = buildRecommendedMcpPresets();
  let upserted = 0;

  for (const preset of presets) {
    const existing = await db
      .select()
      .from(mcpServerConfig)
      .where(and(eq(mcpServerConfig.name, preset.name), isNull(mcpServerConfig.projectId)))
      .limit(1);

    const caps = preset.capabilitiesJson ?? {
      registrySlug: preset.registrySlug,
      description: preset.description,
    };

    if (existing[0]) {
      await db
        .update(mcpServerConfig)
        .set({
          transport: preset.transport,
          command: preset.command ?? existing[0].command,
          url: preset.url ?? existing[0].url,
          capabilitiesJson: caps,
          enabled: true,
        })
        .where(eq(mcpServerConfig.id, existing[0].id));
    } else {
      await db.insert(mcpServerConfig).values({
        id: randomUUID(),
        name: preset.name,
        projectId: null,
        transport: preset.transport,
        command: preset.command ?? null,
        url: preset.url ?? null,
        capabilitiesJson: caps,
        enabled: true,
      });
    }
    upserted += 1;
  }

  const presetNames = presets.map((p) => p.name).join(", ");
  console.log(`[Seed] Upserted ${upserted} recommended MCP servers (${presetNames}).`);
}

if (import.meta.main) {
  void seedRecommendedMcpServers().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
