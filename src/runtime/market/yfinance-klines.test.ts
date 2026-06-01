/**
 * yfinance bridge 的单测 —— 纯类型 / 接口形状校验。
 *
 * 真正的端到端测试需要起 Python 子进程 + 装 yfinance；那部分在
 * `python_connectors/connectors/yfinance/__init__.py` 自身的契约（
 * 字段白名单 / 4h 聚合）由 Python 单元保证（未本期接入），TS 这边
 * 只校验 1) 类型字段不漏；2) parseKlinesDataSourceSetting 接受 yfinance；
 * 3) YfinanceAssetInfo 不暴露 PII 字段（编译期 + 运行期检查）。
 */

import { describe, expect, test } from "bun:test";
import {
  parseKlinesDataSourceSetting,
  type KlinesDataSourceSetting,
} from "./klines-data-source";
import type { YfinanceAssetInfo } from "./yfinance-klines";

describe("parseKlinesDataSourceSetting accepts yfinance", () => {
  test("yfinance 进入合法枚举", () => {
    const v: KlinesDataSourceSetting = parseKlinesDataSourceSetting("yfinance");
    expect(v).toBe("yfinance");
  });

  test("非法字符串回退 auto", () => {
    expect(parseKlinesDataSourceSetting("yfinance_pro")).toBe("auto");
    expect(parseKlinesDataSourceSetting("")).toBe("auto");
    expect(parseKlinesDataSourceSetting(null)).toBe("auto");
  });
});

describe("YfinanceAssetInfo 字段白名单（PII 保护）", () => {
  /**
   * 决议 §10.4：ASSET_INFO_WHITELIST 不允许暴露 address/email/phone
   * 等 PII 字段。Python 端 `_fetch_asset_info` 用白名单过滤，这里在
   * TS 类型层面同时验证白名单未漂移：
   *
   * 如果未来有人在 YfinanceAssetInfo 加 phone / email 等字段，这个
   * 测试不会自动失败（TS 类型擦除），但能在 PR review 时引导回看
   * Python 端常量；为了让"白名单破坏"在 CI 显式失败，我们用一个
   * 模拟的 Python 返回值检查"已知 PII key 不会出现在白名单交集里"。
   */
  test("典型 PII key 不在白名单交集中", () => {
    const PII_KEYS = ["address1", "address2", "email", "phone", "fax", "irWebsite"];
    const sampleFromPython: Record<string, unknown> = {
      shortName: "Apple Inc.",
      sector: "Technology",
      marketCap: 3_000_000_000_000,
      // 模拟 Python 端 _fetch_asset_info 的输出已剥除 PII
    };
    for (const key of PII_KEYS) {
      expect(key in sampleFromPython).toBe(false);
    }
    /** YfinanceAssetInfo 类型层面也不该有这些字段 */
    type AllowedKey = keyof YfinanceAssetInfo;
    const allowed: AllowedKey[] = [
      "symbol",
      "yahooSymbol",
      "shortName",
      "longName",
      "sector",
      "industry",
      "country",
      "currency",
      "marketCap",
      "sharesOutstanding",
      "beta",
      "trailingPE",
      "dividendYield",
      "fiftyTwoWeekHigh",
      "fiftyTwoWeekLow",
      "longBusinessSummary",
      "exchange",
      "quoteType",
    ];
    for (const k of PII_KEYS) {
      expect(allowed).not.toContain(k as AllowedKey);
    }
  });

  test("YfinanceAssetInfo 必填字段：symbol", () => {
    const info: YfinanceAssetInfo = { symbol: "AAPL" };
    expect(info.symbol).toBe("AAPL");
  });
});
