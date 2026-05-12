import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../../db/sqlite/client";
import { builtinConnectorSettings } from "../../db/sqlite/schema";

/** Per-connector keys match registry names (`qubit-data`, `qubit-news`). */
export type BuiltinConnectorInitConfigs = Record<string, Record<string, unknown>>;

const DEFAULT_ROW_ID = "default";

const StoredSchema = z
  .object({
    "qubit-data": z.record(z.string(), z.unknown()).optional(),
    "qubit-news": z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function normalizeConfigs(raw: unknown): BuiltinConnectorInitConfigs {
  const parsed = StoredSchema.safeParse(raw);
  const base = parsed.success ? parsed.data : {};
  return {
    "qubit-data": { ...(base["qubit-data"] ?? {}) },
    "qubit-news": { ...(base["qubit-news"] ?? {}) },
  };
}

export async function loadBuiltinConnectorSettings(): Promise<BuiltinConnectorInitConfigs> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(builtinConnectorSettings)
    .where(eq(builtinConnectorSettings.id, DEFAULT_ROW_ID))
    .limit(1);
  const json = rows[0]?.configJson;
  return normalizeConfigs(json ?? {});
}

export async function saveBuiltinConnectorSettings(
  patch: Partial<BuiltinConnectorInitConfigs>
): Promise<BuiltinConnectorInitConfigs> {
  const current = await loadBuiltinConnectorSettings();
  const next: BuiltinConnectorInitConfigs = {
    "qubit-data":
      patch["qubit-data"] !== undefined ? { ...patch["qubit-data"] } : { ...current["qubit-data"] },
    "qubit-news":
      patch["qubit-news"] !== undefined ? { ...patch["qubit-news"] } : { ...current["qubit-news"] },
  };

  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .insert(builtinConnectorSettings)
    .values({
      id: DEFAULT_ROW_ID,
      configJson: next as never,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: builtinConnectorSettings.id,
      set: {
        configJson: next as never,
        updatedAt: now,
      },
    });

  return next;
}
