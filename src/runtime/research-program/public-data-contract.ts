import { z } from "zod";
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
export const publicDataRequestSchema = z
  .object({
    provider: z.literal("yahoo_chart"),
    symbols: z
      .array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/))
      .min(3)
      .max(12),
    startDate: day,
    endDate: day,
    idempotencyKey: z.string().trim().min(1).max(120),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.symbols).size !== v.symbols.length ||
      v.startDate > v.endDate ||
      Date.parse(v.endDate) - Date.parse(v.startDate) > 5 * 366 * 86400000 ||
      v.endDate >= new Date().toISOString().slice(0, 10)
    )
      c.addIssue({ code: "custom", message: "需要唯一标的、已结束的日期区间，且范围不超过五年" });
  });
export type PublicDataRequest = z.infer<typeof publicDataRequestSchema>;
export const PUBLIC_DATA_LIMITATIONS = [
  "公开供应商历史修订不可还原，未证明历史时点可用性。",
  "使用供应商 OHLC，不混用 Adj Close；分红收益及历史复权修订未核验。",
  "固定标的池由研究者指定，未证明历史成分与退市覆盖。",
  "仅个人研究；不授予数据再分发、商用或交易权限。",
];
export type PublicDataImport = {
  id: string;
  projectId: string;
  request: PublicDataRequest;
  status: "running" | "completed" | "failed";
  createdAt: string;
  endedAt?: string;
  snapshotId?: string;
  barCounts?: Record<string, number>;
  error?: string;
  provenance: Array<{
    symbol: string;
    url: string;
    retrievedAt: string;
    sha256: string;
    rows: number;
  }>;
  qualification: "research_only";
  limitations: string[];
};
