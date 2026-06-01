/**
 * EnvironmentManager 启动期 seed —— 把代码里的"系统期望清单"upsert 到
 * `env_registry` 表，与用户编辑共存。
 *
 * 上游来源（决议 §10.5）：
 *   1) python_connectors/requirements.txt → 解析 versionSpec
 *   2) `BUILTIN_PYTHON_META` 常量 → displayName / description / capability /
 *      optional（requirements.txt 不带这些元信息）
 *   3) buildRecommendedMcpPresets() 中 transport='stdio' 的项 → 提取
 *      `npx -y pkg@ver` 中的 pkg 与 ver
 *
 * upsert 策略（参考 provider_registry 同步模式）：
 *   - 不存在 → INSERT，is_builtin=true，status=enabled，user_version_spec=null
 *   - 存在 → 仅 UPDATE 系统字段：display_name / description / version_spec /
 *            capability / source / is_builtin=true / extra_json。**不**动
 *            status / user_version_spec / optional —— 用户在 UI 改过的不会被
 *            seed 覆盖。
 *
 * 启动顺序：必须在 runMigrations() 之后；与 bootstrapProviders 同级，
 * 在 src/connectors/bootstrap.ts 里串行调用。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { envRegistry } from "../../db/sqlite/schema";
import { getPythonConnectorsDir } from "../app-paths";
import {
  buildRecommendedMcpPresets,
  type RecommendedMcpPreset,
} from "../seed-recommended-mcp-servers";
import type { EnvSource, SeedExpectedPackage } from "./types";

/**
 * Python 包的"元信息"由代码维护（requirements.txt 没法表达 displayName /
 * capability 这些）。仅列实际启用（未注释掉）的核心包。
 */
const BUILTIN_PYTHON_META: ReadonlyArray<
  Omit<SeedExpectedPackage, "kind" | "versionSpec" | "source">
> = [
  {
    name: "numpy",
    displayName: "NumPy",
    description: "数值计算基础库；pandas / scipy 的依赖底座，所有 Python connector 都需要。",
    optional: false,
    capability: "core",
  },
  {
    name: "pandas",
    displayName: "pandas",
    description: "DataFrame 处理；akshare / yfinance / 回测引擎全部依赖。",
    optional: false,
    capability: "core",
  },
  {
    name: "akshare",
    displayName: "AKShare",
    description:
      "国内 A 股 / 港股 / 期货数据源（免费）。klinesDataSource=akshare 时启用。",
    optional: true,
    capability: "data-source/akshare",
  },
  {
    name: "yfinance",
    displayName: "yfinance",
    description:
      "Yahoo Finance 全量数据（OHLCV / 分红 / 财报 / Ticker.info）。klinesDataSource=yfinance 或调用 fetch_dividends/fetch_earnings/fetch_asset_info 时启用。",
    optional: true,
    capability: "data-source/yfinance",
  },
  {
    name: "pytest",
    displayName: "pytest",
    description: "Python 单测框架（开发依赖；不影响 runtime）。",
    optional: true,
    capability: "dev",
  },
];

/**
 * 解析 requirements.txt 中"未注释行"为 `{name, versionSpec}` 字典；
 * 跳过空行 / `#` 注释 / `-r xxx` 等指令行。
 */
export function parseRequirementsTxt(
  content: string
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const cleaned = line.replace(/\s+#.*$/, "").trim();
    if (!cleaned) continue;
    const m = cleaned.match(/^([A-Za-z0-9_.-]+)\s*([<>=!~]=?\s*[^;]+)?$/);
    if (!m) continue;
    const [, name, spec] = m;
    out.set(name.toLowerCase(), spec ? spec.replace(/\s+/g, "") : null);
  }
  return out;
}

function resolveRequirementsPath(): string {
  return join(getPythonConnectorsDir(), "requirements.txt");
}

function readRequirementsMap(): Map<string, string | null> {
  const p = resolveRequirementsPath();
  if (!existsSync(p)) {
    console.warn(
      `[Seed:env] requirements.txt not found at ${p}; Python seed will fall back to BUILTIN_PYTHON_META defaults.`
    );
    return new Map();
  }
  try {
    return parseRequirementsTxt(readFileSync(p, "utf-8"));
  } catch (e) {
    console.warn(
      `[Seed:env] failed to read requirements.txt: ${(e as Error).message}`
    );
    return new Map();
  }
}

