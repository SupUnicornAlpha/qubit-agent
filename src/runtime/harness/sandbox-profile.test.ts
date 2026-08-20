import { describe, expect, test } from "bun:test";
import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import { evaluateCapabilitySandbox, getBuiltinHarnessSandboxProfile } from "./sandbox-profile";

function profile(id: string) {
  const value = getBuiltinHarnessSandboxProfile(id);
  if (!value) throw new Error(`missing sandbox profile ${id}`);
  return value;
}

describe("Harness sandbox profiles", () => {
  test("requires workspace write and approval before document production", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const pdf = registry.getManifest("document.pdf");
    if (!pdf) throw new Error("missing document.pdf");

    expect(evaluateCapabilitySandbox(pdf, profile("read-only"))).toMatchObject({
      allowed: false,
      reasons: [
        "requires workspace-write filesystem access",
        "requires interactive approval, but the sandbox profile does not permit it",
      ],
    });
    expect(evaluateCapabilitySandbox(pdf, profile("workspace-write"))).toEqual({
      allowed: true,
      requiredApprovals: ["workspace-write", "external-plugin"],
    });
  });

  test("never silently runs workspace development tools on the host", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const developer = registry.getManifest("developer.workspace");
    if (!developer) throw new Error("missing developer.workspace");

    expect(evaluateCapabilitySandbox(developer, profile("workspace-write"))).toMatchObject({
      allowed: false,
      reasons: ["requires allowlisted process execution", "requires guarded container execution"],
    });
    expect(evaluateCapabilitySandbox(developer, profile("guarded-container"))).toEqual({
      allowed: true,
      requiredApprovals: ["workspace-write", "command-execution", "external-plugin"],
    });
  });

  test("keeps generic extension capabilities opt-in instead of adding them to financial research", () => {
    const registry = createBuiltinFinancialHarnessRegistry();
    const financial = registry.resolve("financial-research");
    const documents = registry.resolve("document-production");

    expect(financial.capabilityIds).not.toContain("document.pdf");
    expect(documents.capabilityIds).toEqual([
      "data.spreadsheet",
      "document.office",
      "document.pdf",
      "market.core",
      "market.ide-subscription",
      "research.core",
    ]);
  });
});
