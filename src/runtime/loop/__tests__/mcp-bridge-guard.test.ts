import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HIGH_RISK_DENY,
  globToRegExp,
  isToolPermitted,
  parseToolPatternEnv,
} from "../mcp-bridge-guard";

describe("globToRegExp", () => {
  test("* 通配，其余字面（含 . 和 /）", () => {
    expect(globToRegExp("execution/*").test("execution/submit_order")).toBe(true);
    expect(globToRegExp("execution/*").test("market/fetch")).toBe(false);
    expect(globToRegExp("*/order.*").test("svc/order.create_intent")).toBe(true);
    // `.` 是字面，不应把 orderXcreate 当成命中
    expect(globToRegExp("*/order.*").test("svc/orderXcreate")).toBe(false);
    expect(globToRegExp("*broker*/*").test("ibkr-broker/x")).toBe(true);
  });

  test("大小写不敏感", () => {
    expect(globToRegExp("*/submit_order").test("X/SUBMIT_ORDER")).toBe(true);
  });
});

describe("isToolPermitted — 高危默认拒绝", () => {
  test("下单 / 撤单 / 实盘 / 划转 默认被拦", () => {
    for (const [server, tool] of [
      ["trading", "order.create_intent"],
      ["exec", "submit_order"],
      ["exec", "cancel_order"],
      ["execution", "anything"],
      ["ibkr-broker", "place"],
      ["bank", "withdraw_funds"],
      ["bank", "transfer"],
      ["x", "live_execute"],
    ] as const) {
      const r = isToolPermitted({ serverName: server, toolName: tool });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("denied by policy");
    }
  });

  test("普通数据工具放行", () => {
    expect(isToolPermitted({ serverName: "market", toolName: "fetch_klines" }).ok).toBe(true);
    expect(isToolPermitted({ serverName: "news", toolName: "get_sentiment" }).ok).toBe(true);
  });
});

describe("isToolPermitted — allow 白名单", () => {
  test("白名单非空时必须命中", () => {
    const allow = ["market/*", "news/get_sentiment"];
    expect(isToolPermitted({ serverName: "market", toolName: "fetch_klines", allow }).ok).toBe(
      true
    );
    expect(isToolPermitted({ serverName: "news", toolName: "get_sentiment", allow }).ok).toBe(true);
    const blocked = isToolPermitted({ serverName: "factor", toolName: "compute", allow });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toContain("not in allowlist");
  });

  test("deny 优先于 allow（即便白名单放了高危也拦）", () => {
    const r = isToolPermitted({
      serverName: "execution",
      toolName: "submit_order",
      allow: ["execution/*"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("denied by policy");
  });

  test("追加 deny 与默认表合并", () => {
    const r = isToolPermitted({
      serverName: "market",
      toolName: "fetch_klines",
      deny: ["market/fetch_*"],
    });
    expect(r.ok).toBe(false);
  });
});

describe("parseToolPatternEnv", () => {
  test("逗号分隔、去空白、去空项", () => {
    expect(parseToolPatternEnv(" a/* , b/c ,, ")).toEqual(["a/*", "b/c"]);
    expect(parseToolPatternEnv(undefined)).toEqual([]);
    expect(parseToolPatternEnv("")).toEqual([]);
  });
});

describe("DEFAULT_HIGH_RISK_DENY", () => {
  test("覆盖核心高危族", () => {
    const joined = DEFAULT_HIGH_RISK_DENY.join(" ");
    expect(joined).toContain("order.");
    expect(joined).toContain("submit_order");
    expect(joined).toContain("execution/*");
  });
});
