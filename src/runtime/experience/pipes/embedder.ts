/**
 * Embedder pipe — Memory V2 P2。
 *
 * 职责：把 experience 表里"还没生成 embedding 的"行批量打 embedding，写入
 * ExperienceVectorStore。后续 Recall 就能拿向量做混排。
 *
 * 设计模型：
 *   - **pull mode**（非 push）：周期性扫表，避免 Writer/Extractor/Reflector 直接耦合 embedding；
 *     · embedding 慢失败（API quota、网络抖动）不阻塞主链路；
 *     · 想换模型时一次性重 embed 全表，不需要触发 N 个 pipe 走老路径。
 *   - **状态机**（藏在 `metadataJson.embeddingState`）：
 *     · 缺省 / `pending` → 待跑
 *     · `done` → 已完成（带 `embeddingModel + embeddingDim + embeddedAt`）
 *     · `failed` → 上次失败，`embeddingRetries` 计数；超阈值后跳过
 *   - **dedupe**：同一行多次 upsert vectorStore 是合法的（向量演化）；但每次 runOnce
 *     里同一 experienceId 只处理 1 次。
 *   - **失败不阻塞**：单条失败仅 warn + 标 failed，整批继续。
 *   - **可重 embed**：换模型时调 `rebuildExperience(id)` 删旧向量 + 重置 state；
 *     批量重建由 CLI 调用。
 *
 * 测试：
 *   - 用 InMemoryExperienceStore + InMemoryExperienceVectorStore + MockEmbeddingClient，
 *     完全 deterministic + 离线可跑。
 */

import type { Experience, ExperienceContent } from "../../../types/entities";
import type { EmbeddingClient } from "../../llm/embedding-client";
import type { ExperienceStore } from "../experience-store";
import type { ExperienceVectorStore } from "../experience-vector-store";

// ───────────────────────── 状态机字段（约定写在 metadataJson 里） ─────────────────────────

const META_STATE = "embeddingState";
const META_MODEL = "embeddingModel";
const META_DIM = "embeddingDim";
const META_AT = "embeddedAt";
const META_RETRIES = "embeddingRetries";
const META_LAST_ERR = "embeddingLastError";

export const DEFAULT_BATCH_SIZE = 64;
export const DEFAULT_MAX_RETRIES = 3;
/** 单次 runOnce 最多扫多少行候选（包括 done 的）；防止超大表 OOM */
export const DEFAULT_SCAN_LIMIT = 1000;

export interface EmbedderRunSummary {
  scanned: number;
  picked: number;
  succeeded: number;
  failed: number;
  /** 整批 embed 调用次数（一般 = ceil(picked / batchSize)） */
  embedBatches: number;
  tokensUsed: number;
}

export interface RunEmbedderOnceOptions {
  store: ExperienceStore;
  vectorStore: ExperienceVectorStore;
  client: EmbeddingClient;
  /** 单次 runOnce 处理的 experience 数上限；默认 64 */
  batchSize?: number;
  /** 单次 runOnce 扫描多少行候选；默认 1000 */
  scanLimit?: number;
  /** 失败重试上限；超过后 skip；默认 3 */
  maxRetries?: number;
}

// ───────────────────────── 入口 ─────────────────────────

