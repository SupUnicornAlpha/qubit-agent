/**
 * Screener Universe Pool — 真实 ticker 集（first-pass screening 用）。
 *
 * 2026-06-05 监控复盘 #4 / C 修复：
 *   `run_screener` 原本是 stub（hardcoded 10 个 mock 股），用户提"探索类任务"
 *   （如"分析下 AI 半导体的机会"）时 LLM 无可用候选 → 死循环。
 *
 * 设计取舍：
 *   - 不接外部 API（yfinance / 东财 / wind 等都需要凭据 + 维护，引入更多脆弱依赖）
 *   - 静态池覆盖主要指数：
 *       US ~80 个（S&P500 / NDX100 头部 + 各 sector 代表）
 *       CN-A ~50 个（沪深300 头部 + 各板块代表）
 *       HK ~25 个（恒生科技 + 恒指头部）
 *       crypto ~5 个（first-pass 探索）
 *   - 评分用粗略的 quality/momentum/sentiment 数值（first-pass 用，分析师后续会
 *     用真实 fetch_klines/fetch_fundamentals 深入）
 *   - 关键字段：sector / industry / country —— 让 LLM 能按"AI半导体" → industry='Semiconductors' 筛
 *
 * 后续扩展（独立 PR）：
 *   - 接 qubit-data 后端按需 refresh marketCap/pe（每周 1 次离线 job）
 *   - 接 yfinance.Ticker.info（best-effort，失败回退本地）
 */

export type StockUniverseKey = "US" | "CN-A" | "HK" | "CRYPTO";

export interface UniverseStock {
  ticker: string;
  companyName: string;
  /** 大致市值（十亿美元 / 十亿人民币，粗略数量级；first-pass 筛用） */
  marketCapBillion: number;
  pe: number;
  momentum30d: number;
  quality: number;
  sentiment: number;
  country: "US" | "CN" | "HK" | "CRYPTO";
  /** 板块 ("Tech" / "Financials" / "Healthcare" / ...) */
  sector: string;
  /** 子行业 ("Semiconductors" / "Software" / "Banks" / ...) */
  industry: string;
}

/**
 * US 池：S&P500 + NDX100 头部 + 各 sector 至少 3 个代表（cover AI/半导体/云/biotech/
 * energy/consumer/banks/REIT 等常被 LLM 提及的主题）。
 */
