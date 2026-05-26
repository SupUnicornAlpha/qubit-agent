/**
 * P1：secret 剥除 helper 回归测试。
 *
 * 覆盖路径：
 *   - redactHeaders：Record / Headers 两种入参，大小写敏感性，多值 header
 *   - redactPayload：嵌套对象 / 数组 / 循环引用 / Date / Error / Buffer
 *   - isSecretKey：白名单匹配（驼峰 / snake / 大写）
 *   - 序列化超长截断：`…[truncated …]`
 */
import { describe, expect, test } from "bun:test";
import {
  isSecretKey,
  redactHeaders,
  redactPayload,
  __TEST_ONLY__,
} from "../redact-secrets";

describe("redactHeaders", () => {
  test("Record 入参剥除 Authorization / cookie / x-api-key", () => {
    const out = redactHeaders({
      Authorization: "Bearer sk-test-xxx",
      "X-API-Key": "abc",
      Cookie: "session=1",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe(__TEST_ONLY__.REDACTED);
    expect(out["X-API-Key"]).toBe(__TEST_ONLY__.REDACTED);
    expect(out.Cookie).toBe(__TEST_ONLY__.REDACTED);
    expect(out["Content-Type"]).toBe("application/json");
  });

  test("Headers 入参也能被处理", () => {
    const headers = new Headers();
    headers.set("authorization", "Bearer sk-x");
    headers.set("x-trace-id", "abc-123");
    const out = redactHeaders(headers);
    expect(out["authorization"]).toBe(__TEST_ONLY__.REDACTED);
    expect(out["x-trace-id"]).toBe("abc-123");
  });

  test("多值 header 用 , 拼接后再判断（仅判断 key 名）", () => {
    const out = redactHeaders({
      "set-cookie": ["a=1", "b=2"],
      Accept: "application/json",
    });
    expect(out["set-cookie"]).toBe(__TEST_ONLY__.REDACTED);
    expect(out.Accept).toBe("application/json");
  });

  test("null / undefined / 空对象不报错", () => {
    expect(redactHeaders(null)).toEqual({});
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders({})).toEqual({});
  });
});

describe("redactPayload", () => {
  test("嵌套对象命中 api_key / apiKey / password 都被替换", () => {
    const input = {
      provider: "openai",
      apiKey: "sk-secret",
      auth: { token: "tok", inner: { password: "p", visible: 1 } },
      env: { OPENAI_API_KEY: "sk-2", PATH: "/usr/bin" },
    };
    const out = redactPayload(input) as Record<string, unknown>;
    const env = out["env"] as Record<string, unknown>;
    const auth = out["auth"] as Record<string, unknown>;
    const inner = auth["inner"] as Record<string, unknown>;
    expect(out["apiKey"]).toBe(__TEST_ONLY__.REDACTED);
    expect(auth["token"]).toBe(__TEST_ONLY__.REDACTED);
    expect(inner["password"]).toBe(__TEST_ONLY__.REDACTED);
    expect(inner["visible"]).toBe(1);
    expect(env["OPENAI_API_KEY"]).toBe(__TEST_ONLY__.REDACTED);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(out["provider"]).toBe("openai");
  });

  test("不修改入参（深拷贝）", () => {
    const input = { apiKey: "secret", value: 1 };
    redactPayload(input);
    expect(input.apiKey).toBe("secret");
    expect(input.value).toBe(1);
  });

  test("循环引用不抛错", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const out = redactPayload(a) as Record<string, unknown>;
    expect(out.name).toBe("a");
    expect(out.self).toBe("[circular]");
  });

  test("Date / Error 被显式序列化", () => {
    const date = new Date("2026-05-26T00:00:00Z");
    const err = new Error("boom");
    const out = redactPayload({ when: date, err }) as Record<string, unknown>;
    expect(out.when).toBe(date.toISOString());
    const serialized = out.err as { name: string; message: string };
    expect(serialized.name).toBe("Error");
    expect(serialized.message).toBe("boom");
  });

  test("Buffer / TypedArray 不展开", () => {
    const buf = Buffer.from("hello");
    const out = redactPayload({ buf }) as Record<string, unknown>;
    expect(typeof out.buf).toBe("string");
    expect(out.buf).toContain("[binary:");
  });

  test("allowKeys 豁免：apiKeyName 应保留原值", () => {
    const out = redactPayload(
      { apiKeyName: "openai-prod", apiKey: "sk-secret" },
      { allowKeys: ["apikeyname"] }
    ) as Record<string, unknown>;
    expect(out.apiKeyName).toBe("openai-prod");
    expect(out.apiKey).toBe(__TEST_ONLY__.REDACTED);
  });

  test("超过 maxBytes 时被截断（结构变成字符串）", () => {
    const big = { msg: "x".repeat(20_000) };
    const out = redactPayload(big, { maxBytes: 1024 });
    expect(typeof out).toBe("string");
    expect(String(out)).toContain("truncated");
  });

  test("数组 / 函数 / 基本类型边界", () => {
    const fn = () => 1;
    const out = redactPayload({ arr: [1, "x", fn], n: 0, b: true }) as Record<string, unknown>;
    const arr = out.arr as unknown[];
    expect(arr[0]).toBe(1);
    expect(arr[1]).toBe("x");
    expect(arr[2]).toBe("[function]");
    expect(out.n).toBe(0);
    expect(out.b).toBe(true);
  });
});

describe("isSecretKey", () => {
  test("命中各种命名变体", () => {
    expect(isSecretKey("apiKey")).toBe(true);
    expect(isSecretKey("api_key")).toBe(true);
    expect(isSecretKey("API_KEY")).toBe(true);
    expect(isSecretKey("OPENAI_API_KEY")).toBe(true);
    expect(isSecretKey("brokerSecret")).toBe(true);
    expect(isSecretKey("refresh_token")).toBe(true);
    expect(isSecretKey("private_key_pem")).toBe(true);
    expect(isSecretKey("authorization")).toBe(true);
  });

  test("不命中业务字段", () => {
    expect(isSecretKey("name")).toBe(false);
    expect(isSecretKey("user")).toBe(false);
    expect(isSecretKey("provider")).toBe(false);
    expect(isSecretKey("model")).toBe(false);
    expect(isSecretKey("count")).toBe(false);
  });
});
