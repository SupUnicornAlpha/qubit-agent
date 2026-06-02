/**
 * ExperienceStore / ExperienceBus 共享的输入输出类型。
 *
 * 这里只定义"模块之间的契约"，所有具体业务策略（reflective 隔离、
 * semantic 共享、qualityScore 公式、TTL 长度等）都不在这一层 ——
 * 保持 Store/Bus 这条边界尽可能薄，便于 Writer/Extractor/Reflector/
 * Janitor/Recall 5 个 pipe 单独单测。
 */

import type {
  Experience,
  ExperienceContent,
  ExperienceKind,
  ExperienceLink,
  ExperienceLinkRelation,
  ExperienceOp,
  ExperienceOpLog,
  ExperienceOutcome,
  ExperienceScope,
  ExperienceVisibility,
} from "../../types/entities";

export type { Experience, ExperienceLink, ExperienceOpLog };

// ───────────────────────── Insert / Update DTO ─────────────────────────

/** insert() 入参：必填字段对齐 schema NOT NULL；其它字段走默认值。 */
export interface InsertExperienceInput {
  kind: ExperienceKind;
  scope: ExperienceScope;
  scopeId: string;
  contentJson: ExperienceContent;
  validFrom: string;

  subKind?: string;
  definitionId?: string | null;
  visibility?: ExperienceVisibility;
  tagsJson?: string[];
  qualityScore?: number;
  decayAt?: string | null;
  validTo?: string | null;
  parentId?: string | null;
  sourceRunId?: string | null;
  embeddingRef?: string | null;
  pinned?: boolean;
  metadataJson?: Record<string, unknown>;
}

export interface UpdateExperienceInput {
  subKind?: string;
  contentJson?: ExperienceContent;
  tagsJson?: string[];
  qualityScore?: number;
  useCount?: number;
  successCount?: number;
  failCount?: number;
  decayAt?: string | null;
  validTo?: string | null;
  parentId?: string | null;
  embeddingRef?: string | null;
  pinned?: boolean;
  metadataJson?: Record<string, unknown>;
}

// ───────────────────────── Query ─────────────────────────

/**
 * 简单结构化查询。**不包含** keyword / vector 检索（那是 Recall 层的事）。
 * 只暴露"按字段过滤 + 排序 + 翻页"这种 SQL 直观能力。
 */
export interface ExperienceQuery {
  kind?: ExperienceKind | ExperienceKind[];
  subKind?: string | string[];
  scope?: ExperienceScope;
  scopeId?: string;
  definitionId?: string | null;
  /** "exclude_archived" 排除 validTo!=null；"only_archived" 仅取已 supersede；"all" 全要 */
  archivalMode?: "exclude_archived" | "only_archived" | "all";
  /** 含任意一个 tag 即命中 */
  anyTags?: string[];
  pinnedOnly?: boolean;
  /** validFrom DESC 还是 qualityScore DESC */
  orderBy?: "valid_from_desc" | "quality_desc" | "created_desc";
  limit?: number;
  offset?: number;
}

// ───────────────────────── Op log ─────────────────────────

export interface OpLogInput {
  experienceId: string;
  op: ExperienceOp;
  actor: string;
  workflowRunId?: string | null;
  outcome?: ExperienceOutcome | null;
  metadataJson?: Record<string, unknown>;
}

// ───────────────────────── Link expand ─────────────────────────

export interface LinkExpandParams {
  seedIds: string[];
  relations?: ExperienceLinkRelation[];
  /** 1 = 直接邻居；2 = 邻居的邻居（注意爆炸） */
  maxDepth?: number;
}
