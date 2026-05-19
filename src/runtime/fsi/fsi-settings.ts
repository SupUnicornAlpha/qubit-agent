import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const FsiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  enabledBundles: z.array(z.string()).optional(),
  applyAgentMappings: z.boolean().optional(),
  validateOutput: z.boolean().optional(),
  seedMcpCatalog: z.boolean().optional(),
  contentRoot: z.string().optional(),
});

export type FsiSettings = z.infer<typeof FsiSettingsSchema>;

const ManifestDefaultsSchema = z.object({
  enabled: z.boolean().optional(),
  enabledBundles: z.array(z.string()).optional(),
});

let cachedPackSettings: FsiSettings | null | undefined;
let cachedManifestDefaults: { enabled?: boolean; enabledBundles?: string[] } | null | undefined;

export function getFsiPackDir(): string {
  return join(process.cwd(), "content-packs", "anthropic-fsi");
}

export function getFsiVendorDir(): string {
  return join(getFsiPackDir(), "vendor");
}

export function getFsiSubmoduleDir(): string {
  return join(getFsiPackDir(), "financial-services");
}

async function loadPackSettings(): Promise<FsiSettings> {
  if (cachedPackSettings !== undefined) return cachedPackSettings ?? {};
  const path = join(getFsiPackDir(), "settings.json");
  if (!existsSync(path)) {
    cachedPackSettings = {};
    return {};
  }
  try {
    const raw = await readFile(path, "utf-8");
    cachedPackSettings = FsiSettingsSchema.parse(JSON.parse(raw));
    return cachedPackSettings;
  } catch {
    cachedPackSettings = {};
    return {};
  }
}

export async function loadManifestDefaults(
  manifestJson: Record<string, unknown>
): Promise<{ enabled?: boolean; enabledBundles?: string[] }> {
  if (cachedManifestDefaults !== undefined) return cachedManifestDefaults ?? {};
  const d = manifestJson["defaults"];
  if (!d || typeof d !== "object") {
    cachedManifestDefaults = {};
    return {};
  }
  cachedManifestDefaults = ManifestDefaultsSchema.parse(d);
  return cachedManifestDefaults;
}

/** 合并：manifest.defaults → settings.json → 环境变量（在 fsi-config 中应用） */
export async function resolveFsiPackSettings(manifestJson?: Record<string, unknown>): Promise<{
  enabled: boolean;
  enabledBundles: string[];
  applyAgentMappings: boolean;
  validateOutput: boolean;
  seedMcpCatalog: boolean;
}> {
  const manifestDefaults = manifestJson
    ? await loadManifestDefaults(manifestJson)
    : cachedManifestDefaults ?? {};
  const file = await loadPackSettings();

  const enabled =
    file.enabled ??
    manifestDefaults.enabled ??
    true;

  const enabledBundles =
    file.enabledBundles ??
    manifestDefaults.enabledBundles ??
    ["quant-research"];

  return {
    enabled,
    enabledBundles,
    applyAgentMappings: file.applyAgentMappings ?? true,
    validateOutput: file.validateOutput ?? true,
    seedMcpCatalog: file.seedMcpCatalog ?? true,
  };
}

export function resetFsiSettingsCacheForTests(): void {
  cachedPackSettings = undefined;
  cachedManifestDefaults = undefined;
}
