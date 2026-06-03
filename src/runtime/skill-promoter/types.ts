/**
 * Self-Evolving Agent P5 — SkillPromoter 类型定义。
 *
 * 把"候选 → 评分 → 决策"三步切干净：上层 worker 编排，纯函数 scoring 易测。
 * 候选生命周期：experience.procedural.workflow_play → 评分 → 通过 → agent_skill(state=pending_review)
 *   → 前端 approve → state='active' / 前端 reject → state='archived' + reflective 反馈。
 */

import type { Experience } from "../experience/types";

/** 候选来源（v0 只取 procedural；后续可扩 reflective） */
export type PromoterCandidateKind = "procedural";

/**
 * 候选明细：扫描阶段的产物，可以喂给 scoreCandidate 也可以直接落 actionsJson。
 * 注意：experience.useCount/successCount/failCount 由 writer/recall pipe 维护；
 * 没有则视作 0（不会让规则崩，只是评分低）。
 */
export interface PromoterCandidate {
  kind: PromoterCandidateKind;
  experienceId: string;
  /** procedural.metadataJson.signature；同 project 同 signature 不重复 promote */
  signature: string;
  /** 候选标题（写入 agent_skill.name 时会归一化） */
  title: string;
  /** 候选描述（→ agent_skill.description） */
  description: string;
  /** 候选正文 markdown（→ agent_skill.bodyMd，末尾会被 promoter 补 `<!-- signature: ... -->`） */
  bodyMd: string;
  /** 来源 experience.definitionId（v0 优先归属给原 agent，definition 删了置 null） */
  definitionId: string | null;
  useCount: number;
  successCount: number;
  failCount: number;
  /** 0..1，experience.qualityScore */
  qualityScore: number;
  /** v0：恒为 0.5（中性，PnL 信号 P9 才接） */
  pnlSignal: number;
}

/** 评分中间步骤：每条规则的命中明细（写 actionsJson 给前端展示） */
export interface PromoterRuleHit {
  rule: string;
  passed: boolean;
  detail: string;
  /** rule 对最终 score 的贡献（regulated 0..1） */
  contribution: number;
}

/** scoreCandidate 输出 */
export interface PromoterScore {
  score: number;
  qualified: boolean;
  ruleHits: PromoterRuleHit[];
  /** qualified=false 时为何不通过 */
  skipReason?: "low_recall" | "low_success_rate" | "low_quality" | "insufficient_data";
}

/** worker 一次 tick 的 summary（→ skill_promotion_run + 前端展示） */
export interface PromoterRunSummary {
  runId: string;
  projectId: string;
  mode: "dry_run" | "live";
  status: "completed" | "failed";
  triggeredBy: string;
  totalScanned: number;
  totalQualified: number;
  totalPromoted: number;
  totalSkippedDuplicate: number;
  totalSkippedInsufficient: number;
  /** 候选明细：候选 + 评分 + 是否真写 agent_skill */
  actions: PromoterActionRecord[];
  elapsedMs: number;
  errorMessage?: string;
}

/** 单候选最终落库结果（writer 用、reader 也用） */
export interface PromoterActionRecord {
  candidateKind: PromoterCandidateKind;
  experienceId: string;
  signature: string;
  score: number;
  qualified: boolean;
  /** 写入的 agent_skill.id；dry_run 或 skipped 时 null */
  promotedSkillId: string | null;
  status: "promoted" | "skipped_duplicate" | "skipped_insufficient" | "skipped_rejected" | "dry_run";
  ruleHits: PromoterRuleHit[];
}

// ────────── Input from candidate scanner（便于单测 scoring 用） ──────────

/**
 * 把 experience row + 已知 reject signature 转 candidate；
 * 单独抽函数便于 scanner 单测。
 */
export interface CandidateFromExperienceInput {
  experience: Experience;
  /** experience.metadataJson 已 normalize 过；这里仅需取 signature */
  signature: string;
}
