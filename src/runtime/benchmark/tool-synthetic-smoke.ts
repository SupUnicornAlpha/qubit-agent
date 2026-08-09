import { isBuiltinTool } from "../tools/builtin-tools";
import { buildToolCatalog } from "../tools/tool-catalog";
import { getToolContract } from "../tools/tool-contract-registry";
import { resolveConnectorForTool } from "../tools/tool-routes";

export interface ToolSyntheticSmokeResult {
  name: string;
  kind: "builtin" | "connector" | "dynamic" | "mcp_server";
  ok: boolean;
  probe: string;
  detail: string;
  contractCovered: boolean;
}

const CRITICAL_CONTRACT_TOOLS = new Set([
  "fetch_fundamentals",
  "fetch_quote",
  "fetch_klines",
  "factor.compute",
  "factor.promote_backtest",
  "backtest.run",
  "strategy.compose",
  "strategy.compile",
  "factor.mine.llm",
  "order.create_intent",
]);

/**
 * Deterministic, side-effect-free smoke for every globally exposed tool. It
 * validates that the advertised name resolves to executable code and that the
 * historically high-risk parameter surfaces have a ToolContract.
 */
export function runGlobalToolSyntheticSmoke(input?: {
  topologyTools?: readonly string[];
  enabledMcpServers?: readonly string[];
}): ToolSyntheticSmokeResult[] {
  const results: ToolSyntheticSmokeResult[] = [];
  for (const entry of buildToolCatalog()) {
    const contractCovered = Boolean(getToolContract(entry.name));
    if (entry.kind === "connector") {
      const connector = resolveConnectorForTool(entry.name);
      const ok = Boolean(connector) && (!CRITICAL_CONTRACT_TOOLS.has(entry.name) || contractCovered);
      results.push({
        name: entry.name,
        kind: "connector",
        ok,
        probe: "connector_route",
        detail: connector ? `route=${connector}` : "missing connector route",
        contractCovered,
      });
      continue;
    }
    const registered = isBuiltinTool(entry.name);
    const ok = registered && (!CRITICAL_CONTRACT_TOOLS.has(entry.name) || contractCovered);
    results.push({
      name: entry.name,
      kind: "builtin",
      ok,
      probe: "builtin_registration",
      detail: registered ? "registered" : "missing builtin handler",
      contractCovered,
    });
  }

  results.push({
    name: "agent.invoke",
    kind: "dynamic",
    ok: true,
    probe: "rust_core_l0",
    detail: "native Core L0 tool",
    contractCovered: true,
  });
  for (const name of input?.topologyTools ?? []) {
    results.push({
      name,
      kind: "dynamic",
      ok: name.startsWith("call_team_") && name.length > "call_team_".length,
      probe: "topology_facade",
      detail: "generated typed team dispatch",
      contractCovered: true,
    });
  }
  for (const server of input?.enabledMcpServers ?? []) {
    results.push({
      name: `mcp:${server}:*`,
      kind: "mcp_server",
      ok: Boolean(server.trim()),
      probe: "enabled_server_binding",
      detail: "individual MCP tools are health-scored from benchmark tool_call_log",
      contractCovered: true,
    });
  }
  return results.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