/** 从 `npx -y pkg@ver` / `npx -y pkg@ver --flag` 提取 (pkg, ver)；不识别返回 null */
export function parseNpxCommand(
  command: string | undefined
): { pkg: string; version: string | null; rawArgs: string[] } | null {
  if (!command) return null;
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "npx") return null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith("-")) i += 1;
  const target = tokens[i];
  if (!target) return null;
  const rawArgs = tokens.slice(i + 1);
  const at = target.lastIndexOf("@");
  if (at <= 0) return { pkg: target, version: null, rawArgs };
  return {
    pkg: target.slice(0, at),
    version: target.slice(at + 1) || null,
    rawArgs,
  };
}

function buildPythonSeed(): SeedExpectedPackage[] {
  const reqs = readRequirementsMap();
  return BUILTIN_PYTHON_META.map((meta) => {
    const versionSpec = reqs.get(meta.name.toLowerCase()) ?? undefined;
    const source: EnvSource =
      versionSpec !== undefined ? "requirements" : "connector-meta";
    return {
      kind: "python" as const,
      name: meta.name,
      displayName: meta.displayName,
      description: meta.description,
      versionSpec: versionSpec ?? undefined,
      optional: meta.optional,
      capability: meta.capability,
      source,
    };
  });
}

function buildNpmSeed(presets: RecommendedMcpPreset[]): SeedExpectedPackage[] {
  const out: SeedExpectedPackage[] = [];
  for (const p of presets) {
    if (p.transport !== "stdio") continue;
    const parsed = parseNpxCommand(p.command);
    if (!parsed) continue;
    out.push({
      kind: "npm" as const,
      name: parsed.pkg,
      displayName: p.name,
      description: p.description,
      versionSpec: parsed.version ? `==${parsed.version}` : undefined,
      optional: p.name.includes("fmp"),
      capability: `mcp/${p.name}`,
      source: "seed-mcp",
      extra: {
        npxArgs: parsed.rawArgs,
        registrySlug: p.registrySlug,
        mcpServerName: p.name,
      },
    });
  }
  return out;
}

/**
 * 把代码 seed 的系统期望项 upsert 到 env_registry。
 * 测试可通过 `mcpPresetsOverride` 注入；默认走 buildRecommendedMcpPresets()。
 */
export async function seedEnvRegistry(
  mcpPresetsOverride?: RecommendedMcpPreset[]
): Promise<{ inserted: number; updated: number; total: number }> {
  const db = await getDb();
  const presets = mcpPresetsOverride ?? buildRecommendedMcpPresets();
  const seeds: SeedExpectedPackage[] = [
    ...buildPythonSeed(),
    ...buildNpmSeed(presets),
  ];

  let inserted = 0;
  let updated = 0;

  for (const s of seeds) {
    const existing = await db
      .select()
      .from(envRegistry)
      .where(and(eq(envRegistry.kind, s.kind), eq(envRegistry.packageName, s.name)))
      .limit(1);

    const extraJson = (s.extra ?? {}) as Record<string, unknown>;
    const versionSpec = s.versionSpec ?? null;

    if (existing[0]) {
      await db
        .update(envRegistry)
        .set({
          displayName: s.displayName,
          description: s.description,
          versionSpec,
          capability: s.capability,
          source: s.source,
          isBuiltin: true,
          extraJson,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(envRegistry.id, existing[0].id));
      updated += 1;
    } else {
      await db.insert(envRegistry).values({
        id: randomUUID(),
        kind: s.kind,
        packageName: s.name,
        displayName: s.displayName,
        description: s.description,
        versionSpec,
        userVersionSpec: null,
        optional: s.optional,
        capability: s.capability,
        source: s.source,
        status: "enabled",
        isBuiltin: true,
        extraJson,
      });
      inserted += 1;
    }
  }

  console.log(
    `[Seed:env] env_registry upsert ok: total=${seeds.length} inserted=${inserted} updated=${updated}`
  );
  return { inserted, updated, total: seeds.length };
}

if (import.meta.main) {
  void seedEnvRegistry().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