const US_POOL: UniverseStock[] = [
  // ─── Tech / AI / Semis ──────────────────────────────────────────────
  { ticker: "AAPL",  companyName: "Apple Inc.",            marketCapBillion: 3500, pe: 33, momentum30d: 0.05, quality: 0.96, sentiment: 0.71, country: "US", sector: "Tech", industry: "Consumer Electronics" },
  { ticker: "MSFT",  companyName: "Microsoft Corp.",       marketCapBillion: 3300, pe: 34, momentum30d: 0.06, quality: 0.97, sentiment: 0.72, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "GOOGL", companyName: "Alphabet Inc.",         marketCapBillion: 2200, pe: 26, momentum30d: 0.07, quality: 0.94, sentiment: 0.68, country: "US", sector: "Tech", industry: "Internet" },
  { ticker: "META",  companyName: "Meta Platforms",        marketCapBillion: 1500, pe: 28, momentum30d: 0.10, quality: 0.90, sentiment: 0.74, country: "US", sector: "Tech", industry: "Internet" },
  { ticker: "AMZN",  companyName: "Amazon.com",            marketCapBillion: 2100, pe: 50, momentum30d: 0.08, quality: 0.91, sentiment: 0.69, country: "US", sector: "Consumer", industry: "E-Commerce" },
  { ticker: "NVDA",  companyName: "NVIDIA Corp.",          marketCapBillion: 3000, pe: 55, momentum30d: 0.15, quality: 0.95, sentiment: 0.85, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "AMD",   companyName: "Advanced Micro Devices", marketCapBillion: 250, pe: 45, momentum30d: 0.12, quality: 0.88, sentiment: 0.76, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "AVGO",  companyName: "Broadcom Inc.",         marketCapBillion: 900,  pe: 35, momentum30d: 0.09, quality: 0.92, sentiment: 0.74, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "TSM",   companyName: "Taiwan Semiconductor",  marketCapBillion: 800,  pe: 27, momentum30d: 0.11, quality: 0.93, sentiment: 0.77, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "INTC",  companyName: "Intel Corp.",           marketCapBillion: 150,  pe: 30, momentum30d: -0.03, quality: 0.75, sentiment: 0.45, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "QCOM",  companyName: "Qualcomm Inc.",         marketCapBillion: 180,  pe: 18, momentum30d: 0.04, quality: 0.86, sentiment: 0.63, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "MU",    companyName: "Micron Technology",     marketCapBillion: 110,  pe: 22, momentum30d: 0.13, quality: 0.82, sentiment: 0.70, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "AMAT",  companyName: "Applied Materials",     marketCapBillion: 150,  pe: 20, momentum30d: 0.08, quality: 0.87, sentiment: 0.67, country: "US", sector: "Tech", industry: "Semi Equipment" },
  { ticker: "LRCX",  companyName: "Lam Research",          marketCapBillion: 100,  pe: 22, momentum30d: 0.07, quality: 0.88, sentiment: 0.66, country: "US", sector: "Tech", industry: "Semi Equipment" },
  { ticker: "KLAC",  companyName: "KLA Corp.",             marketCapBillion: 90,   pe: 25, momentum30d: 0.06, quality: 0.89, sentiment: 0.65, country: "US", sector: "Tech", industry: "Semi Equipment" },
  { ticker: "ASML",  companyName: "ASML Holding",          marketCapBillion: 280,  pe: 30, momentum30d: 0.05, quality: 0.94, sentiment: 0.72, country: "US", sector: "Tech", industry: "Semi Equipment" },
  { ticker: "ARM",   companyName: "ARM Holdings",          marketCapBillion: 130,  pe: 90, momentum30d: 0.14, quality: 0.84, sentiment: 0.78, country: "US", sector: "Tech", industry: "Semiconductors" },
  { ticker: "ORCL",  companyName: "Oracle Corp.",          marketCapBillion: 400,  pe: 30, momentum30d: 0.09, quality: 0.85, sentiment: 0.68, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "CRM",   companyName: "Salesforce Inc.",       marketCapBillion: 280,  pe: 45, momentum30d: 0.06, quality: 0.83, sentiment: 0.62, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "ADBE",  companyName: "Adobe Inc.",            marketCapBillion: 230,  pe: 36, momentum30d: 0.04, quality: 0.91, sentiment: 0.66, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "NOW",   companyName: "ServiceNow Inc.",       marketCapBillion: 160,  pe: 60, momentum30d: 0.08, quality: 0.86, sentiment: 0.69, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "PLTR",  companyName: "Palantir Technologies", marketCapBillion: 60,   pe: 200, momentum30d: 0.18, quality: 0.74, sentiment: 0.82, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "CRWD",  companyName: "CrowdStrike Holdings",  marketCapBillion: 90,   pe: 75, momentum30d: 0.07, quality: 0.82, sentiment: 0.70, country: "US", sector: "Tech", industry: "Cybersecurity" },
  { ticker: "PANW",  companyName: "Palo Alto Networks",    marketCapBillion: 110,  pe: 50, momentum30d: 0.06, quality: 0.84, sentiment: 0.68, country: "US", sector: "Tech", industry: "Cybersecurity" },
  { ticker: "ZS",    companyName: "Zscaler Inc.",          marketCapBillion: 30,   pe: 100, momentum30d: 0.05, quality: 0.76, sentiment: 0.64, country: "US", sector: "Tech", industry: "Cybersecurity" },
  { ticker: "NET",   companyName: "Cloudflare Inc.",       marketCapBillion: 35,   pe: 200, momentum30d: 0.10, quality: 0.72, sentiment: 0.71, country: "US", sector: "Tech", industry: "Internet Infra" },
  { ticker: "SNOW",  companyName: "Snowflake Inc.",        marketCapBillion: 50,   pe: 180, momentum30d: 0.04, quality: 0.78, sentiment: 0.62, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "DDOG",  companyName: "Datadog Inc.",          marketCapBillion: 40,   pe: 80,  momentum30d: 0.06, quality: 0.81, sentiment: 0.66, country: "US", sector: "Tech", industry: "Software" },
  { ticker: "MDB",   companyName: "MongoDB Inc.",          marketCapBillion: 18,   pe: 60,  momentum30d: 0.03, quality: 0.74, sentiment: 0.58, country: "US", sector: "Tech", industry: "Software" },

  // ─── Financials ─────────────────────────────────────────────────────
  { ticker: "JPM",   companyName: "JPMorgan Chase",        marketCapBillion: 600,  pe: 12, momentum30d: 0.04, quality: 0.92, sentiment: 0.65, country: "US", sector: "Financials", industry: "Banks" },
  { ticker: "BAC",   companyName: "Bank of America",       marketCapBillion: 320,  pe: 11, momentum30d: 0.03, quality: 0.86, sentiment: 0.58, country: "US", sector: "Financials", industry: "Banks" },
  { ticker: "WFC",   companyName: "Wells Fargo",           marketCapBillion: 230,  pe: 12, momentum30d: 0.02, quality: 0.82, sentiment: 0.55, country: "US", sector: "Financials", industry: "Banks" },
  { ticker: "GS",    companyName: "Goldman Sachs",         marketCapBillion: 160,  pe: 14, momentum30d: 0.05, quality: 0.88, sentiment: 0.62, country: "US", sector: "Financials", industry: "Investment Banking" },
  { ticker: "MS",    companyName: "Morgan Stanley",        marketCapBillion: 175,  pe: 16, momentum30d: 0.04, quality: 0.86, sentiment: 0.60, country: "US", sector: "Financials", industry: "Investment Banking" },
  { ticker: "BLK",   companyName: "BlackRock Inc.",        marketCapBillion: 150,  pe: 22, momentum30d: 0.03, quality: 0.90, sentiment: 0.63, country: "US", sector: "Financials", industry: "Asset Management" },
  { ticker: "V",     companyName: "Visa Inc.",             marketCapBillion: 580,  pe: 33, momentum30d: 0.03, quality: 0.95, sentiment: 0.68, country: "US", sector: "Financials", industry: "Payments" },
  { ticker: "MA",    companyName: "Mastercard Inc.",       marketCapBillion: 480,  pe: 38, momentum30d: 0.04, quality: 0.94, sentiment: 0.70, country: "US", sector: "Financials", industry: "Payments" },

  // ─── Healthcare / Biotech ───────────────────────────────────────────
  { ticker: "UNH",   companyName: "UnitedHealth Group",    marketCapBillion: 470,  pe: 22, momentum30d: 0.02, quality: 0.92, sentiment: 0.60, country: "US", sector: "Healthcare", industry: "Health Insurance" },
  { ticker: "JNJ",   companyName: "Johnson & Johnson",     marketCapBillion: 380,  pe: 18, momentum30d: 0.01, quality: 0.93, sentiment: 0.62, country: "US", sector: "Healthcare", industry: "Pharma" },
  { ticker: "LLY",   companyName: "Eli Lilly & Co.",       marketCapBillion: 720,  pe: 60, momentum30d: 0.08, quality: 0.91, sentiment: 0.78, country: "US", sector: "Healthcare", industry: "Pharma" },
  { ticker: "PFE",   companyName: "Pfizer Inc.",           marketCapBillion: 160,  pe: 14, momentum30d: -0.02, quality: 0.78, sentiment: 0.42, country: "US", sector: "Healthcare", industry: "Pharma" },
  { ticker: "ABBV",  companyName: "AbbVie Inc.",           marketCapBillion: 310,  pe: 16, momentum30d: 0.03, quality: 0.87, sentiment: 0.60, country: "US", sector: "Healthcare", industry: "Pharma" },
  { ticker: "MRK",   companyName: "Merck & Co.",           marketCapBillion: 280,  pe: 17, momentum30d: 0.02, quality: 0.88, sentiment: 0.61, country: "US", sector: "Healthcare", industry: "Pharma" },
  { ticker: "MRNA",  companyName: "Moderna Inc.",          marketCapBillion: 18,   pe: 30, momentum30d: -0.05, quality: 0.68, sentiment: 0.40, country: "US", sector: "Healthcare", industry: "Biotech" },
  { ticker: "REGN",  companyName: "Regeneron Pharma",      marketCapBillion: 90,   pe: 20, momentum30d: 0.03, quality: 0.84, sentiment: 0.58, country: "US", sector: "Healthcare", industry: "Biotech" },
  { ticker: "VRTX",  companyName: "Vertex Pharmaceuticals", marketCapBillion: 110, pe: 28, momentum30d: 0.05, quality: 0.85, sentiment: 0.63, country: "US", sector: "Healthcare", industry: "Biotech" },

  // ─── Energy ─────────────────────────────────────────────────────────
  { ticker: "XOM",   companyName: "Exxon Mobil",           marketCapBillion: 460,  pe: 13, momentum30d: 0.05, quality: 0.83, sentiment: 0.55, country: "US", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "CVX",   companyName: "Chevron Corp.",         marketCapBillion: 290,  pe: 14, momentum30d: 0.04, quality: 0.81, sentiment: 0.53, country: "US", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "COP",   companyName: "ConocoPhillips",        marketCapBillion: 140,  pe: 12, momentum30d: 0.06, quality: 0.79, sentiment: 0.56, country: "US", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "SLB",   companyName: "Schlumberger",          marketCapBillion: 60,   pe: 12, momentum30d: 0.07, quality: 0.74, sentiment: 0.57, country: "US", sector: "Energy", industry: "Oil Services" },

  // ─── Consumer ───────────────────────────────────────────────────────
  { ticker: "TSLA",  companyName: "Tesla Inc.",            marketCapBillion: 1000, pe: 65, momentum30d: 0.11, quality: 0.78, sentiment: 0.74, country: "US", sector: "Consumer", industry: "Auto" },
  { ticker: "F",     companyName: "Ford Motor",            marketCapBillion: 45,   pe: 8,  momentum30d: -0.02, quality: 0.65, sentiment: 0.42, country: "US", sector: "Consumer", industry: "Auto" },
  { ticker: "GM",    companyName: "General Motors",        marketCapBillion: 55,   pe: 7,  momentum30d: 0.03, quality: 0.68, sentiment: 0.46, country: "US", sector: "Consumer", industry: "Auto" },
  { ticker: "HD",    companyName: "Home Depot",            marketCapBillion: 400,  pe: 25, momentum30d: 0.02, quality: 0.89, sentiment: 0.60, country: "US", sector: "Consumer", industry: "Home Improvement" },
  { ticker: "WMT",   companyName: "Walmart Inc.",          marketCapBillion: 550,  pe: 28, momentum30d: 0.03, quality: 0.90, sentiment: 0.63, country: "US", sector: "Consumer", industry: "Retail" },
  { ticker: "COST",  companyName: "Costco Wholesale",      marketCapBillion: 380,  pe: 50, momentum30d: 0.05, quality: 0.92, sentiment: 0.68, country: "US", sector: "Consumer", industry: "Retail" },
  { ticker: "TGT",   companyName: "Target Corp.",          marketCapBillion: 70,   pe: 15, momentum30d: -0.01, quality: 0.76, sentiment: 0.48, country: "US", sector: "Consumer", industry: "Retail" },
  { ticker: "NKE",   companyName: "Nike Inc.",             marketCapBillion: 120,  pe: 28, momentum30d: -0.03, quality: 0.82, sentiment: 0.46, country: "US", sector: "Consumer", industry: "Apparel" },
  { ticker: "SBUX",  companyName: "Starbucks Corp.",       marketCapBillion: 110,  pe: 25, momentum30d: -0.02, quality: 0.81, sentiment: 0.50, country: "US", sector: "Consumer", industry: "Restaurants" },
  { ticker: "MCD",   companyName: "McDonald's Corp.",      marketCapBillion: 220,  pe: 25, momentum30d: 0.02, quality: 0.88, sentiment: 0.60, country: "US", sector: "Consumer", industry: "Restaurants" },
  { ticker: "DIS",   companyName: "Walt Disney Co.",       marketCapBillion: 200,  pe: 35, momentum30d: 0.01, quality: 0.78, sentiment: 0.55, country: "US", sector: "Consumer", industry: "Media" },
  { ticker: "NFLX",  companyName: "Netflix Inc.",          marketCapBillion: 280,  pe: 40, momentum30d: 0.07, quality: 0.85, sentiment: 0.70, country: "US", sector: "Tech", industry: "Streaming" },

  // ─── Industrials ────────────────────────────────────────────────────
  { ticker: "BA",    companyName: "Boeing Co.",            marketCapBillion: 110,  pe: 50, momentum30d: -0.04, quality: 0.62, sentiment: 0.38, country: "US", sector: "Industrials", industry: "Aerospace" },
  { ticker: "CAT",   companyName: "Caterpillar Inc.",      marketCapBillion: 170,  pe: 16, momentum30d: 0.04, quality: 0.85, sentiment: 0.62, country: "US", sector: "Industrials", industry: "Heavy Machinery" },
  { ticker: "GE",    companyName: "General Electric",      marketCapBillion: 180,  pe: 35, momentum30d: 0.06, quality: 0.82, sentiment: 0.65, country: "US", sector: "Industrials", industry: "Conglomerate" },
  { ticker: "HON",   companyName: "Honeywell Intl.",       marketCapBillion: 140,  pe: 22, momentum30d: 0.03, quality: 0.86, sentiment: 0.60, country: "US", sector: "Industrials", industry: "Conglomerate" },
  { ticker: "UPS",   companyName: "United Parcel Service", marketCapBillion: 110,  pe: 18, momentum30d: 0.02, quality: 0.83, sentiment: 0.55, country: "US", sector: "Industrials", industry: "Logistics" },

  // ─── REIT / Utilities / Materials ──────────────────────────────────
  { ticker: "PLD",   companyName: "Prologis Inc.",         marketCapBillion: 110,  pe: 30, momentum30d: 0.02, quality: 0.84, sentiment: 0.58, country: "US", sector: "REIT", industry: "Industrial REIT" },
  { ticker: "AMT",   companyName: "American Tower",        marketCapBillion: 90,   pe: 35, momentum30d: 0.01, quality: 0.82, sentiment: 0.55, country: "US", sector: "REIT", industry: "Telecom Tower" },
  { ticker: "NEE",   companyName: "NextEra Energy",        marketCapBillion: 150,  pe: 22, momentum30d: 0.03, quality: 0.84, sentiment: 0.60, country: "US", sector: "Utilities", industry: "Electric Utility" },
  { ticker: "LIN",   companyName: "Linde plc",             marketCapBillion: 200,  pe: 28, momentum30d: 0.04, quality: 0.87, sentiment: 0.62, country: "US", sector: "Materials", industry: "Industrial Gases" },
  { ticker: "FCX",   companyName: "Freeport-McMoRan",      marketCapBillion: 55,   pe: 25, momentum30d: 0.08, quality: 0.72, sentiment: 0.61, country: "US", sector: "Materials", industry: "Mining" },

  // ─── Communications / Telecom ───────────────────────────────────────
  { ticker: "VZ",    companyName: "Verizon Comm.",         marketCapBillion: 175,  pe: 11, momentum30d: 0.02, quality: 0.78, sentiment: 0.48, country: "US", sector: "Telecom", industry: "Wireless Carrier" },
  { ticker: "T",     companyName: "AT&T Inc.",             marketCapBillion: 130,  pe: 10, momentum30d: 0.01, quality: 0.72, sentiment: 0.45, country: "US", sector: "Telecom", industry: "Wireless Carrier" },
  { ticker: "TMUS",  companyName: "T-Mobile US",           marketCapBillion: 220,  pe: 22, momentum30d: 0.04, quality: 0.83, sentiment: 0.62, country: "US", sector: "Telecom", industry: "Wireless Carrier" },
];

