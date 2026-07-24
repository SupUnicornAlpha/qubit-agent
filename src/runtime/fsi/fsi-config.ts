import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getFsiPackDir, getFsiSubmoduleDir, getFsiVendorDir } from "./fsi-settings";

const PackSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  enabledBundles: z.array(z.string()).optional(),
  applyAgentMappings: z.boolean().optional(),
  validateOutput: z.boolean().optional(),
  seedMcpCatalog: z.boolean().optional(),
});

type ResolvedFsi = {
  enabled: boolean;
  enabledBundles: string[];
  applyAgentMappings: boolean;
  validateOutput: boolean;
  seedMcpCatalog: boolean;
  contentRootOverride: string | undefined;
  maxSkillInjectChars: number;
};

let resolved: ResolvedFsi | null = null;

function readPackSettingsSync(): z.infer<typeof PackSettingsSchema> {
  const path = join(getFsiPackDir(), "settings.json");
  if (!existsSync(path)) return {};
  try {
    return PackSettingsSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

function readManifestDefaultsSync(): { enabled?: boolean; enabledBundles?: string[] } {
  const path = join(getFsiPackDir(), "manifest.json");
  if (!existsSync(path)) return {};
  try {
    const m = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const d = m["defaults"];
    if (!d || typeof d !== "object") return {};
    const def = d as Record<string, unknown>;
    return {
      enabled: typeof def["enabled"] === "boolean" ? def["enabled"] : undefined,
      enabledBundles: Array.isArray(def["enabledBundles"])
        ? (def["enabledBundles"] as string[])
        : undefined,
    };
  } catch {
    return {};
  }
}

function envFlag(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

function getResolvedFsi(): ResolvedFsi {
  if (resolved) return resolved;
  const file = readPackSettingsSync();
  const manifestDef = readManifestDefaultsSync();

  const envEnabled = envFlag("QUBIT_FSI_ENABLED");
  const envDisabled = process.env["QUBIT_FSI_DISABLED"] === "true";

  let enabledBundles =
    file.enabledBundles ?? manifestDef.enabledBundles ?? ["quant-research"];
  const envBundles = process.env["QUBIT_FSI_BUNDLES"]?.trim();
  if (envBundles) {
    enabledBundles = envBundles.split(",").map((s) => s.trim()).filter(Boolean);
  }

  resolved = {
    enabled: envDisabled ? false : (envEnabled ?? file.enabled ?? manifestDef.enabled ?? true),
    enabledBundles,
    applyAgentMappings:
      process.env["QUBIT_FSI_APPLY_AGENTS"] === "false"
        ? false
        : (file.applyAgentMappings ?? true),
    validateOutput:
      process.env["QUBIT_FSI_VALIDATE_OUTPUT"] === "false"
        ? false
        : (file.validateOutput ?? true),
    seedMcpCatalog:
      process.env["QUBIT_FSI_SEED_MCP"] === "false" ? false : (file.seedMcpCatalog ?? true),
    contentRootOverride: process.env["QUBIT_FSI_CONTENT_ROOT"]?.trim() || undefined,
    maxSkillInjectChars: Number(process.env["QUBIT_FSI_MAX_SKILL_CHARS"] ?? 6000) || 6000,
  };
  return resolved;
}

/** 解析已启用的 FSI bundle 列表（含 quant-research 展开） */
export function resolveEnabledFsiBundles(): string[] {
  const raw = getResolvedFsi().enabledBundles;
  const set = new Set<string>();
  for (const b of raw) {
    const t = b.trim();
    if (!t) continue;
    if (t === "quant-research") {
      set.add("equity-research");
      set.add("financial-analysis-core");
    } else {
      set.add(t);
    }
  }
  return [...set];
}

export function isFsiActive(): boolean {
  const r = getResolvedFsi();
  if (!r.enabled) return false;
  return r.enabled || resolveEnabledFsiBundles().length > 0;
}

function vendorHasContent(): boolean {
  const probe = join(
    getFsiVendorDir(),
    "plugins/vertical-plugins/equity-research/skills/earnings-analysis/SKILL.md"
  );
  return existsSync(probe);
}

function submoduleHasContent(): boolean {
  const probe = join(
    getFsiSubmoduleDir(),
    "plugins/vertical-plugins/equity-research/skills/earnings-analysis/SKILL.md"
  );
  return existsSync(probe);
}

/** 内容根目录：vendor（内置）> submodule > 环境变量覆盖 */
export function getFsiContentRoot(): string | null {
  const override = getResolvedFsi().contentRootOverride;
  if (override && existsSync(override)) return override;
  if (vendorHasContent()) return getFsiVendorDir();
  if (submoduleHasContent()) return getFsiSubmoduleDir();
  if (override) return null;
  return null;
}

export function getBundledManifestPath(): string {
  return join(getFsiPackDir(), "manifest.json");
}

export function shouldValidateFsiOutput(): boolean {
  return getResolvedFsi().validateOutput;
}

export function maxSkillInjectTotalChars(): number {
  return getResolvedFsi().maxSkillInjectChars;
}

export function shouldApplyFsiAgentMappings(): boolean {
  return getResolvedFsi().applyAgentMappings;
}

export function shouldSeedFsiMcpCatalog(): boolean {
  return getResolvedFsi().seedMcpCatalog;
}

export function getFsiConfigSnapshot() {
  const r = getResolvedFsi();
  return {
    ...r,
    contentRootResolved: getFsiContentRoot(),
    active: isFsiActive(),
    bundlesExpanded: resolveEnabledFsiBundles(),
  };
}

export function resetFsiConfigCacheForTests(): void {
  resolved = null;
}
