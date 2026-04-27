import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const ModelConfigSchema = z.object({
  provider: z
    .enum(["openai", "anthropic", "ollama", "deepseek", "qwen", "zhipu", "mock"])
    .default("openai"),
  model: z.string().min(1).default("gpt-4o-mini"),
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
});

export type RuntimeModelConfig = z.infer<typeof ModelConfigSchema>;

function getModelConfigPath(rootDir = process.cwd()): string {
  return join(rootDir, ".qubit", "model.json");
}

export async function loadModelConfig(rootDir = process.cwd()): Promise<RuntimeModelConfig | null> {
  const path = getModelConfigPath(rootDir);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return ModelConfigSchema.parse(JSON.parse(raw));
}

export async function saveModelConfig(
  input: Partial<RuntimeModelConfig>,
  rootDir = process.cwd()
): Promise<RuntimeModelConfig> {
  const path = getModelConfigPath(rootDir);
  const dir = join(rootDir, ".qubit");
  await mkdir(dir, { recursive: true });
  const current = (await loadModelConfig(rootDir)) ?? ModelConfigSchema.parse({});
  const next = ModelConfigSchema.parse({
    ...current,
    ...input,
  });
  await writeFile(path, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

