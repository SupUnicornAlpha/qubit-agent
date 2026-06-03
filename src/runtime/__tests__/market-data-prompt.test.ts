/**
 * P1-C：PROMPT_MARKET_DATA 必须显式承载"市场识别 + 后缀规约 + 缺省假设"。
 *
 * 评估报告硬伤 H2 修完 P0 之后，剩下的死角是 prompt 自身仍只讲数据工程，
 * 没把 ticker→market 的规约/反 pattern 写进 contract，导致 LLM 在 connector
 * 报错时不知道该回头查 `### 系统市场识别`，反而瞎调 fetch_klines 试错。
 *
 * 这个测试守护几条非空 contract：
 *   - 反 pattern 列表（000001 / BTCUSDT / 7203.T / AAPL+600519 混拉）
 *   - 缺省假设（复权 / 时区 / 周期 / 起止时间 / 多标的单独跑）
 *   - 后缀映射表（.SH/.SZ/.BJ/.HK/.T/.L/CRYPTO）
 *   - 明示「读 ### 系统市场识别 段」
 */
import { describe, expect, test } from "bun:test";
import { PROMPT_MARKET_DATA } from "../seed-agent-prompts";

describe("PROMPT_MARKET_DATA — P1-C 市场识别 + 后缀规约", () => {
  test("明示读 ### 系统市场识别 段作为 ground truth", () => {
    expect(PROMPT_MARKET_DATA).toContain("### 系统市场识别");
    expect(PROMPT_MARKET_DATA).toMatch(/禁止凭\s*ticker\s*字面.*猜.*市场/);
    expect(PROMPT_MARKET_DATA).toContain("ground truth");
  });

  test("后缀映射覆盖 5 个市场 + crypto", () => {
    expect(PROMPT_MARKET_DATA).toContain(".SH");
    expect(PROMPT_MARKET_DATA).toContain(".SZ");
    expect(PROMPT_MARKET_DATA).toContain(".BJ");
    expect(PROMPT_MARKET_DATA).toContain(".HK");
    expect(PROMPT_MARKET_DATA).toContain(".T");
    expect(PROMPT_MARKET_DATA).toContain(".L");
    expect(PROMPT_MARKET_DATA).toContain("CRYPTO");
  });

  test("000001 修复说明在 prompt 里（避免 LLM 训练数据残留误导）", () => {
    expect(PROMPT_MARKET_DATA).toContain("000001");
    expect(PROMPT_MARKET_DATA).toMatch(/平安银行|深\s*A|SZ/);
  });

  test("缺省假设至少含 复权 / 时区 / 周期 / 起止时间 / 多标的", () => {
    expect(PROMPT_MARKET_DATA).toContain("复权");
    expect(PROMPT_MARKET_DATA).toContain("时区");
    expect(PROMPT_MARKET_DATA).toContain("周期");
    expect(PROMPT_MARKET_DATA).toContain("起止时间");
    expect(PROMPT_MARKET_DATA).toContain("多标的");
  });

  test("反 pattern 覆盖：000001 误判 / BTCUSDT 当美股 / 日股抹后缀 / 混拉", () => {
    /** 评估报告 + WF 实测都出现过的 4 种坑 */
    expect(PROMPT_MARKET_DATA).toContain("反 pattern");
    expect(PROMPT_MARKET_DATA).toContain("BTCUSDT");
    expect(PROMPT_MARKET_DATA).toContain("7203.T");
    expect(PROMPT_MARKET_DATA).toMatch(/AAPL.*600519|600519.*AAPL/);
  });

  test("先给市场识别确认 + 直接引用 confidence——避免漏报", () => {
    expect(PROMPT_MARKET_DATA).toContain("先给出市场识别确认");
    expect(PROMPT_MARKET_DATA).toContain("confidence");
  });
});
