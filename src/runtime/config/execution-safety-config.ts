import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExecutionSafetyConfig {
  dryRunOnly: boolean;
  requireDoubleConfirm: boolean;
  confirmTokenTtlSec: number;
  finalRiskScoreThreshold: number;
}

const DEFAULT_CONFIG: ExecutionSafetyConfig = {
  dryRunOnly: true,
  requireDoubleConfirm: true,
  confirmTokenTtlSec: 300,
  finalRiskScoreThreshold: 0.75,
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export async function loadExecutionSafetyConfig(rootDir = process.cwd()): Promise<ExecutionSafetyConfig> {
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "execution-safety.json");
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return DEFAULT_CONFIG;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ExecutionSafetyConfig>;
    return {
      dryRunOnly: Boolean(parsed.dryRunOnly ?? DEFAULT_CONFIG.dryRunOnly),
      requireDoubleConfirm: Boolean(parsed.requireDoubleConfirm ?? DEFAULT_CONFIG.requireDoubleConfirm),
      confirmTokenTtlSec: clamp(Number(parsed.confirmTokenTtlSec ?? DEFAULT_CONFIG.confirmTokenTtlSec), 30, 3600),
      finalRiskScoreThreshold: clamp(
        Number(parsed.finalRiskScoreThreshold ?? DEFAULT_CONFIG.finalRiskScoreThreshold),
        0,
        1
      ),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveExecutionSafetyConfig(
  input: Partial<ExecutionSafetyConfig>,
  rootDir = process.cwd()
): Promise<ExecutionSafetyConfig> {
  const current = await loadExecutionSafetyConfig(rootDir);
  const next: ExecutionSafetyConfig = {
    dryRunOnly: input.dryRunOnly ?? current.dryRunOnly,
    requireDoubleConfirm: input.requireDoubleConfirm ?? current.requireDoubleConfirm,
    confirmTokenTtlSec: clamp(Number(input.confirmTokenTtlSec ?? current.confirmTokenTtlSec), 30, 3600),
    finalRiskScoreThreshold: clamp(
      Number(input.finalRiskScoreThreshold ?? current.finalRiskScoreThreshold),
      0,
      1
    ),
  };
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "execution-safety.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
