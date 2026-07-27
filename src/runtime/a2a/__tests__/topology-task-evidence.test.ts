import { describe, expect, test } from "bun:test";
import { extractTopologyTaskEvidence } from "../a2a-react-task";

describe("topology task evidence", () => {
  test("extracts compact verified market data from successful connector bars", () => {
    const evidence = extractTopologyTaskEvidence("market_data", {
      toolCalls: [
        { toolName: "market.resolve_symbol", status: "success" },
        { toolName: "qubit-data/fetch_klines", status: "success" },
      ],
      observations: [
        {
          connectorResult: [
            {
              symbol: "688981",
              exchange: "SH",
              close: 140,
              timestamp: "2026-07-23T00:00:00+08:00",
            },
            {
              symbol: "688981",
              exchange: "SH",
              close: 143.73,
              timestamp: "2026-07-24T00:00:00+08:00",
            },
          ],
        },
      ],
    });

    expect(evidence).toEqual({
      kind: "market_data",
      verified: true,
      sourceTool: "qubit-data/fetch_klines",
      result: {
        dataAvailable: true,
        barCount: 2,
        symbol: "688981",
        exchange: "SH",
        latestClose: 143.73,
        asof: "2026-07-24T00:00:00+08:00",
      },
    });
  });

  test("does not salvage empty market data", () => {
    expect(
      extractTopologyTaskEvidence("market_data", {
        toolCalls: [{ toolName: "qubit-data/fetch_klines", status: "success" }],
        observations: [{ connectorResult: [] }],
      })
    ).toBeNull();
  });
});
