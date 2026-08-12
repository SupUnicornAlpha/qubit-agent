import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("./quant-studio.css", import.meta.url)).text();
const backtestSource = await Bun.file(
  new URL("../components/quant/BacktestStudioTab.tsx", import.meta.url)
).text();
const evolutionSource = await Bun.file(
  new URL("../components/quant/GenomeEvolutionPanel.tsx", import.meta.url)
).text();

describe("quant expandable panels", () => {
  test("keeps Gate and genome panels out of flex shrink clipping", () => {
    expect(css).toContain(".qb-quant-expandable-panel");
    expect(css).toContain("flex: 0 0 auto");
    expect(css).toContain("min-height: max-content");
    expect(css).toContain("overflow: visible");
    expect(backtestSource).toContain("qb-quant-gate-panel");
    expect(evolutionSource).toContain("qb-quant-expandable-panel qb-quant-evolution-panel");
  });
});
