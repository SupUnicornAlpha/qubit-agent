import { describe, expect, test } from "bun:test";
import { parseNpxArgv } from "../package-manager";

/*
 * parseNpxArgv 是 MCP 包管理器的核心解析单元，决定哪些 argv 走"自动安装到 mcp-bin
 * 的绝对路径"路径，哪些原样透传。出 bug 会让所有 stdio MCP 启动方式发生意外变化，
 * 因此把所有边界场景都钉死在单测里。
 */
describe("parseNpxArgv", () => {
  test("普通 npx -y pkg@ver", () => {
    const r = parseNpxArgv(["npx", "-y", "mcp-financex@1.0.11"]);
    expect(r).toEqual({ pkg: "mcp-financex", version: "1.0.11", binArgs: [] });
  });

  test("npx --yes 形式", () => {
    const r = parseNpxArgv(["npx", "--yes", "mcp-financex"]);
    expect(r).toEqual({ pkg: "mcp-financex", binArgs: [] });
  });

  test("scoped 包 @scope/name@ver + 透传 cli 参数", () => {
    const r = parseNpxArgv(["npx", "-y", "@houtini/fmp-mcp@1.1.3", "--port", "8080"]);
    expect(r).toEqual({
      pkg: "@houtini/fmp-mcp",
      version: "1.1.3",
      binArgs: ["--port", "8080"],
    });
  });

  test("scoped 包不带版本号", () => {
    const r = parseNpxArgv(["npx", "-y", "@modelcontextprotocol/server-everything"]);
    expect(r).toEqual({ pkg: "@modelcontextprotocol/server-everything", binArgs: [] });
  });

  test("绝对路径 npx 也识别（windows / 非默认 PATH 情况）", () => {
    const r = parseNpxArgv(["/usr/local/bin/npx", "-y", "foo@1.0.0"]);
    expect(r).toEqual({ pkg: "foo", version: "1.0.0", binArgs: [] });
  });

  test("非 npx：返回 null", () => {
    expect(parseNpxArgv(["uvx", "mcp-server"])).toBeNull();
    expect(parseNpxArgv(["python3", "-m", "mcp_server"])).toBeNull();
    expect(parseNpxArgv(["bun", "run", "x.ts"])).toBeNull();
  });

  test("npx 无可识别 token：返回 null", () => {
    expect(parseNpxArgv(["npx"])).toBeNull();
    expect(parseNpxArgv(["npx", "-y"])).toBeNull();
    expect(parseNpxArgv(["npx", "--yes", "--silent"])).toBeNull();
  });

  test("多个 flag 之后才是包名", () => {
    const r = parseNpxArgv(["npx", "--yes", "--quiet", "foo-bar@2.0.0", "arg1"]);
    expect(r).toEqual({ pkg: "foo-bar", version: "2.0.0", binArgs: ["arg1"] });
  });
});
