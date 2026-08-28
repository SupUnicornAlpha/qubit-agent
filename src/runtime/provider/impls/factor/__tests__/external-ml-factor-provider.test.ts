import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildModelFactorExpr,
  parseModelFactorBinding,
} from "../../../model-factor-contract";
import { ExternalMlFactorProvider } from "../external-ml-factor-provider";
import {
  _resetModelFactorAdaptersForTests,
  getModelFactorAdapter,
  listModelFactorAdapterKeys,
  registerModelFactorAdapter,
} from "../model-factor-adapter-registry";

describe("model-factor P0 adapter surface", () => {
  beforeEach(() => {
    _resetModelFactorAdaptersForTests();
  });

  test("builtin http adapter is always registered", () => {
    expect(listModelFactorAdapterKeys()).toContain("http");
    expect(getModelFactorAdapter("http").key).toBe("http");
  });

  test("parseModelFactorBinding normalizes snake_case", () => {
    const binding = parseModelFactorBinding({
      adapter_key: "http",
      model_id: "lgbm_alpha",
      model_version: "2026.08.01",
      adapter_config: { endpoint: "http://127.0.0.1:9/infer" },
      score_transform: "rank",
    });
    expect(binding.adapterKey).toBe("http");
    expect(binding.modelId).toBe("lgbm_alpha");
    expect(binding.scoreTransform).toBe("rank");
    expect(binding.adapterConfig?.endpoint).toBe("http://127.0.0.1:9/infer");
    expect(buildModelFactorExpr(binding)).toBe("model://http/lgbm_alpha@2026.08.01");
  });

  test("custom in-process adapter can be registered and used by external_ml provider", async () => {
    registerModelFactorAdapter({
      key: "unit_mock",
      async infer(req) {
        return {
          ok: true,
          rows: req.symbols.map((symbol) => ({
            symbol,
            date: req.startDate,
            value: 1.5,
          })),
          meta: { from: "unit_mock" },
        };
      },
    });

    const provider = new ExternalMlFactorProvider();
    const result = await provider.compute({
      factorId: "f-test",
      expr: "model://unit_mock/demo@1",
      lang: "ml_score",
      universe: "US",
      symbols: ["AAPL", "MSFT"],
      startDate: "2024-01-02",
      endDate: "2024-01-10",
      definition: {
        modelFactor: {
          adapterKey: "unit_mock",
          modelId: "demo",
          modelVersion: "1",
        },
      },
    });

    expect(result.rows).toEqual([
      { symbol: "AAPL", date: "2024-01-02", value: 1.5 },
      { symbol: "MSFT", date: "2024-01-02", value: 1.5 },
    ]);
    expect(result.meta.rowCount).toBe(2);
    expect(result.meta.modelFactor).toMatchObject({
      adapterKey: "unit_mock",
      modelId: "demo",
      modelVersion: "1",
    });
  });

  test("external_ml returns empty rows with error when binding missing", async () => {
    const provider = new ExternalMlFactorProvider();
    const result = await provider.compute({
      expr: "model://missing/x@1",
      lang: "ml_score",
      universe: "US",
      symbols: ["AAPL"],
      startDate: "2024-01-02",
      endDate: "2024-01-10",
    });
    expect(result.rows).toEqual([]);
    expect(String(result.meta.error)).toContain("modelFactor");
  });

  test("snapshot-bound infer receives dataset on adapter", async () => {
    let sawSnapshot: string | undefined;
    registerModelFactorAdapter({
      key: "snap_mock",
      async infer(req) {
        sawSnapshot = req.datasetSnapshotId;
        return { ok: true, rows: [] };
      },
    });
    const provider = new ExternalMlFactorProvider();
    await provider.compute({
      expr: "model://snap_mock/m@1",
      lang: "ml_score",
      universe: "US",
      symbols: ["AAPL"],
      startDate: "2024-01-02",
      endDate: "2024-01-10",
      definition: {
        modelFactor: { adapterKey: "snap_mock", modelId: "m", modelVersion: "1" },
      },
      dataset: {
        snapshotId: "snap-1",
        dataRef: "ref-1",
        asOf: "2024-01-10",
        timeframe: "1d",
        sourceIds: ["test"],
        barsBySymbol: {
          AAPL: [
            {
              timestamp: "2024-01-02T00:00:00Z",
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              turnover: 1,
            },
          ],
        },
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "not_verified",
          pointInTime: "not_verified",
          limitations: ["unit_test"],
        },
      },
    });
    expect(sawSnapshot).toBe("snap-1");
  });
});
