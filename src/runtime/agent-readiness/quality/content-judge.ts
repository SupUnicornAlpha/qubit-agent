/**
 * A-3 · LLM-as-Judge 内容专业度评分。
 *
 * 接口：
 *   - judgeArtifact(client, ctx)：调用 LLM 给单个产物打分；失败返回 null
 *   - collectContentJudge(sqlite, judge, input)：从 SQL 抓本 workflow 的产物，逐个评分，
 *     返回 A-3（均值）+ 详细 by-artifact 分数
 *
 * 设计取舍：
 *   - JudgeClient 接口抽象 → 单测 mock 容易；prod 实现走 invokeWithFallback
 *   - 单个产物失败不让整个 A-3 变 null：跳过失败项，按成功项均值算
 *   - 全部失败 → A-3 = null（不计入 grader）
 */
import type { Database } from "bun:sqlite";

import {
  buildJudgeUserPrompt,
  CONTENT_JUDGE_SYSTEM_PROMPT,
  parseJudgeResponse,
  type JudgeScore,
} from "./content-judge-rubric";
import type { ScenarioRecipe } from "../scenarios";

export interface JudgeClient {
  /** 调用 LLM，返回原始字符串 */
  judge(input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface ContentJudgeInput {
  workflowRunId: string;
  scenario: ScenarioRecipe["key"];
  /** 上限：单 workflow 评多少条产物，避免 token 失控（默认 5） */
  maxArtifacts?: number;
}

export interface ContentJudgeResult {
  "A-3": number | null;
  details: {
    judged: Array<{
      kind: string;
      identifier: string;
      score: JudgeScore;
    }>;
    failed: Array<{
      kind: string;
      identifier: string;
      reason: string;
    }>;
  };
}

interface ArtifactPayload {
  kind: string;
  identifier: string;
  payload: unknown;
}

function readArtifacts(
  sqlite: Database,
  workflowRunId: string,
  scenario: ScenarioRecipe["key"]
): ArtifactPayload[] {
  if (scenario === "research") {
    const sigs = sqlite
      .prepare(
        `SELECT id, ticker, signal, confidence, reasoning, data_snapshot_json AS dataSnapshotJson
         FROM analyst_signal WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<Record<string, unknown>>;
    const fus = sqlite
      .prepare(
        `SELECT id, ticker, fused_signal AS fusedSignal, fused_confidence AS fusedConfidence
         FROM signal_fusion_result WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<Record<string, unknown>>;
    return [
      ...sigs.map((s) => ({
        kind: "analyst_signal",
        identifier: String(s.id),
        payload: s,
      })),
      ...fus.map((f) => ({
        kind: "signal_fusion_result",
        identifier: String(f.id),
        payload: f,
      })),
    ];
  }
  if (scenario === "stock_pick") {
    const cands = sqlite
      .prepare(
        `SELECT sc.id, sc.ticker, sc.company_name AS companyName, sc.score,
                sc.score_breakdown_json AS breakdown
         FROM screener_candidate sc
         JOIN screener_run sr ON sr.id = sc.screener_run_id
         WHERE sr.workflow_run_id = ?
         LIMIT 5`
      )
      .all(workflowRunId) as Array<Record<string, unknown>>;
    return cands.map((c) => ({
      kind: "screener_candidate",
      identifier: String(c.id),
      payload: c,
    }));
  }
  if (scenario === "factor") {
    const facs = sqlite
      .prepare(
        `SELECT fd.id, fd.name, fd.category, fd.expr, fd.lang,
                fe.ic, fe.rank_ic AS rankIc, fe.ir
         FROM factor_definition fd
         LEFT JOIN factor_evaluation fe ON fe.factor_id = fd.id
         WHERE fe.id IS NOT NULL OR fd.expr != ''`
      )
      .all() as Array<Record<string, unknown>>;
    return facs.map((f) => ({
      kind: "factor_definition+evaluation",
      identifier: String(f.id),
      payload: f,
    }));
  }
  if (scenario === "strategy") {
    const vers = sqlite
      .prepare(
        `SELECT sv.id, sv.version_tag AS versionTag, sv.logic_hash AS logicHash,
                sc.kind, sc.factor_ids_json AS factorIdsJson, sc.weight_method AS weightMethod
         FROM strategy_version sv
         LEFT JOIN strategy_composition sc ON sc.strategy_version_id = sv.id
         WHERE sv.workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<Record<string, unknown>>;
    return vers.map((v) => ({
      kind: "strategy_version+composition",
      identifier: String(v.id),
      payload: v,
    }));
  }
  if (scenario === "live_trading") {
    const ois = sqlite
      .prepare(
        `SELECT oi.id, oi.side, oi.qty, oi.order_type AS orderType, oi.time_in_force AS timeInForce,
                i.symbol, rd.decision AS riskDecision, rd.reason AS riskReason
         FROM order_intent oi
         LEFT JOIN instrument i ON i.id = oi.instrument_id
         LEFT JOIN risk_decision rd ON rd.order_intent_id = oi.id
         WHERE oi.workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<Record<string, unknown>>;
    return ois.map((o) => ({
      kind: "order_intent+risk_decision",
      identifier: String(o.id),
      payload: o,
    }));
  }
  return [];
}

export async function judgeArtifact(
  client: JudgeClient,
  scenario: string,
  artifact: ArtifactPayload
): Promise<{ ok: true; score: JudgeScore } | { ok: false; reason: string }> {
  let raw: string;
  try {
    raw = await client.judge({
      systemPrompt: CONTENT_JUDGE_SYSTEM_PROMPT,
      userPrompt: buildJudgeUserPrompt(scenario, artifact.kind, artifact.payload),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const score = parseJudgeResponse(raw);
  if (!score) return { ok: false, reason: "judge response not parseable" };
  return { ok: true, score };
}

export async function collectContentJudge(
  sqlite: Database,
  client: JudgeClient,
  input: ContentJudgeInput
): Promise<ContentJudgeResult> {
  const max = input.maxArtifacts ?? 5;
  const artifacts = readArtifacts(sqlite, input.workflowRunId, input.scenario).slice(
    0,
    max
  );
  if (!artifacts.length) {
    return { "A-3": null, details: { judged: [], failed: [] } };
  }

  const judged: ContentJudgeResult["details"]["judged"] = [];
  const failed: ContentJudgeResult["details"]["failed"] = [];
  for (const a of artifacts) {
    const r = await judgeArtifact(client, input.scenario, a);
    if (r.ok) {
      judged.push({ kind: a.kind, identifier: a.identifier, score: r.score });
    } else {
      failed.push({ kind: a.kind, identifier: a.identifier, reason: r.reason });
    }
  }

  if (!judged.length) {
    return { "A-3": null, details: { judged: [], failed } };
  }
  const avg =
    judged.reduce((acc, j) => acc + j.score.overall, 0) / judged.length;
  return {
    "A-3": Number(avg.toFixed(2)),
    details: { judged, failed },
  };
}
