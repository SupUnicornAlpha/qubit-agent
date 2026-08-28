import { resolveMcpStdioArgv } from "../src/runtime/mcp/package-manager";
import { callMcpStdioTool, killMcpStdioPool } from "../src/runtime/mcp/stdio-session";

const resolved = await resolveMcpStdioArgv(["npx", "-y", "mcp-financex@1.0.11"]);
const key = "spawn-probe";
const t0 = Date.now();
try {
  await callMcpStdioTool({
    serverKey: key,
    argv: resolved.argv,
    cwd: resolved.installDir,
    toolName: "get_quote",
    arguments: { symbol: "AAPL" },
    requestTimeoutMs: 60_000,
  });
  console.log("ok", Date.now() - t0);
} catch (e) {
  const msg = (e as Error).message;
  console.log(
    /INTERNAL_ERROR|internal server|crumb/i.test(msg) ? "TOOL_ERR" : "CRASH",
    Date.now() - t0,
    msg.split("\n")[0]
  );
}
killMcpStdioPool(key);
