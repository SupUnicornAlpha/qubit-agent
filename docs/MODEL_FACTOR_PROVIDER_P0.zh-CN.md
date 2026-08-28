# Model Factor Provider 对接（P0）

> 目标：让外部训练平台 / 实时模型打分服务能接到 QUBIT 的因子计算面。  
> **不做**训练实现；只提供 Provider + Adapter 协议。

## 架构

```text
Agent / REST
  model.publish_as_factor  或  factor.register(lang=ml_score)
        ↓
factor_definition (provider_key=external_ml, definition.modelFactor=…)
        ↓
factor.compute / factor.autoEvaluate
        ↓
ExternalMlFactorProvider
        ↓
ModelFactorAdapter（进程内自定义 或 内置 http）
        ↓
symbol × date × value  （与 qlib 因子同构）
```

## 两种接入方式

### A. 进程内 Adapter（嵌入式 / 同进程 SDK）

```ts
import { registerModelFactorAdapter } from "./src/runtime/provider";

registerModelFactorAdapter({
  key: "my_train_platform",
  async infer(req) {
    // req.dataset / req.datasetSnapshotId 已密封；不要另拉「今日行情」
    const rows = await myPlatform.score(req);
    return { ok: true, rows }; // [{ symbol, date, value }]
  },
});
```

发布因子：

```json
{
  "name": "lgbm_cs_v3",
  "lang": "ml_score",
  "model_factor": {
    "adapterKey": "my_train_platform",
    "modelId": "lgbm_cs",
    "modelVersion": "2026.08.28",
    "artifactUri": "file:///models/lgbm_cs.v3.txt",
    "contentHash": "sha256:…",
    "trainEndAsOf": "2024-12-31",
    "scoreTransform": "rank"
  }
}
```

Agent 工具：`model.publish_as_factor`  
REST：`POST /api/v1/factors/publish-model`

### B. HTTP JSON 桥（外部独立训练/推理服务）

`adapterKey: "http"`，在 `adapterConfig.endpoint` 填推理 URL。

请求体（QUBIT → 你的服务）：

```json
{
  "protocolVersion": "model-factor-infer-v1",
  "requestId": "…",
  "model": {
    "modelId": "lgbm_cs",
    "modelVersion": "2026.08.28",
    "artifactUri": "…",
    "contentHash": "…",
    "scoreTransform": "rank"
  },
  "universe": "CN-A",
  "symbols": ["600519", "000858"],
  "startDate": "2023-01-01",
  "endDate": "2024-12-31",
  "datasetSnapshotId": "snap-…",
  "dataRef": "…",
  "asOf": "2024-12-31",
  "timeframe": "1d",
  "barsBySymbol": { "600519": [/* OHLCV */] }
}
```

响应：

```json
{
  "ok": true,
  "rows": [{ "symbol": "600519", "date": "2024-01-02", "value": 0.13 }],
  "meta": { "latencyMs": 42 }
}
```

`adapterConfig.includeBars: false` 时可只传 `datasetSnapshotId` / `dataRef`（适合双方共享对象存储）。

## 硬约束

1. `lang=ml_score` 必须带 `definition.modelFactor`（adapterKey / modelId / modelVersion）。
2. 绑定 `dataset_snapshot_id` 计算时，adapter **不得**隐式拉实时行情。
3. 训练不在本 P0 范围；外部训完后用 publish 接入即可。
4. 后续评估/晋级继续走现有 `factor.autoEvaluate` → `factor.promote_backtest` → `backtest.walk_forward`。

## 关键代码

| 路径 | 作用 |
| --- | --- |
| `src/runtime/provider/model-factor-contract.ts` | 协议与校验 |
| `src/runtime/provider/impls/factor/model-factor-adapter-registry.ts` | Adapter 注册表 |
| `src/runtime/provider/impls/factor/http-model-factor-adapter.ts` | 内置 HTTP 桥 |
| `src/runtime/provider/impls/factor/external-ml-factor-provider.ts` | `external_ml` Provider |
| `model.publish_as_factor` / `POST /api/v1/factors/publish-model` | 发布入口 |
