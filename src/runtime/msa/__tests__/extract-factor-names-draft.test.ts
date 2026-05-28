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
    const items = Array.from({ length: 15 }, (_, i) => `${i + 1}. **F${i + 1}**：desc`).join("\n");
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
});
