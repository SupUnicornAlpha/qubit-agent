import { z } from "zod";
import { isPointInTimeDate } from "../market/contracts/point-in-time-clock";

const text = z.string().trim().min(1).max(10_000);
const date = z.string().refine(isPointInTimeDate, "Use a real calendar date in YYYY-MM-DD format");

export const factorComparisonSpecSchema = z
  .object({
    method: z.literal("rank_blend_v1"),
    references: z
      .array(
        z
          .object({
            factorId: z.string().trim().min(1).max(200),
            direction: z.union([z.literal(1), z.literal(-1)]),
            fingerprint: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .optional(),
          })
          .strict()
      )
      .min(1)
      .max(8)
      .refine(
        (items) => new Set(items.map((item) => item.factorId)).size === items.length,
        "Duplicate reference factors"
      ),
    candidateDirection: z.union([z.literal(1), z.literal(-1)]),
    candidateWeight: z.number().min(0.05).max(0.5),
    costBps: z.number().min(0).max(100),
  })
  .strict();
export type FactorComparisonSpec = z.infer<typeof factorComparisonSpecSchema>;

export const researchProtocolSpecSchema = z
  .object({
    hypothesis: text,
    benchmark: text,
    stoppingRule: text,
    development: z
      .object({
        datasetSnapshotId: z.string().regex(/^mkt_snapshot_[a-f0-9]{24}$/),
        symbols: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(64)
              .transform((value) => value.toUpperCase())
          )
          .min(3)
          .max(5_000)
          .refine((symbols) => new Set(symbols).size === symbols.length, "Symbols must be unique")
          .transform((symbols) => symbols.slice().sort()),
        startDate: date,
        endDate: date,
      })
      .strict()
      .refine((value) => value.startDate <= value.endDate, "Development dates are reversed"),
    evaluation: z
      .object({
        method: z.literal("factor_rank_ic_v1"),
        horizonDays: z.number().int().min(1).max(252),
        groupCount: z.number().int().min(2).max(100),
        sealedDatasetId: z.string().trim().min(1).max(200).optional(),
        sealedDatasetFingerprint: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .strict(),
    comparison: factorComparisonSpecSchema.optional(),
    budget: z
      .object({
        maxAttempts: z.number().int().min(1).max(100_000),
        maxEvaluations: z.number().int().min(0).max(100_000),
      })
      .strict()
      .refine(
        (value) => value.maxEvaluations <= value.maxAttempts,
        "Evaluation budget cannot exceed attempt budget"
      ),
  })
  .strict();

export type ResearchProtocolSpec = z.infer<typeof researchProtocolSpecSchema>;
export type ResearchProgramStatus = "active" | "paused";
export type ResearchAttemptKind =
  | "factor_compute"
  | "factor_evaluate"
  | "backtest"
  | "sealed_factor"
  | "sealed_strategy"
  | "paper_step";
export type ResearchAttemptStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ResearchProgram {
  projectId: string;
  activeProtocolId: string;
  status: ResearchProgramStatus;
  maxAttempts: number;
  maxEvaluations: number;
  usedAttempts: number;
  usedEvaluations: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProtocol {
  id: string;
  projectId: string;
  version: number;
  fingerprint: string;
  spec: ResearchProtocolSpec;
  createdAt: string;
}

export interface ResearchAttempt {
  id: string;
  projectId: string;
  protocolId: string;
  kind: ResearchAttemptKind;
  candidateId: string;
  candidateJson: Record<string, unknown>;
  requestJson: Record<string, unknown>;
  requestFingerprint: string;
  idempotencyKey: string;
  evaluationBudgetKey: string | null;
  status: ResearchAttemptStatus;
  resultJson: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  deadlineAt: string;
}

export interface ResearchProgramDetail {
  program: ResearchProgram | null;
  protocols: ResearchProtocol[];
  attempts: ResearchAttempt[];
}

export interface ReserveResearchAttemptInput {
  projectId: string;
  protocolId?: string;
  kind: ResearchAttemptKind;
  candidateId: string;
  candidateJson: Record<string, unknown>;
  requestJson: Record<string, unknown>;
  idempotencyKey: string;
  evaluationBudget?: { key: string; limit: number };
}

export class ResearchProgramError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 404 | 409,
    message = code
  ) {
    super(message);
    this.name = "ResearchProgramError";
  }
}
