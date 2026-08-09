import { describe, expect, test } from "bun:test";
import { compileStrategyContract } from "../contract-service";

/** Infer-name logic lives inside persist helper; smoke via manifest metadata. */
describe("persistCompiledStrategyScript helpers (compile surface)", () => {
  test("set_metadata name is available for persist naming", async () => {
    const code = `
# @param x int 1 demo
def initialize(context):
    context.set_universe(["US:SPY"])
    context.subscribe(frequency="1d", fields=["close"])
    context.set_warmup(3)
    context.set_metadata(name="persist_smoke_name")

def handle_data(context, data):
    pass
`;
    const r = await compileStrategyContract(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.metadata?.name).toBe("persist_smoke_name");
    expect(r.manifest.codeHash.length).toBe(64);
  });
});