/**
 * CN-A 池：沪深300 头部 + 板块代表（科技 / 消费 / 金融 / 新能源 / 医药）。
 */
const CN_A_POOL: UniverseStock[] = [
  // 消费
  { ticker: "600519", companyName: "贵州茅台",        marketCapBillion: 2200, pe: 28, momentum30d: 0.09, quality: 0.95, sentiment: 0.72, country: "CN", sector: "Consumer", industry: "Liquor" },
  { ticker: "000858", companyName: "五粮液",          marketCapBillion: 650,  pe: 21, momentum30d: 0.06, quality: 0.88, sentiment: 0.64, country: "CN", sector: "Consumer", industry: "Liquor" },
  { ticker: "600887", companyName: "伊利股份",        marketCapBillion: 180,  pe: 18, momentum30d: 0.02, quality: 0.84, sentiment: 0.58, country: "CN", sector: "Consumer", industry: "Dairy" },
  { ticker: "603288", companyName: "海天味业",        marketCapBillion: 220,  pe: 35, momentum30d: 0.01, quality: 0.86, sentiment: 0.55, country: "CN", sector: "Consumer", industry: "Food" },
  // 新能源 / 半导体
  { ticker: "300750", companyName: "宁德时代",        marketCapBillion: 980,  pe: 24, momentum30d: 0.12, quality: 0.90, sentiment: 0.70, country: "CN", sector: "Tech", industry: "Batteries" },
  { ticker: "002594", companyName: "比亚迪",          marketCapBillion: 720,  pe: 22, momentum30d: 0.10, quality: 0.87, sentiment: 0.74, country: "CN", sector: "Consumer", industry: "Auto/EV" },
  { ticker: "002460", companyName: "赣锋锂业",        marketCapBillion: 70,   pe: 25, momentum30d: 0.05, quality: 0.74, sentiment: 0.58, country: "CN", sector: "Materials", industry: "Lithium" },
  { ticker: "688981", companyName: "中芯国际",        marketCapBillion: 360,  pe: 60, momentum30d: 0.08, quality: 0.78, sentiment: 0.66, country: "CN", sector: "Tech", industry: "Semiconductors" },
  { ticker: "603501", companyName: "韦尔股份",        marketCapBillion: 130,  pe: 45, momentum30d: 0.09, quality: 0.76, sentiment: 0.70, country: "CN", sector: "Tech", industry: "Semiconductors" },
  { ticker: "002475", companyName: "立讯精密",        marketCapBillion: 220,  pe: 22, momentum30d: 0.06, quality: 0.82, sentiment: 0.64, country: "CN", sector: "Tech", industry: "Electronics" },
  { ticker: "300433", companyName: "蓝思科技",        marketCapBillion: 100,  pe: 20, momentum30d: 0.04, quality: 0.74, sentiment: 0.55, country: "CN", sector: "Tech", industry: "Electronics" },
  // 金融
  { ticker: "601318", companyName: "中国平安",        marketCapBillion: 820,  pe: 9,  momentum30d: 0.03, quality: 0.84, sentiment: 0.52, country: "CN", sector: "Financials", industry: "Insurance" },
  { ticker: "600036", companyName: "招商银行",        marketCapBillion: 930,  pe: 8,  momentum30d: 0.02, quality: 0.86, sentiment: 0.49, country: "CN", sector: "Financials", industry: "Banks" },
  { ticker: "601398", companyName: "工商银行",        marketCapBillion: 1900, pe: 6,  momentum30d: 0.01, quality: 0.80, sentiment: 0.45, country: "CN", sector: "Financials", industry: "Banks" },
  { ticker: "601288", companyName: "农业银行",        marketCapBillion: 1700, pe: 6,  momentum30d: 0.01, quality: 0.78, sentiment: 0.44, country: "CN", sector: "Financials", industry: "Banks" },
  { ticker: "601628", companyName: "中国人寿",        marketCapBillion: 800,  pe: 8,  momentum30d: 0.02, quality: 0.79, sentiment: 0.48, country: "CN", sector: "Financials", industry: "Insurance" },
  // 医药
  { ticker: "300760", companyName: "迈瑞医疗",        marketCapBillion: 350,  pe: 28, momentum30d: 0.03, quality: 0.86, sentiment: 0.60, country: "CN", sector: "Healthcare", industry: "Medical Devices" },
  { ticker: "600276", companyName: "恒瑞医药",        marketCapBillion: 300,  pe: 50, momentum30d: 0.02, quality: 0.82, sentiment: 0.55, country: "CN", sector: "Healthcare", industry: "Pharma" },
  { ticker: "002007", companyName: "华兰生物",        marketCapBillion: 40,   pe: 25, momentum30d: -0.01, quality: 0.74, sentiment: 0.48, country: "CN", sector: "Healthcare", industry: "Biotech" },
  // 能源 / 工业
  { ticker: "601857", companyName: "中国石油",        marketCapBillion: 1400, pe: 9,  momentum30d: 0.04, quality: 0.76, sentiment: 0.50, country: "CN", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "600028", companyName: "中国石化",        marketCapBillion: 700,  pe: 9,  momentum30d: 0.03, quality: 0.74, sentiment: 0.48, country: "CN", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "601985", companyName: "中国核电",        marketCapBillion: 140,  pe: 14, momentum30d: 0.02, quality: 0.78, sentiment: 0.52, country: "CN", sector: "Utilities", industry: "Nuclear" },
  // 互联网（A 股侧）/ 科技
  { ticker: "002230", companyName: "科大讯飞",        marketCapBillion: 110,  pe: 80, momentum30d: 0.08, quality: 0.76, sentiment: 0.70, country: "CN", sector: "Tech", industry: "AI/Software" },
  { ticker: "300059", companyName: "东方财富",        marketCapBillion: 220,  pe: 28, momentum30d: 0.05, quality: 0.80, sentiment: 0.62, country: "CN", sector: "Financials", industry: "Online Brokerage" },
  { ticker: "002415", companyName: "海康威视",        marketCapBillion: 320,  pe: 20, momentum30d: 0.04, quality: 0.85, sentiment: 0.58, country: "CN", sector: "Tech", industry: "Security Tech" },
  { ticker: "603259", companyName: "药明康德",        marketCapBillion: 150,  pe: 25, momentum30d: 0.02, quality: 0.83, sentiment: 0.56, country: "CN", sector: "Healthcare", industry: "Pharma CDMO" },
];

