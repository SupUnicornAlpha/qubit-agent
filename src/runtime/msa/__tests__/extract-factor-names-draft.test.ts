import { describe, expect, test } from "bun:test";
import { extractFactorNamesFromDraft } from "../analyst-team-pipeline";

describe("extractFactorNamesFromDraft", () => {
  test("提取加粗因子名（典型 markdown 编号列表）", () => {
    const draft = `## 因子方向草稿

1. **MOM_20**：动量因子 20 日收益排序
   数据依赖：klines
   检验指标：IC, RankIC
2. **PE_REVERSAL**：低估反转
   数据依赖：fundamentals
3. **news_intensity**: 新闻强度
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).toContain("MOM_20");
    expect(names).toContain("PE_REVERSAL");
    expect(names).toContain("news_intensity");
  });

  test("无加粗时取冒号前的首段", () => {
    const draft = `
- MOM_5: 5 日动量
- vol_breakout：波动率突破
- TREND_STRENGTH（趋势强度）— 技术面
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).toContain("MOM_5");
    expect(names).toContain("vol_breakout");
    expect(names).toContain("TREND_STRENGTH");
  });

  test("跳过纯中文标题与无效内容", () => {
    const draft = `
1. **动量类**：建议研究方向 A
2. **MOM_20**：A 项实际因子
3. 因为信息不足
`;
    const names = extractFactorNamesFromDraft(draft);
    /** "动量类"纯中文，规则要求含 alnum，应被跳过 */
    expect(names).not.toContain("动量类");
    expect(names).toContain("MOM_20");
    /** "因为信息不足"不是 编号开头，应被跳过 */
    expect(names).not.toContain("因为信息不足");
  });

  test("空草稿返回空数组", () => {
    expect(extractFactorNamesFromDraft("")).toEqual([]);
    expect(extractFactorNamesFromDraft("   \n\n")).toEqual([]);
  });

  test("去重 + 限制最多 8 条", () => {
    /**
     * T1.3 后收紧 length ≥ 3，原 fixture `F1..F15` 被 stop-word 长度过滤，
     * 改成 `FCT_1..FCT_15` 模拟真因子命名（更接近线上行为）。
     */
    const items = Array.from({ length: 15 }, (_, i) => `${i + 1}. **FCT_${i + 1}**：desc`).join("\n");
    const names = extractFactorNamesFromDraft(items);
    expect(names.length).toBe(8);
  });

  test("LLM 用中文项目符号 `、` 也能识别", () => {
    const draft = `
1、**ALPHA_1**：第一个
2、**ALPHA_2**：第二个
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).toContain("ALPHA_1");
    expect(names).toContain("ALPHA_2");
  });

  /**
   * B+ Phase T1.3 回归用例（基于 wf 35d357c8 / 8f527eab / d5b337e6 实测产生的脏数据）。
   *
   * 这些"被错抓为因子名"的字符串都是 LLM 写的叙述性文本中的下游 tool 名 /
   * 角色名 / ticker / 技术指标名，不是真正的因子名。它们一旦被写到
   * factor_definition 表里，会污染 factor.list 输出 + 占用 unique-name slot。
   */
  test("stop-word 黑名单：排除分析师角色 / 技术指标 / ticker 字面 / tool 名", () => {
    const draft = `
1. **analyst_options**：跟踪 IV / OI（实际是要调的下游分析师角色，不是因子）
2. **analyst_fundamental_filing**：财报披露事件（角色名）
3. **SMA20**：20 日均线（技术指标，不是因子定义）
4. **SMA60**：60 日均线
5. **RSI14**：14 日 RSI（技术指标）
6. **MACD**：MACD 指标
7. **EMA12**：12 日 EMA
8. **ticker**：股票代号占位（这只是 placeholder 不是因子）
9. **AAPL**：单一 ticker（不该当因子名）
10. **VWAP**：成交量加权均价（技术指标）
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).not.toContain("analyst_options");
    expect(names).not.toContain("analyst_fundamental_filing");
    expect(names).not.toContain("SMA20");
    expect(names).not.toContain("SMA60");
    expect(names).not.toContain("RSI14");
    expect(names).not.toContain("MACD");
    expect(names).not.toContain("EMA12");
    expect(names).not.toContain("ticker");
    expect(names).not.toContain("AAPL");
    expect(names).not.toContain("VWAP");
    /** 全部被过滤后应该是空（这个 draft 没有真因子名） */
    expect(names.length).toBe(0);
  });

  test("stop-word 与真因子混合：保留真因子 + 排除脏数据", () => {
    const draft = `
1. **SMA20**：20 日均线（技术指标，应排除）
2. **MOM_20**：20 日动量 z-score 因子（真因子，应保留）
3. **ticker**：占位（应排除）
4. **vol_breakout**：波动率突破因子（应保留）
5. **analyst_macro**：宏观分析师角色（应排除）
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).toContain("MOM_20");
    expect(names).toContain("vol_breakout");
    expect(names).not.toContain("SMA20");
    expect(names).not.toContain("ticker");
    expect(names).not.toContain("analyst_macro");
  });

  test("长度过短的候选（< 3）应被排除", () => {
    const draft = `
1. **AI**：太短，不是因子
2. **MOM_30**：合法
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).not.toContain("AI");
    expect(names).toContain("MOM_30");
  });

  test("ticker 大写黑名单：常见 US/CN ticker 不该被当因子", () => {
    const draft = `
1. **NVDA**：候选 ticker
2. **GOOGL**：候选 ticker
3. **600519**：候选 ticker
4. **TSLA**：候选 ticker
5. **MY_FACTOR_1**：真因子
`;
    const names = extractFactorNamesFromDraft(draft);
    expect(names).not.toContain("NVDA");
    expect(names).not.toContain("GOOGL");
    expect(names).not.toContain("TSLA");
    expect(names).toContain("MY_FACTOR_1");
  });
});
