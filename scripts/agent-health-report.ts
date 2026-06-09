#!/usr/bin/env bun
/**
 * Agent 健康度报告 CLI（Round 9 复盘 2026-06-09 新增）。
 *
 * 用法：
 *   bun run scripts/agent-health-report.ts \
 *     --workflow-ids="uuid1,uuid2,..."     # 必填或从 evaluation summary 自动读
 *     --round-label="round10"               # 报告标题；默认 health-<ts>
 *     --output-dir="./out/agent-readiness-eval-roundXX"  # 默认 ./out/agent-health
 *     [--from-dir="./out/agent-readiness-eval-roundXX"]  # 不传 --workflow-ids 时
 *                                                          # 从该目录的 *.json 自动提取
 *     [--db-path=...]                       # 默认 {QUBIT_DATA_DIR}/db/core.sqlite
 *
 * 行为：
 *   - 调 health-aggregator 跨 workflow 汇总 tool/mcp/llm/skill/error 5 维度
 *   - 写 markdown 摘要、json 原数据到 --output-dir/health-report.{md,json}
 *   - 写 .canvas.tsx 到 Cursor canvases 目录（用 resolveCanvasDir）
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { aggregateHealth, renderHealthMarkdown } from "../src/runtime/agent-readiness/health-aggregator";
import { writeHealthCanvas } from "../src/runtime/agent-readiness/health-canvas";

interface Args {
  workflowIds: string[];
  roundLabel: string;
  outputDir: string;
  fromDir?: string | undefined;
  dbPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  const ids = get("workflow-ids");
  const fromDir = get("from-dir");
  const roundLabel = get("round-label") ?? `health-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const outputDir = resolve(get("output-dir") ?? "./out/agent-health");
  const dbPath = get("db-path") ?? defaultDbPath();

  const workflowIds = ids
    ? ids.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return { workflowIds, roundLabel, outputDir, fromDir, dbPath };
}

function defaultDbPath(): string {
  const dataDir =
    process.env["QUBIT_DATA_DIR"] ??
    join(homedir(), "Library", "Application Support", "app.qubit.agent");
  return join(dataDir, "db", "core.sqlite");
}

/**
 * 从评测输出目录的 `<scenario>-<workflowId>-<ts>.json` 文件名里提取 workflowRunId。
 *
 * run-readiness-evaluation.ts 把每个 scenario 的报告写成
 *   `${scenario}-${workflowRunId}-${ts}.json`
 * 我们利用这个约定批量提取，避免 caller 手抄 UUID。
 */
async function loadWorkflowIdsFromDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const ids = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name.startsWith("trace-")) continue;
    // 形如 strategy-1b8f9ff1-3d2d-4001-b76a-9e085e48c136-2026-06-08T12-41-39-538Z.json
    // 取掉 .json 后倒数第 6 段（year-month-day-Thh-mm-ss-msZ 共 5 段）后是 UUID 的最后段
    const stem = name.replace(/\.json$/, "");
    const parts = stem.split("-");
    // UUID 是 8-4-4-4-12 = 5 段；之后是 5 段时间戳。
    // 反向找 5 段 UUID
    if (parts.length < 10) continue;
    const uuidParts = parts.slice(-10, -5);
    const uuid = uuidParts.join("-");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
      ids.add(uuid);
    }
  }
  // 兜底：尝试解析 evaluation-summary 里的 workflowRunId 字段
  if (ids.size === 0) {
    for (const name of entries) {
      if (!name.startsWith("evaluation-summary") || !name.endsWith(".md")) continue;
      const content = await readFile(join(dir, name), "utf8");
      const matches = content.match(/workflow:\s*`([0-9a-f-]{36})`/g) ?? [];
      for (const m of matches) {
        const id = m.match(/[0-9a-f-]{36}/)?.[0];
        if (id) ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

async function main() {
  const args = parseArgs();

  let workflowIds = args.workflowIds;
  if (workflowIds.length === 0 && args.fromDir) {
    workflowIds = await loadWorkflowIdsFromDir(args.fromDir);
    console.log(
      `[health] 从 ${args.fromDir} 自动提取出 ${workflowIds.length} 个 workflow id`
    );
  }
  if (workflowIds.length === 0) {
    console.error(
      "[health] 错误：必须指定 --workflow-ids=... 或 --from-dir=<评测输出目录>"
    );
    process.exit(2);
  }

  if (!existsSync(args.dbPath)) {
    console.error(`[health] 错误：DB 不存在 ${args.dbPath}（--db-path=... 显式指定）`);
    process.exit(2);
  }

  console.log(`[health] DB:       ${args.dbPath}`);
  console.log(`[health] round:    ${args.roundLabel}`);
  console.log(`[health] output:   ${args.outputDir}`);
  console.log(`[health] workflow: ${workflowIds.length} 个`);

  await mkdir(args.outputDir, { recursive: true });

  const sqlite = new Database(args.dbPath, { readonly: true });
  let report;
  try {
    report = aggregateHealth(sqlite, workflowIds);
  } finally {
    sqlite.close();
  }

  const md = renderHealthMarkdown(report, { roundLabel: args.roundLabel });
  const mdPath = join(args.outputDir, "health-report.md");
  const jsonPath = join(args.outputDir, "health-report.json");
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`[health] markdown:  ${mdPath}`);
  console.log(`[health] json:      ${jsonPath}`);

  const canvasName = `agent-health-${args.roundLabel.replace(/\s+/g, "-").toLowerCase()}`;
  const canvasPath = await writeHealthCanvas({
    roundLabel: args.roundLabel,
    report,
    reportDir: args.outputDir,
    fileBaseName: canvasName,
  });
  if (canvasPath) {
    console.log(`[health] canvas:    ${canvasPath}`);
  } else {
    console.log(`[health] canvas:    (skipped, canvases dir not found)`);
  }

  console.log("");
  console.log("╭─ Health Summary ─");
  console.log(`│ tool calls: ${report.summary.totalToolCalls}`);
  console.log(`│ mcp calls:  ${report.summary.totalMcpCalls}`);
  console.log(`│ llm calls:  ${report.summary.totalLlmCalls}`);
  console.log(`│ tokens:     ${(report.summary.totalTokens / 1000).toFixed(0)}k`);
  console.log(`│ cost USD:   $${report.summary.totalCostUsd.toFixed(4)}`);
  console.log(`│ red tools:  ${report.summary.redToolCount}`);
  console.log(`│ red mcp:    ${report.summary.redMcpCount}`);
  console.log("╰──────────────────");
}

main().catch((err) => {
  console.error("[health] FATAL:", err);
  process.exit(1);
});
