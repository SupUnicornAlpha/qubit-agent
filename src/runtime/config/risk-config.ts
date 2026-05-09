import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RiskRuntimeConfig {
  vetoThreshold: number;
  blockConfidenceThreshold: number;
  severityMode: "conservative" | "balanced" | "aggressive";
}

const DEFAULT_CONFIG: RiskRuntimeConfig = {
  vetoThreshold: 0.7,
  blockConfidenceThreshold: 0.35,
  severityMode: "balanced",
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export async function loadRiskConfig(rootDir = process.cwd()): Promise<RiskRuntimeConfig> {
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "risk.json");
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return DEFAULT_CONFIG;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<RiskRuntimeConfig>;
    return {
      vetoThreshold: clamp01(Number(parsed.vetoThreshold ?? DEFAULT_CONFIG.vetoThreshold)),
      blockConfidenceThreshold: clamp01(
        Number(parsed.blockConfidenceThreshold ?? DEFAULT_CONFIG.blockConfidenceThreshold)
      ),
      severityMode: (parsed.severityMode as RiskRuntimeConfig["severityMode"]) ?? DEFAULT_CONFIG.severityMode,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveRiskConfig(
  input: Partial<RiskRuntimeConfig>,
  rootDir = process.cwd()
): Promise<RiskRuntimeConfig> {
  const current = await loadRiskConfig(rootDir);
  const next: RiskRuntimeConfig = {
    vetoThreshold: clamp01(Number(input.vetoThreshold ?? current.vetoThreshold)),
    blockConfidenceThreshold: clamp01(
      Number(input.blockConfidenceThreshold ?? current.blockConfidenceThreshold)
    ),
    severityMode: (input.severityMode as RiskRuntimeConfig["severityMode"]) ?? current.severityMode,
  };
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "risk.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
