import type { ResearchScopeInput } from "../api/types";

export type ResearchScopeMode = "single" | "basket" | "sector" | "explore";
export type ResearchInstrumentUi = "equity_long" | "equity_short" | "option";

export function parseSymbolList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,，;\s\n]+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0 && s.length <= 24)
    ),
  ];
}

export function buildResearchScopePayload(input: {
  mode: ResearchScopeMode;
  ticker: string;
  basketTickers: string;
  sectorName: string;
  sectorPeers: string;
  exploreTheme?: string;
  exploreCandidates?: string;
  instrument: ResearchInstrumentUi;
  optionUnderlying: string;
  optionContract: string;
  optionExpiry: string;
  optionStrike: string;
  optionRight: "call" | "put" | "";
}): ResearchScopeInput | null {
  const instrument = input.instrument === "option" ? "option" : "equity";
  const positionSide = input.instrument === "equity_short" ? "short" : "long";

  if (input.mode === "explore") {
    const theme = input.exploreTheme?.trim() ?? "";
    const candidates = parseSymbolList(input.exploreCandidates ?? "");
    if (!theme && candidates.length === 0) return null;
    return {
      kind: "explore",
      theme: theme || undefined,
      symbols: candidates.length > 0 ? candidates : undefined,
      instrument,
      positionSide,
    };
  }

  if (input.mode === "basket") {
    const symbols = parseSymbolList(input.basketTickers || input.ticker);
    if (symbols.length === 0) return null;
    return { kind: "basket", symbols, instrument, positionSide };
  }

  if (input.mode === "sector") {
    const sector = input.sectorName.trim();
    const peers = parseSymbolList(input.sectorPeers);
    const symbols = peers.length > 0 ? peers : parseSymbolList(input.ticker);
    if (!sector && symbols.length === 0) return null;
    return {
      kind: "sector",
      sector: sector || "未命名板块",
      symbols: symbols.length > 0 ? symbols : undefined,
      peers: symbols,
      instrument,
      positionSide,
    };
  }

  const sym = input.ticker.trim().toUpperCase();
  if (!sym) return null;

  if (instrument === "option") {
    const underlying = (input.optionUnderlying.trim() || sym).toUpperCase();
    const strike = input.optionStrike.trim() ? Number(input.optionStrike) : undefined;
    return {
      kind: "single",
      symbols: [input.optionContract.trim().toUpperCase() || underlying],
      ticker: input.optionContract.trim().toUpperCase() || underlying,
      instrument: "option",
      positionSide: "long",
      option: {
        underlying,
        contractSymbol: input.optionContract.trim() || undefined,
        expiry: input.optionExpiry.trim() || undefined,
        strike: Number.isFinite(strike) ? strike : undefined,
        right: input.optionRight === "put" ? "put" : input.optionRight === "call" ? "call" : undefined,
      },
    };
  }

  return {
    kind: "single",
    symbols: [sym],
    ticker: sym,
    instrument,
    positionSide,
  };
}

export function scopeModeLabel(mode: ResearchScopeMode): string {
  if (mode === "basket") return "多标的篮子";
  if (mode === "sector") return "板块";
  if (mode === "explore") return "自由探索";
  return "单标的";
}

export function instrumentLabel(i: ResearchInstrumentUi): string {
  if (i === "equity_short") return "股票做空";
  if (i === "option") return "期权";
  return "股票多头";
}

/**
 * 分析提示词模板。按 scope mode + 工具类型给一组开箱即用的"提示骨架"。
 *
 * 设计原则：
 *   - 每条模板都是**完整可执行**的提示，不是"插槽样板" —— 用户填进文本框就能跑
 *   - 触发关键工具调用约束（例如多空、回测、风控签核）
 *   - 显式覆盖容易出错的点（例如"必须验证标的真实存在"、"必须显式给 confidence"）
 */
export type ResearchPromptTemplate = {
  id: string;
  label: string;
  /** 哪些 scope mode 下显示这条模板。空数组 = 所有模式都显示 */
  modes: ResearchScopeMode[];
  /** 哪些工具类型下显示。空数组 = 所有工具类型都显示 */
  instruments: ResearchInstrumentUi[];
  /** 一句话描述，给 UI 显示 */
  summary: string;
  /** 实际提示内容（多行字符串） */
  prompt: string;
};

