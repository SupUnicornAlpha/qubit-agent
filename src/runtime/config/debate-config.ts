import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DebateRuntimeConfig {
  confidenceThreshold: number;
  maxRounds: number;
}

const DEFAULT_CONFIG: DebateRuntimeConfig = {
  confidenceThreshold: 0.55,
  maxRounds: 2,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export async function loadDebateConfig(rootDir = process.cwd()): Promise<DebateRuntimeConfig> {
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "debate.json");
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    return DEFAULT_CONFIG;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DebateRuntimeConfig>;
    return {
      confidenceThreshold: clamp01(Number(parsed.confidenceThreshold ?? DEFAULT_CONFIG.confidenceThreshold)),
      maxRounds: Math.max(1, Math.min(5, Number(parsed.maxRounds ?? DEFAULT_CONFIG.maxRounds))),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function saveDebateConfig(
  input: Partial<DebateRuntimeConfig>,
  rootDir = process.cwd()
): Promise<DebateRuntimeConfig> {
  const current = await loadDebateConfig(rootDir);
  const next: DebateRuntimeConfig = {
    confidenceThreshold: clamp01(Number(input.confidenceThreshold ?? current.confidenceThreshold)),
    maxRounds: Math.max(1, Math.min(5, Number(input.maxRounds ?? current.maxRounds))),
  };
  const dir = join(rootDir, ".qubit");
  const path = join(dir, "debate.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
