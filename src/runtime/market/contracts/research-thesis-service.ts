/**
 * Research thesis store (Prime D4).
 * Content-addressable, disk-backed; OUT harness — not Core checkpoint.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "../../app-paths";
import {
  type ResearchThesis,
  ResearchThesisSchema,
  newThesisId,
} from "./market-event-v2";

export type ResearchThesisWriteInput = {
  snapshotId: string;
  instrumentScope: string[];
  direction: ResearchThesis["direction"];
  horizon: string;
  confidence: number;
  claims?: ResearchThesis["claims"];
  invalidation?: ResearchThesis["invalidation"];
  knownUnknowns?: string[];
  modelAndPromptVersion?: string;
  /** Optional explicit id; otherwise content-addressed. */
  thesisId?: string;
  createdAt?: string;
  workflowRunId?: string;
  role?: string;
};

export type ResearchThesisRecord = {
  thesis: ResearchThesis;
  meta: {
    workflowRunId: string | null;
    role: string | null;
    fingerprint: string;
  };
};

export type ResearchThesisWriteResult = {
  ok: true;
  thesisId: string;
  snapshotId: string;
  reused: boolean;
  thesis: ResearchThesis;
  effects: Array<{ kind: "research_thesis"; key: string; meta: Record<string, unknown> }>;
  summary: string;
};

const memoryCatalog = new Map<string, ResearchThesisRecord>();

export function isResearchThesisWriteEnabled(): boolean {
  const raw = (process.env.QUBIT_RESEARCH_THESIS_WRITE ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function thesesRoot(dataDir?: string): string {
  return join(dataDir ?? defaultDataDir(), "research-theses");
}

function canonicalFingerprint(input: Omit<ResearchThesis, "thesisId" | "createdAt">): string {
  return JSON.stringify({
    snapshotId: input.snapshotId,
    instrumentScope: [...input.instrumentScope].sort(),
    direction: input.direction,
    horizon: input.horizon,
    confidence: input.confidence,
    claims: input.claims,
    invalidation: input.invalidation,
    knownUnknowns: [...input.knownUnknowns].sort(),
    modelAndPromptVersion: input.modelAndPromptVersion,
  });
}

export function thesisIdFromFingerprint(canonical: string): string {
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `thesis_${digest}`;
}

export function clearResearchThesisCatalogForTests(): void {
  memoryCatalog.clear();
}

export async function getResearchThesisById(
  thesisId: string,
  dataDir?: string
): Promise<ResearchThesisRecord | null> {
  const cached = memoryCatalog.get(thesisId);
  if (cached) return cached;
  try {
    const path = join(thesesRoot(dataDir), `${thesisId}.json`);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ResearchThesisRecord;
    ResearchThesisSchema.parse(parsed.thesis);
    memoryCatalog.set(thesisId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function persistRecord(record: ResearchThesisRecord, dataDir?: string): Promise<void> {
  memoryCatalog.set(record.thesis.thesisId, record);
  const root = thesesRoot(dataDir);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${record.thesis.thesisId}.json`), JSON.stringify(record), "utf8");
}

export async function writeResearchThesis(
  input: ResearchThesisWriteInput,
  options?: { dataDir?: string }
): Promise<ResearchThesisWriteResult> {
  if (!isResearchThesisWriteEnabled()) {
    throw new Error("research.thesis.write is disabled (QUBIT_RESEARCH_THESIS_WRITE=0)");
  }

  const snapshotId = input.snapshotId.trim();
  if (!snapshotId) throw new Error("missing_snapshotId: research.thesis.write requires snapshotId");

  const instrumentScope = [
    ...new Set(input.instrumentScope.map((s) => s.trim()).filter(Boolean)),
  ];
  if (instrumentScope.length === 0) {
    throw new Error("missing_instrumentScope: research.thesis.write requires instrumentScope");
  }

  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("invalid_confidence: must be between 0 and 1");
  }

  const body = {
    snapshotId,
    instrumentScope,
    direction: input.direction,
    horizon: input.horizon.trim() || "5d",
    confidence,
    claims: input.claims ?? [],
    invalidation: input.invalidation ?? [],
    knownUnknowns: input.knownUnknowns ?? [],
    modelAndPromptVersion: (input.modelAndPromptVersion ?? "unknown").trim() || "unknown",
  };
  const fingerprint = canonicalFingerprint(body);
  const thesisId =
    input.thesisId?.trim() || thesisIdFromFingerprint(fingerprint) || newThesisId();
  const createdAt = input.createdAt ?? new Date().toISOString();

  const existing = await getResearchThesisById(thesisId, options?.dataDir);
  if (existing && existing.meta.fingerprint === fingerprint) {
    return toResult(existing, true);
  }

  const thesis = ResearchThesisSchema.parse({
    thesisId,
    ...body,
    createdAt: existing?.thesis.createdAt ?? createdAt,
  });

  const record: ResearchThesisRecord = {
    thesis,
    meta: {
      workflowRunId: input.workflowRunId?.trim() || null,
      role: input.role?.trim() || null,
      fingerprint,
    },
  };
  await persistRecord(record, options?.dataDir);
  return toResult(record, false);
}

function toResult(record: ResearchThesisRecord, reused: boolean): ResearchThesisWriteResult {
  return {
    ok: true,
    thesisId: record.thesis.thesisId,
    snapshotId: record.thesis.snapshotId,
    reused,
    thesis: record.thesis,
    effects: [
      {
        kind: "research_thesis",
        key: record.thesis.thesisId,
        meta: {
          snapshotId: record.thesis.snapshotId,
          direction: record.thesis.direction,
          horizon: record.thesis.horizon,
          workflowRunId: record.meta.workflowRunId,
        },
      },
    ],
    summary: reused
      ? `已复用结构化 thesis ${record.thesis.thesisId}`
      : `已写入结构化 thesis ${record.thesis.thesisId}`,
  };
}