/**
 * HK 池：恒生科技 + 恒指头部。
 */
const HK_POOL: UniverseStock[] = [
  { ticker: "0700.HK", companyName: "腾讯控股",       marketCapBillion: 3800, pe: 22, momentum30d: 0.05, quality: 0.91, sentiment: 0.66, country: "HK", sector: "Tech", industry: "Internet/Gaming" },
  { ticker: "9988.HK", companyName: "阿里巴巴",       marketCapBillion: 1500, pe: 14, momentum30d: 0.04, quality: 0.78, sentiment: 0.58, country: "HK", sector: "Tech", industry: "E-Commerce" },
  { ticker: "3690.HK", companyName: "美团",           marketCapBillion: 800,  pe: 35, momentum30d: 0.06, quality: 0.76, sentiment: 0.62, country: "HK", sector: "Tech", industry: "Local Services" },
  { ticker: "9618.HK", companyName: "京东集团",       marketCapBillion: 400,  pe: 12, momentum30d: 0.03, quality: 0.72, sentiment: 0.54, country: "HK", sector: "Tech", industry: "E-Commerce" },
  { ticker: "1810.HK", companyName: "小米集团",       marketCapBillion: 350,  pe: 20, momentum30d: 0.10, quality: 0.78, sentiment: 0.72, country: "HK", sector: "Tech", industry: "Consumer Electronics" },
  { ticker: "9999.HK", companyName: "网易",           marketCapBillion: 580,  pe: 16, momentum30d: 0.04, quality: 0.82, sentiment: 0.60, country: "HK", sector: "Tech", industry: "Internet/Gaming" },
  { ticker: "2318.HK", companyName: "中国平安",       marketCapBillion: 820,  pe: 9,  momentum30d: 0.03, quality: 0.84, sentiment: 0.52, country: "HK", sector: "Financials", industry: "Insurance" },
  { ticker: "0939.HK", companyName: "建设银行",       marketCapBillion: 1900, pe: 5,  momentum30d: 0.01, quality: 0.80, sentiment: 0.44, country: "HK", sector: "Financials", industry: "Banks" },
  { ticker: "1398.HK", companyName: "工商银行",       marketCapBillion: 1900, pe: 6,  momentum30d: 0.01, quality: 0.80, sentiment: 0.45, country: "HK", sector: "Financials", industry: "Banks" },
  { ticker: "3988.HK", companyName: "中国银行",       marketCapBillion: 1500, pe: 5,  momentum30d: 0.01, quality: 0.78, sentiment: 0.43, country: "HK", sector: "Financials", industry: "Banks" },
  { ticker: "0883.HK", companyName: "中国海洋石油",   marketCapBillion: 800,  pe: 7,  momentum30d: 0.04, quality: 0.76, sentiment: 0.52, country: "HK", sector: "Energy", industry: "Oil & Gas" },
  { ticker: "1024.HK", companyName: "快手",           marketCapBillion: 220,  pe: 22, momentum30d: 0.05, quality: 0.72, sentiment: 0.62, country: "HK", sector: "Tech", industry: "Short Video" },
  { ticker: "2382.HK", companyName: "舜宇光学科技",   marketCapBillion: 60,   pe: 30, momentum30d: 0.06, quality: 0.78, sentiment: 0.64, country: "HK", sector: "Tech", industry: "Optical Components" },
  { ticker: "0992.HK", companyName: "联想集团",       marketCapBillion: 130,  pe: 15, momentum30d: 0.07, quality: 0.76, sentiment: 0.66, country: "HK", sector: "Tech", industry: "PC/Hardware" },
];