export async function runEmbedderOnce(opts: RunEmbedderOnceOptions): Promise<EmbedderRunSummary> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const scanLimit = opts.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = opts.client;

  const summary: EmbedderRunSummary = {
    scanned: 0,
    picked: 0,
    succeeded: 0,
    failed: 0,
    embedBatches: 0,
    tokensUsed: 0,
  };

  // 1) 扫候选（exclude_archived；按 createdAt 升序，确保旧数据先 embed）
  const candidates = await opts.store.query({
    archivalMode: "exclude_archived",
    orderBy: "createdAt",
    order: "asc",
    limit: scanLimit,
  });
  summary.scanned = candidates.length;

  // 2) 过滤已 done / 已超 retries / archived
  const todo: Experience[] = [];
  for (const exp of candidates) {
    const meta = exp.metadataJson;
    const state = String(meta[META_STATE] ?? "");
    const retries = Number(meta[META_RETRIES] ?? 0);
    if (
      state === "done" &&
      meta[META_MODEL] === client.model &&
      meta[META_DIM] === client.dimension
    ) {
      continue;
    }
    if (state === "failed" && retries >= maxRetries) continue;
    todo.push(exp);
    if (todo.length >= batchSize) break;
  }
  summary.picked = todo.length;
  if (todo.length === 0) return summary;

  // 3) 准备 batch text；与 todo 顺序严格对应
  const texts = todo.map((e) => buildEmbedText(e.contentJson));

  // 4) 跑 embedding（一整批，client 内部按 maxBatchSize 切片）
  let vectors: number[][];
  try {
    const res = await client.embed(texts);
    vectors = res.vectors;
    summary.embedBatches += 1;
    summary.tokensUsed += res.tokensUsed;
  } catch (err) {
    // 整批失败：每条 +1 retries + state=failed
    const errMsg = err instanceof Error ? err.message : String(err);
    for (const exp of todo) {
      await markFailed(opts.store, exp, errMsg);
      summary.failed += 1;
    }
    return summary;
  }

  // 5) 写 vectorStore + 改 state=done
  for (let i = 0; i < todo.length; i += 1) {
    const exp = todo[i];
    const vec = vectors[i];
    if (!exp || !vec) continue;
    try {
      await opts.vectorStore.upsert({
        experienceId: exp.id,
        vector: vec,
        kind: exp.kind,
        subKind: exp.subKind,
        scope: exp.scope,
        scopeId: exp.scopeId,
        definitionId: exp.definitionId,
        visibility: exp.visibility,
        model: client.model,
        dimension: client.dimension,
        sourceText: texts[i] ?? "",
      });
      await markDone(opts.store, exp, client);
      summary.succeeded += 1;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await markFailed(opts.store, exp, errMsg);
      summary.failed += 1;
    }
  }

  return summary;
}

/**
 * 重建：删该 experience 的所有旧向量 + 重置 state，使其下次 runOnce 必跑。
 * 用于换 embedding 模型时整表重 embed。
 */
export async function rebuildExperienceEmbedding(
  store: ExperienceStore,
  vectorStore: ExperienceVectorStore,
  experienceId: string
): Promise<void> {
  const exp = await store.findById(experienceId);
  if (!exp) return;
  await vectorStore.deleteByExperience(experienceId);
  const meta = { ...exp.metadataJson };
  delete (meta as Record<string, unknown>)[META_STATE];
  delete (meta as Record<string, unknown>)[META_MODEL];
  delete (meta as Record<string, unknown>)[META_DIM];
  delete (meta as Record<string, unknown>)[META_AT];
  delete (meta as Record<string, unknown>)[META_RETRIES];
  delete (meta as Record<string, unknown>)[META_LAST_ERR];
  await store.update(experienceId, { metadataJson: meta });
}

// ───────────────────────── 内部工具 ─────────────────────────

function buildEmbedText(content: ExperienceContent): string {
  const summary = content.summary ?? "";
  const body = (content as { body?: unknown }).body;
  const bodyStr = typeof body === "string" ? body : "";
  // 拼接：summary 给召回信号，body 给细节；总长截到 ~4k 字符（OpenAI 8k token 上限留余量）
  const joined = bodyStr ? `${summary}\n\n${bodyStr}` : summary;
  return joined.slice(0, 4000) || " ";
}

async function markDone(
  store: ExperienceStore,
  exp: Experience,
  client: EmbeddingClient
): Promise<void> {
  const meta: Record<string, unknown> = { ...exp.metadataJson };
  meta[META_STATE] = "done";
  meta[META_MODEL] = client.model;
  meta[META_DIM] = client.dimension;
  meta[META_AT] = new Date().toISOString();
  delete meta[META_LAST_ERR];
  // 保留 retries 用于审计
  await store.update(exp.id, { metadataJson: meta });
}

async function markFailed(store: ExperienceStore, exp: Experience, errMsg: string): Promise<void> {
  const meta: Record<string, unknown> = { ...exp.metadataJson };
  meta[META_STATE] = "failed";
  meta[META_RETRIES] = Number(meta[META_RETRIES] ?? 0) + 1;
  meta[META_LAST_ERR] = errMsg.slice(0, 500);
  try {
    await store.update(exp.id, { metadataJson: meta });
  } catch (err) {
    // 写 state 也失败：仅 warn；下次再来
    console.warn(
      `[embedder] failed to persist failed state for ${exp.id}: ${(err as Error).message}`
    );
  }
}

// 暴露给测试 / debug
export const EMBEDDER_META_KEYS = {
  STATE: META_STATE,
  MODEL: META_MODEL,
  DIM: META_DIM,
  AT: META_AT,
  RETRIES: META_RETRIES,
  LAST_ERR: META_LAST_ERR,
} as const;
