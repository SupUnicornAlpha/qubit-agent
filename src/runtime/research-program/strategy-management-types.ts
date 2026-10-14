import { z } from "zod";
const id = z.string().trim().min(1).max(200);
const revision = z.number().int().nonnegative();
export const strategyManagementSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect") }).strict(),
  z.object({ action: z.literal("compare"), otherVersionId: id }).strict(),
  z
    .object({
      action: z.literal("state"),
      status: z.enum(["research", "review", "archived"]),
      referenceAttemptId: id.optional(),
      reason: z.string().trim().min(1).max(2000),
      expectedRevision: revision,
    })
    .strict(),
  z.object({ action: z.literal("plan"), expectedRevision: revision }).strict(),
  z.object({ action: z.literal("validate"), planId: id, idempotencyKey: id }).strict(),
  z.object({ action: z.literal("paper_list") }).strict(),
  z
    .object({
      action: z.literal("paper_create"),
      referenceAttemptId: id,
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      action: z.literal("paper_status"),
      sessionId: id,
      status: z.enum(["paused", "running"]),
      automatic: z.boolean().optional(),
      expectedRevision: revision,
    })
    .strict(),
  z
    .object({
      action: z.literal("paper_advance"),
      sessionId: id,
      expectedCursor: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
      idempotencyKey: id,
      bars: z.number().int().min(1).max(20),
      snapshotId: z
        .string()
        .regex(/^mkt_snapshot_[a-f0-9]{24}$/)
        .optional(),
    })
    .strict(),
]);