const CRYPTO_POOL: UniverseStock[] = [
  { ticker: "BTC-USD", companyName: "Bitcoin",       marketCapBillion: 1300, pe: 0, momentum30d: 0.08, quality: 0.70, sentiment: 0.78, country: "CRYPTO", sector: "Crypto", industry: "L1 Coin" },
  { ticker: "ETH-USD", companyName: "Ethereum",      marketCapBillion: 320,  pe: 0, momentum30d: 0.05, quality: 0.68, sentiment: 0.70, country: "CRYPTO", sector: "Crypto", industry: "L1 Coin" },
  { ticker: "SOL-USD", companyName: "Solana",        marketCapBillion: 80,   pe: 0, momentum30d: 0.12, quality: 0.62, sentiment: 0.76, country: "CRYPTO", sector: "Crypto", industry: "L1 Coin" },
];

export const STOCK_UNIVERSE: UniverseStock[] = [
  ...US_POOL,
  ...CN_A_POOL,
  ...HK_POOL,
  ...CRYPTO_POOL,
];

export function getUniverseStats(): { total: number; byCountry: Record<string, number>; bySector: Record<string, number> } {
  const byCountry: Record<string, number> = {};
  const bySector: Record<string, number> = {};
  for (const s of STOCK_UNIVERSE) {
    byCountry[s.country] = (byCountry[s.country] ?? 0) + 1;
    bySector[s.sector] = (bySector[s.sector] ?? 0) + 1;
  }
  return { total: STOCK_UNIVERSE.length, byCountry, bySector };
}
