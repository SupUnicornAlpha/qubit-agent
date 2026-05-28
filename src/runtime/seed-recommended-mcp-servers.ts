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
      capabilitiesJson: {
        tools: [
          { name: "get_quote", desc: "单标的实时行情快照" },
          { name: "get_quote_batch", desc: "批量标的实时行情" },
          { name: "get_historical_data", desc: "历史 OHLCV（日线/分钟）" },
          { name: "search_ticker", desc: "按关键词搜索 ticker" },
          { name: "get_market_news", desc: "标的新闻头条" },
          { name: "calculate_indicator", desc: "技术指标计算（RSI/MACD/MA…）" },
          { name: "get_extended_hours_data", desc: "盘前/盘后行情" },
          { name: "get_short_interest", desc: "做空利息与挤空指数" },
          { name: "get_analyst_ratings", desc: "分析师评级与目标价" },
          { name: "analyze_news_impact", desc: "新闻情绪与股价关联分析" },
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
          { name: "get_financial_statements", desc: "财报三表 + 比率（不叫 get_financials）" },
          { name: "calculate_dcf_valuation", desc: "DCF 内在价值估算" },
          { name: "compare_peer_companies", desc: "可比公司估值/财务对比" },
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
  return presets;
}

/** 供 Agent seed 合并的 MCP 名列表 */
export function defaultQuantMcpServers(): string[] {
  const names = [
    RECOMMENDED_MCP_NAMES.MATHJS,
    RECOMMENDED_MCP_NAMES.TRADINGCALC,
    RECOMMENDED_MCP_NAMES.FINANCEX,
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

  console.log(
    `[Seed] Upserted ${upserted} recommended MCP servers (mathjs, tradingcalc, mcp-financex` +
      `${process.env.FMP_API_KEY?.trim() ? ", fmp-mcp" : ""}).`
  );
}

if (import.meta.main) {
  void seedRecommendedMcpServers().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
