import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { builtinFinancialCapabilities } from "../../runtime/harness/builtin-financial-capabilities";
import { ORCHESTRATOR_PRIME_BASE_TOOLS } from "../../runtime/market/contracts/prime-tool-host-surface";
import { isBuiltinTool } from "../../runtime/tools/builtin-tools";
import { resolveToolAlias } from "../../runtime/tools/tool-catalog";
import { resolveConnectorForTool } from "../../runtime/tools/tool-routes";
import { BRIDGED_TOOLS } from "../prime-bridge.routes";

const CORE_LOCAL_TOOLS = new Set(["update_plan", "agent.invoke"]);
const FINANCIAL_HARNESS_CAPABILITIES = new Set([
  "market.core",
  "market.ide-subscription",
  "market.broker-quote",
  "market.us-options",
  "research.core",
  "execution.paper",
]);

function requiredFinancialHarnessTools(): string[] {
  return builtinFinancialCapabilities
    .filter((capability) => FINANCIAL_HARNESS_CAPABILITIES.has(capability.manifest.id))
    .flatMap((capability) => capability.manifest.tools ?? [])
    .map((tool) => resolveToolAlias(tool.name).resolved)
    .filter(Boolean)
    .sort();
}

function parseRustFallbackTools(source: string): string[] {
  const block = source.match(/DEFAULT_BRIDGED_TOOLS:\s*&\[&str\]\s*=\s*&\[(?<tools>[\s\S]*?)\n\];/);
  const tools = block?.groups?.tools;
  if (!tools) throw new Error("DEFAULT_BRIDGED_TOOLS declaration not found");
  return [...tools.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((tool): tool is string => Boolean(tool))
    .sort();
}

describe("Prime Bridge tool-surface parity", () => {
  test("exposes every non-L0 Prime-base tool to the Bun Bridge", () => {
    const bridged = new Set(BRIDGED_TOOLS);
    const missing = ORCHESTRATOR_PRIME_BASE_TOOLS.filter(
      (tool) => !CORE_LOCAL_TOOLS.has(tool) && !bridged.has(tool)
    );
    expect(missing).toEqual([]);
  });

  test("makes every declared financial Harness tool bridgeable and routable", () => {
    const bridged = new Set(BRIDGED_TOOLS);
    const harnessTools = requiredFinancialHarnessTools();
    expect(harnessTools.filter((tool) => !bridged.has(tool))).toEqual([]);
    expect(
      harnessTools.filter((tool) => !isBuiltinTool(tool) && !resolveConnectorForTool(tool))
    ).toEqual([]);
  });

  test("keeps the Rust fallback list identical to the Bun Bridge list", async () => {
    const rustSource = await readFile(
      new URL("../../../crates/qubit-tool-host/src/legacy.rs", import.meta.url),
      "utf8"
    );
    expect(parseRustFallbackTools(rustSource)).toEqual([...BRIDGED_TOOLS].sort());
  });
});