export const RESEARCH_PROMPT_TEMPLATES: ResearchPromptTemplate[] = [
  {
    id: "single-fundamental-deep-dive",
    label: "单标的深度尽调",
    modes: ["single"],
    instruments: ["equity_long", "equity_short"],
    summary: "盈利质量 / 估值 / 风险三维全面体检",
    prompt: [
      "请对当前标的开展一次「机构投研级深度尽调」：",
      "1. 基本面：近 4 个季度盈利质量（毛利率、营业利润率、ROIC 变化）+ 现金流质量；",
      "2. 估值：当前 forward P/E、PEG、EV/EBITDA 与历史 5 年中位数 / 行业可比公司对比；",
      "3. 技术面：最近 60 个交易日的趋势 / 动量 / 关键支撑阻力位；",
      "4. 情绪：近 30 天新闻情绪、机构持仓变化、做空利息趋势；",
      "5. 风险点：盈利预警、监管 / 诉讼、产品周期、宏观敏感度。",
      "",
      "**输出要求**：每个维度给一段不超过 200 字的结论 + 一个 0-1 之间的小数置信度；最后给出建议（buy/sell/hold）+ 综合置信度。",
    ].join("\n"),
  },
  {
    id: "single-event-driven",
    label: "事件驱动（财报 / 监管 / 重大新闻）",
    modes: ["single"],
    instruments: ["equity_long", "equity_short", "option"],
    summary: "围绕近期催化剂的短期交易机会",
    prompt: [
      "围绕当前标的的**近期催化剂**做事件驱动分析：",
      "1. 列出未来 4 周内可能影响价格的已知事件（财报 / 重大产品发布 / 监管决议 / 行业大会等）；",
      "2. 量化历史相似事件下的隐含波动率 / 实际波动率差；",
      "3. 期权（如可用）：识别合理的策略（buy call / put / straddle / iron condor）+ 行权价 + 到期；",
      "4. 风险：黑天鹅情形、流动性、保证金占用。",
      "",
      "**禁止编造事件**。若数据不足请明确写「需补充」。",
    ].join("\n"),
  },
  {
    id: "basket-relative-strength",
    label: "篮子相对强弱（多空对冲思路）",
    modes: ["basket"],
    instruments: ["equity_long", "equity_short"],
    summary: "在篮子内寻找做多 / 做空候选 + 风险中性组合",
    prompt: [
      "请对篮子内全部标的做**相对强弱排序**：",
      "1. 基本面打分（盈利增速 + 估值合理性）+ 技术面打分（动量 + 波动率）+ 情绪打分；",
      "2. 给出排序，并提出做多前 1-2 名、做空后 1-2 名的对冲组合；",
      "3. 估算 beta、行业暴露与对冲后的预期净敞口；",
      "4. 风险：相关性回归到 1（行业系统性风险）、做空成本、流动性失衡。",
      "",
      "最终交付一张「标的 × 维度」评分表 + 一段策略建议。",
    ].join("\n"),
  },
  {
    id: "sector-rotation",
    label: "板块轮动 / 行业配置",
    modes: ["sector"],
    instruments: ["equity_long", "equity_short"],
    summary: "宏观 regime + 板块内龙头筛选",
    prompt: [
      "围绕当前板块做轮动配置研究：",
      "1. 宏观 regime 判断：本板块在不同 regime（risk-on / risk-off / 滞胀 / 复苏）下的历史 beta；",
      "2. 板块内排序：按 ROIC / 增速 / 估值 / 情绪四维对成分股打分；",
      "3. 推荐 3-5 只代表性标的（含权重建议），并说明剔除了哪些；",
      "4. 风险：政策、汇率、原材料、海外营收占比。",
      "",
      "**显式声明**当前 regime 的判断依据。",
    ].join("\n"),
  },
  {
    id: "explore-theme-discovery",
    label: "主题发现（无标的）",
    modes: ["explore"],
    instruments: ["equity_long", "equity_short", "option"],
    summary: "由 Orchestrator 自主筛选 1-3 个最具机会的标的",
    prompt: [
      "本次为「主题驱动 + 自由探索」研究：",
      "1. 请基于当前主题，结合最近 30 天宏观与行业新闻，**自主筛选**出 1-3 个最具机会的标的；",
      "2. 每个候选标的必须通过 `fetch_klines` 验证真实存在 + 有足够日均成交额；",
      "3. 对入选标的逐个执行基本面 + 技术面 + 情绪面综合评估；",
      "4. 给出「为什么选这几个 + 为什么没选其它」的逻辑链；",
      "5. 风险：主题失效、估值已透支、流动性陷阱、跟风资金回撤。",
      "",
      "**禁止凭印象虚构 ticker**。所有标的须可被数据接口拉到 K 线。",
    ].join("\n"),
  },
  {
    id: "explore-crisis-hedge",
    label: "危机对冲（避险机会扫描）",
    modes: ["explore"],
    instruments: ["equity_long", "equity_short", "option"],
    summary: "扫描当前最有效的避险 / 反向 / 黄金类资产组合",
    prompt: [
      "假设近期市场可能进入 risk-off 阶段，请扫描有效的避险机会：",
      "1. 跨资产候选：黄金 / 美元指数 / 长债 / VIX 衍生品 / 防御性板块（公用事业、必需消费）；",
      "2. 评估每类资产在过去 5 次类似 regime 下的表现（最大回撤、相关性、流动性）；",
      "3. 给出推荐对冲组合 + 仓位建议 + 触发条件（什么时候加仓 / 平仓）；",
      "4. 反面：若 risk-on 持续，对冲成本与机会成本估算。",
    ].join("\n"),
  },
  {
    id: "option-vol-trade",
    label: "期权波动率交易",
    modes: ["single", "basket"],
    instruments: ["option"],
    summary: "围绕 IV / RV 错配的 vol 策略",
    prompt: [
      "围绕期权波动率构建交易：",
      "1. 隐含波动率（IV）当前分位（30/60/90 天） + 期限结构（contango / backwardation）；",
      "2. 历史实现波动率（RV）对比；估算 IV-RV spread；",
      "3. 识别合适的波动率策略：long straddle / short iron condor / calendar spread 等；",
      "4. Greeks：Delta-neutral 入场点 + Gamma / Vega 风险预算；",
      "5. 流动性：bid-ask spread、open interest 验证可执行性。",
    ].join("\n"),
  },
  {
    id: "factor-strategy-pipeline",
    label: "因子 → 策略 → 回测（量化全链路）",
    modes: ["single", "basket", "sector", "explore"],
    instruments: ["equity_long", "equity_short"],
    summary: "从因子构建到完整回测的闭环验证",
    prompt: [
      "请走完一次量化研究闭环：",
      "1. research 角色：基于标的池构建至少 1 个新因子（注册 → compute → autoEvaluate）；",
      "2. 若 IC / RankIC 显著（|IC|>0.03 或 |RankIC|>0.05），晋升为 `active` 状态；",
      "3. backtest 角色：基于该因子写策略（先 strategy.publish_version 拿到 strategy_version_id），再 backtest.run；",
      "4. 报告：Sharpe / MaxDD / 胜率 / 年化换手 + Walk-forward 稳健性；",
      "5. risk 角色：评估实盘可行性（流动性、集中度、合规）。",
      "",
      "**调用顺序约束**：factor.autoEvaluate 之前必须 compute；backtest.run 必须显式带 strategy_version_id。",
    ].join("\n"),
  },
];

/** 按 scope mode + instrument 过滤可用模板 */
export function filterPromptTemplates(
  mode: ResearchScopeMode,
  instrument: ResearchInstrumentUi
): ResearchPromptTemplate[] {
  return RESEARCH_PROMPT_TEMPLATES.filter((t) => {
    if (t.modes.length > 0 && !t.modes.includes(mode)) return false;
    if (t.instruments.length > 0 && !t.instruments.includes(instrument)) return false;
    return true;
  });
}
