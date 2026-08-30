import { describe, expect, test } from "bun:test";
import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import { CapabilityRegistry } from "./capability-registry";
import { type HarnessCapabilityPlugin, HarnessCompositionError } from "./types";

function plugin(
  id: string,
  options: Partial<HarnessCapabilityPlugin["manifest"]> = {}
): HarnessCapabilityPlugin {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      kind: "research",
      description: id,
      ...options,
    },
  };
}

describe("CapabilityRegistry", () => {
  test("composes financial profiles deterministically with dependencies first", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const composition = registry.resolve("us-options-research");

    expect(composition.capabilityIds).toEqual([
      "market.core",
      "market.ide-subscription",
      "market.us-options",
      "research.core",
    ]);
    expect(composition.tools.map((tool) => tool.name)).toContain("fetch_option_chain");
    expect(composition.tools.map((tool) => tool.name)).toContain("market.ide_subscription.get");
  });

  test("composes independent overlays as one conflict-checked graph", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const composition = registry.resolveProfiles([
      "document-production",
      "broker-connected-research",
    ]);

    expect(composition.profileId).toBe("broker-connected-research+document-production");
    expect(composition.capabilityIds).toContain("market.broker-quote");
    expect(composition.capabilityIds).toContain("document.pdf");
  });

  test("keeps mathematical auditing as an independent opt-in profile", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const math = registry.resolve("math-audit");
    expect(math.capabilityIds).toEqual(["math.reasoning"]);
    expect(math.tools.map((tool) => tool.name)).toEqual(["math.derivation.verify"]);
    expect(registry.resolve("financial-research").capabilityIds).not.toContain("math.reasoning");
  });

  test("loads quant integrity as a product-owned overlay and makes paper inherit it", () => {
    const registry = createBuiltinFinancialHarnessRegistry();

    expect(registry.resolve("quant-research-integrity").capabilityIds).toEqual([
      "market.core",
      "market.ide-subscription",
      "research.core",
      "quant.research-integrity",
    ]);
    expect(registry.resolve("paper-trading").capabilityIds).toContain("quant.research-integrity");
    expect(registry.resolve("financial-research").capabilityIds).not.toContain(
      "quant.research-integrity"
    );
  });

  test("rejects a disabled dependency before any capability activates", () => {
    const registry = new CapabilityRegistry()
      .register(plugin("market.core"))
      .register(plugin("market.options", { requires: ["market.core"] }))
      .registerProfile({
        id: "broken",
        title: "broken",
        description: "broken",
        enable: ["market.options"],
      });

    expect(() => registry.resolve("broken")).toThrow(HarnessCompositionError);
    try {
      registry.resolve("broken");
    } catch (error) {
      expect((error as HarnessCompositionError).code).toBe("dependency_disabled");
    }
  });

  test("fails composition before activation when capabilities conflict", () => {
    const registry = new CapabilityRegistry()
      .register(plugin("market.core"))
      .register(plugin("execution.live", { conflictsWith: ["execution.paper"] }))
      .register(plugin("execution.paper"))
      .registerProfile({
        id: "invalid-execution",
        title: "invalid",
        description: "invalid",
        enable: ["market.core", "execution.live", "execution.paper"],
      });

    try {
      registry.resolve("invalid-execution");
      throw new Error("expected conflict");
    } catch (error) {
      expect((error as HarnessCompositionError).code).toBe("capability_conflict");
    }
  });

  test("rolls activated capabilities back in reverse order", async () => {
    const events: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register({
      ...plugin("market.core"),
      activate: () => {
        events.push("market:start");
        return () => {
          events.push("market:dispose");
        };
      },
    });
    registry.register({
      ...plugin("research.core", { requires: ["market.core"] }),
      activate: () => {
        events.push("research:start");
        throw new Error("intentional");
      },
    });
    registry.registerProfile({
      id: "activation-failure",
      title: "activation failure",
      description: "activation failure",
      enable: ["market.core", "research.core"],
    });

    await expect(
      registry.activate({
        profileId: "activation-failure",
        scope: { kind: "workflow", id: "wf_1" },
      })
    ).rejects.toMatchObject({ code: "activation_failed" });
    expect(events).toEqual(["market:start", "research:start", "market:dispose"]);
  });

  test("gives each successful activation an idempotent scope lease", async () => {
    const events: string[] = [];
    const registry = new CapabilityRegistry();
    registry.register({
      ...plugin("market.core"),
      activate: ({ registerDisposer }) => {
        registerDisposer(() => {
          events.push("registered:dispose");
        });
        return () => {
          events.push("returned:dispose");
        };
      },
    });
    registry.registerProfile({
      id: "research",
      title: "research",
      description: "research",
      enable: ["market.core"],
    });

    const lease = await registry.activate({
      profileId: "research",
      scope: { kind: "agent", id: "agent_1" },
    });
    await lease.dispose();
    await lease.dispose();

    expect(lease.disposed).toBe(true);
    expect(events).toEqual(["returned:dispose", "registered:dispose"]);
  });
});
