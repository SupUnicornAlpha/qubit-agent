import { describe, expect, test } from "bun:test";
import { attachMarketGovernanceTools } from "./resolve-effective-tools";

describe("attachMarketGovernanceTools", () => {
  test("upgrades historical market-capable agent definitions at runtime", () => {
    const tools = attachMarketGovernanceTools("research", ["fetch_klines", "factor.compute"]);
    expect(tools).toContain("market.resolve_symbol");
    expect(tools).toContain("market.data_sources");
    expect(tools).toContain("market.readiness");
  });

  test("keeps unrelated specialist tool surfaces narrow", () => {
    expect(attachMarketGovernanceTools("risk", ["evaluate_risk"])).toEqual(["evaluate_risk"]);
  });
});
