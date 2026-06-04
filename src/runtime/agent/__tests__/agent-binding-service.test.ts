import { describe, expect, test } from "bun:test";
import {
  isUserBindableField,
  parseUserOverrides,
  shouldPreserveField,
  USER_BINDABLE_FIELDS,
} from "../agent-binding-service";

/*
 * 这里只覆盖纯函数，避免拉起 sqlite。setAgentDefinitionBindings / clear* 走 DB
 * 的集成由更上层 e2e 测试（mini eval batch）验证；本文件钉死 sentinel 解析 +
 * field whitelist + preserve 判断这三个核心。
 */

describe("parseUserOverrides", () => {
  test("空输入 / null / 非对象 → 空 map", () => {
    expect(parseUserOverrides(undefined)).toEqual({});
    expect(parseUserOverrides(null)).toEqual({});
    expect(parseUserOverrides("")).toEqual({});
    expect(parseUserOverrides(42)).toEqual({});
    expect(parseUserOverrides([])).toEqual({});
  });

  test("JSON 字符串解析", () => {
    expect(parseUserOverrides('{"mcp_servers_json": true}')).toEqual({
      mcp_servers_json: true,
    });
  });

  test("非法 JSON 字符串容错为空 map（read-side 永不抛）", () => {
    expect(parseUserOverrides("not-json")).toEqual({});
    expect(parseUserOverrides("{")).toEqual({});
  });

  test("非 boolean / 非 true 值都被丢弃（防 user 写 1 / 'true' / string 进 DB）", () => {
    expect(
      parseUserOverrides({
        mcp_servers_json: true,
        tools_json: false,
        skills_json: 1,
        subscriptions_json: "true",
      })
    ).toEqual({ mcp_servers_json: true });
  });

  test("未授权字段（如 role / name / id）被丢弃 —— 即使用户硬塞也无效", () => {
    expect(
      parseUserOverrides({
        role: true,
        name: true,
        id: true,
        mcp_servers_json: true,
      })
    ).toEqual({ mcp_servers_json: true });
  });
});

describe("USER_BINDABLE_FIELDS", () => {
  test("白名单覆盖所有 user-modifiable 列，不含 role/name/version/id", () => {
    expect(USER_BINDABLE_FIELDS).toContain("mcp_servers_json");
    expect(USER_BINDABLE_FIELDS).toContain("tools_json");
    expect(USER_BINDABLE_FIELDS).toContain("skills_json");
    expect(USER_BINDABLE_FIELDS).toContain("system_prompt");
    expect(USER_BINDABLE_FIELDS).toContain("llm_provider");
    expect(USER_BINDABLE_FIELDS).toContain("max_iterations");
    expect(USER_BINDABLE_FIELDS).toContain("enabled");

    expect(USER_BINDABLE_FIELDS as readonly string[]).not.toContain("role");
    expect(USER_BINDABLE_FIELDS as readonly string[]).not.toContain("name");
    expect(USER_BINDABLE_FIELDS as readonly string[]).not.toContain("version");
    expect(USER_BINDABLE_FIELDS as readonly string[]).not.toContain("id");
  });
});

describe("isUserBindableField", () => {
  test("校验白名单", () => {
    expect(isUserBindableField("mcp_servers_json")).toBe(true);
    expect(isUserBindableField("role")).toBe(false);
    expect(isUserBindableField("non_existent")).toBe(false);
  });
});

describe("shouldPreserveField", () => {
  test("sentinel=true → 保留", () => {
    expect(shouldPreserveField({ mcp_servers_json: true }, "mcp_servers_json")).toBe(true);
  });

  test("sentinel=false / 缺失 / 不在白名单 → 不保留", () => {
    expect(shouldPreserveField({ mcp_servers_json: false }, "mcp_servers_json")).toBe(false);
    expect(shouldPreserveField({}, "mcp_servers_json")).toBe(false);
    expect(shouldPreserveField({ tools_json: true }, "mcp_servers_json")).toBe(false);
  });

  test("非法 raw（如 string / number）容错为不保留", () => {
    expect(shouldPreserveField("bad-json", "mcp_servers_json")).toBe(false);
    expect(shouldPreserveField(null, "mcp_servers_json")).toBe(false);
    expect(shouldPreserveField(undefined, "mcp_servers_json")).toBe(false);
  });
});
