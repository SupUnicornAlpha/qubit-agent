/**
 * 推荐 MCP：数学计算 + 金融数据（来自 Anthropic 官方 Registry 与 npm 生态）。
 * @see https://registry.modelcontextprotocol.io
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { mcpServerConfig } from "../db/sqlite/schema";

/** 全局 MCP 服务名（projectId=null，全工作区可用） */
export const RECOMMENDED_MCP_NAMES = {
  MATHJS: "mathjs",
  TRADINGCALC: "tradingcalc",
  FINANCEX: "mcp-financex",
  FMP: "fmp-mcp",
} as const;

export type RecommendedMcpPreset = {
  name: string;
  transport: "stdio" | "http" | "ws";
  command?: string;
  url?: string;
  capabilitiesJson?: Record<string, unknown>;
  /** Anthropic MCP Registry slug（文档用） */
  registrySlug?: string;
  description: string;
};

/** 默认写入 DB 的预设（FMP 仅在环境变量存在时追加） */
export function buildRecommendedMcpPresets(): RecommendedMcpPreset[] {
  const presets: RecommendedMcpPreset[] = [
    {
      name: RECOMMENDED_MCP_NAMES.MATHJS,
      transport: "http",
      url: "https://gateway.pipeworx.io/mathjs/mcp",
      registrySlug: "io.github.pipeworx-io/mathjs",
      description: "Math.js 表达式求值（官方 Registry，免 API Key）",
    },
    {
      name: RECOMMENDED_MCP_NAMES.TRADINGCALC,
      transport: "http",
      url: "https://tradingcalc.io/api/mcp",
      registrySlug: "io.github.SKalinin909/tradingcalc",
      description: "合约/期货数学：PnL、强平、仓位、carry 等 19 个工具（官方 Registry）",
    },
    {
      name: RECOMMENDED_MCP_NAMES.FINANCEX,
      transport: "stdio",
      command: "npx -y mcp-financex@1.0.11",
      registrySlug: "npm:mcp-financex",
      description: "股票/加密行情、技术指标、期权、SEC 披露与 DCF（Yahoo，免 API Key）",
    },
  ];
  const fmpKey = process.env.FMP_API_KEY?.trim();
  if (fmpKey) {
    presets.push({
      name: RECOMMENDED_MCP_NAMES.FMP,
      transport: "stdio",
      command: "npx -y @houtini/fmp-mcp@1.1.3",
      registrySlug: "io.github.houtini-ai/fmp",
      description: "Financial Modeling Prep 250+ 工具（需 FMP_API_KEY）",
      capabilitiesJson: {
        env: { FMP_API_KEY: fmpKey },
      },
    });
  }
  return presets;
}

/** 供 Agent seed 合并的 MCP 名列表 */
export function defaultQuantMcpServers(): string[] {
  const names = [
    RECOMMENDED_MCP_NAMES.MATHJS,
    RECOMMENDED_MCP_NAMES.TRADINGCALC,
    RECOMMENDED_MCP_NAMES.FINANCEX,
  ];
  if (process.env.FMP_API_KEY?.trim()) names.push(RECOMMENDED_MCP_NAMES.FMP);
  return names;
}

export function mergeMcpServers(base: string[], extra: string[]): string[] {
  return [...new Set([...base, ...extra])];
}

export async function seedRecommendedMcpServers(): Promise<void> {
  const db = await getDb();
  const presets = buildRecommendedMcpPresets();
  let upserted = 0;

  for (const preset of presets) {
    const existing = await db
      .select()
      .from(mcpServerConfig)
      .where(and(eq(mcpServerConfig.name, preset.name), isNull(mcpServerConfig.projectId)))
      .limit(1);

    const caps = preset.capabilitiesJson ?? {
      registrySlug: preset.registrySlug,
      description: preset.description,
    };

    if (existing[0]) {
      await db
        .update(mcpServerConfig)
        .set({
          transport: preset.transport,
          command: preset.command ?? existing[0].command,
          url: preset.url ?? existing[0].url,
          capabilitiesJson: caps,
          enabled: true,
        })
        .where(eq(mcpServerConfig.id, existing[0].id));
    } else {
      await db.insert(mcpServerConfig).values({
        id: randomUUID(),
        name: preset.name,
        projectId: null,
        transport: preset.transport,
        command: preset.command ?? null,
        url: preset.url ?? null,
        capabilitiesJson: caps,
        enabled: true,
      });
    }
    upserted += 1;
  }

  console.log(
    `[Seed] Upserted ${upserted} recommended MCP servers (mathjs, tradingcalc, mcp-financex` +
      `${process.env.FMP_API_KEY?.trim() ? ", fmp-mcp" : ""}).`
  );
}

if (import.meta.main) {
  void seedRecommendedMcpServers().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
