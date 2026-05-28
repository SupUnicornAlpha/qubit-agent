-- E1: 把 mcp-financex 1.0.11 真实工具清单写进 capabilities_json.tools。
--
-- 背景：复盘 WF 44ca3acf 时发现 def-analyst-fundamental 反复调
--   `mcp-financex/get_financials` 和 `mcp-financex/list_available_tools`
-- 两个**不存在的工具名**，server 抛 FinanceError(Unknown tool) 把分析师
-- 一轮 reason 浪费掉（mcp_call_log 实测 2 次失败，最终 confidence 0.35）。
--
-- 根因：buildAgentToolsPromptBlock 只往 prompt 注入 MCP server 名，
-- 没注入"该 server 真实暴露的工具清单"。LLM 凭训练记忆把
-- `get_financial_statements` 简写成 `get_financials`、把 listing 操作错写成
-- 业务工具 `list_available_tools`（实际 MCP 协议是 tools/list 这个独立 method）。
--
-- 修复方案（runtime 层 + DB 层双管）：
--   1. runtime: resolveEnabledMcpServers 拉 capabilities_json.tools，
--      tool-call-format 在 prompt 块里完整列出真实工具名 + 简要描述。
--   2. DB: 把 mcp_server_config 中 name='mcp-financex' 的行 capabilities_json
--      原地补上 tools 数组（26 个工具，按分组排列）。
--
-- 仅当 capabilities_json 还没有 tools 字段时才写入（幂等保护）。

UPDATE mcp_server_config
SET capabilities_json = json_set(
  CASE
    WHEN capabilities_json IS NULL OR capabilities_json = '' OR json_valid(capabilities_json) = 0
    THEN '{}'
    ELSE capabilities_json
  END,
  '$.tools',
  json('[
    {"name":"get_quote","desc":"单标的实时行情快照"},
    {"name":"get_quote_batch","desc":"批量标的实时行情"},
    {"name":"get_historical_data","desc":"历史 OHLCV（日线/分钟）"},
    {"name":"search_ticker","desc":"按关键词搜索 ticker"},
    {"name":"get_market_news","desc":"标的新闻头条"},
    {"name":"calculate_indicator","desc":"技术指标计算（RSI/MACD/MA…）"},
    {"name":"get_extended_hours_data","desc":"盘前/盘后行情"},
    {"name":"get_short_interest","desc":"做空利息与挤空指数"},
    {"name":"get_analyst_ratings","desc":"分析师评级与目标价"},
    {"name":"analyze_news_impact","desc":"新闻情绪与股价关联分析"},
    {"name":"get_options_chain","desc":"期权链（到期日 + 行权价）"},
    {"name":"get_earnings_calendar","desc":"财报日历"},
    {"name":"get_dividend_info","desc":"股息历史与下次派息"},
    {"name":"calculate_greeks","desc":"期权希腊字母计算"},
    {"name":"calculate_historical_volatility","desc":"历史波动率（多窗口）"},
    {"name":"calculate_max_pain","desc":"Max Pain 期权痛点价"},
    {"name":"get_implied_volatility","desc":"隐含波动率/IV Rank"},
    {"name":"analyze_options_strategy","desc":"期权组合策略评估"},
    {"name":"get_13f_institutional_holdings","desc":"13F 机构持仓"},
    {"name":"get_13dg_ownership_changes","desc":"13D/13G 大宗持股变化"},
    {"name":"get_8k_material_events","desc":"8-K 重大事件"},
    {"name":"get_sec_form4_filings","desc":"SEC Form 4 内部人交易（首选名）"},
    {"name":"get_insider_trades","desc":"Form 4 内部人交易（legacy alias）"},
    {"name":"get_financial_statements","desc":"财报三表 + 比率（不叫 get_financials）"},
    {"name":"calculate_dcf_valuation","desc":"DCF 内在价值估算"},
    {"name":"compare_peer_companies","desc":"可比公司估值/财务对比"}
  ]')
)
WHERE name = 'mcp-financex'
  AND (
    capabilities_json IS NULL
    OR capabilities_json = ''
    OR json_valid(capabilities_json) = 0
    OR json_extract(capabilities_json, '$.tools') IS NULL
  );
