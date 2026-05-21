/**
 * MemoryWorkspaceSync — M10.A2
 *
 * 把指定 Agent 的长期记忆从 DB 渲染成 markdown，写入：
 *   <packRoot>/memory.md          — 给 mergeSystemPrompt 注入到 ## Memory 段
 *   <packRoot>/workspace/memory.md — 给用户在 workspace 子目录里看到
 *
 * 触发：
 *   - consolidateFromWorkflow 完成后自动同步参与的每个 agent（A1→A2 链）
 *   - 也可由 Agent 主动调 memory.refresh_workspace 工具触发
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentProfile,
  longtermMemory,
  midtermMemory,
} from "../../db/sqlite/schema";
import { config } from "../../config";
import { resolvePackRoot } from "../agent/agent-pack-service";

const SYNC_HEADER =
  "<!-- Auto-synced from DB by MemoryConsolidationService. Manual edits will be overwritten. -->\n";

const MAX_LONGTERM_PER_TYPE = 10;
const MAX_MIDTERM = 8;

export interface SyncMemoryResult {
  packRoot: string;
  packMemoryPath: string;
  workspaceMemoryPath: string;
  longtermCount: number;
  midtermCount: number;
}

export async function syncMemoryFromDb(definitionId: string): Promise<SyncMemoryResult | null> {
  const db = await getDb();
  const defRows = await db.select().from(agentDefinition).where(eq(agentDefinition.id, definitionId)).limit(1);
  const def = defRows[0];
  if (!def) return null;

  const profRows = await db.select().from(agentProfile).where(eq(agentProfile.definitionId, definitionId)).limit(1);
  const prof = profRows[0];

  const packRoot = resolvePackRoot(
    config.dataDir,
    definitionId,
    prof?.configRootUri ?? ""
  );
  const workspaceDir = join(packRoot, "workspace");
  const packMemoryPath = join(packRoot, "memory.md");
  const workspaceMemoryPath = join(workspaceDir, "memory.md");

  await mkdir(workspaceDir, { recursive: true });

  // 1. 拉 longterm（按 memoryType 分组）
  const longtermRows = await db
    .select()
    .from(longtermMemory)
    .where(eq(longtermMemory.definitionId, definitionId))
    .orderBy(desc(longtermMemory.asofTime))
    .limit(MAX_LONGTERM_PER_TYPE * 5);

  const longtermByType = new Map<string, typeof longtermRows>();
  for (const row of longtermRows) {
    const list = longtermByType.get(row.memoryType) ?? [];
    if (list.length < MAX_LONGTERM_PER_TYPE) {
      list.push(row);
      longtermByType.set(row.memoryType, list);
    }
  }

  // 2. 拉 midterm（按 asofTime desc）
  const midtermRows = await db
    .select()
    .from(midtermMemory)
    .where(eq(midtermMemory.definitionId, definitionId))
    .orderBy(desc(midtermMemory.asofTime))
    .limit(MAX_MIDTERM);

  // 3. 渲染 markdown
  const md = renderMemoryMarkdown({
    definitionName: def.name,
    role: def.role,
    longtermByType,
    midtermRows,
  });

  await writeFile(packMemoryPath, SYNC_HEADER + md, "utf-8");
  await writeFile(workspaceMemoryPath, SYNC_HEADER + md, "utf-8");

  return {
    packRoot,
    packMemoryPath,
    workspaceMemoryPath,
    longtermCount: longtermRows.length,
    midtermCount: midtermRows.length,
  };
}

interface RenderInput {
  definitionName: string;
  role: string;
  longtermByType: Map<string, Array<{
    id: string;
    memoryType: string;
    contentJson: unknown;
    confidenceScore: number | null;
    asofTime: string;
    validFrom: string;
    validTo: string | null;
  }>>;
  midtermRows: Array<{
    id: string;
    memoryType: string;
    contentJson: unknown;
    asofTime: string;
    timeWindowStart: string;
    timeWindowEnd: string;
  }>;
}

export function renderMemoryMarkdown(input: RenderInput): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# Long-term Memory · ${input.definitionName} (${input.role})`);
  lines.push("");
  lines.push(`> 由 MemoryConsolidationService 自动维护；同步时间：${now}`);
  lines.push("");

  // Long-term
  if (input.longtermByType.size > 0) {
    lines.push("## 长期记忆（longterm）");
    lines.push("");
    for (const [memoryType, rows] of input.longtermByType.entries()) {
      lines.push(`### ${memoryType} (${rows.length})`);
      lines.push("");
      for (const row of rows) {
        const content = extractContent(row.contentJson);
        const confidence = row.confidenceScore != null ? ` · conf=${row.confidenceScore.toFixed(2)}` : "";
        lines.push(`- **${row.asofTime.slice(0, 10)}**${confidence}: ${truncate(content, 280)}`);
      }
      lines.push("");
    }
  } else {
    lines.push("## 长期记忆（longterm）");
    lines.push("");
    lines.push("_暂无长期记忆。Agent 完成工作流后会自动归纳；也可主动调 memory.consolidate_longterm 工具。_");
    lines.push("");
  }

  // Mid-term
  if (input.midtermRows.length > 0) {
    lines.push("## 近期工作流总结（midterm）");
    lines.push("");
    for (const row of input.midtermRows) {
      const content = extractContent(row.contentJson);
      lines.push(`### ${row.asofTime.slice(0, 16).replace("T", " ")} · ${row.memoryType}`);
      lines.push("");
      lines.push(truncate(content, 500));
      lines.push("");
    }
  } else {
    lines.push("## 近期工作流总结（midterm）");
    lines.push("");
    lines.push("_暂无中期记忆。完成一次工作流后会自动生成。_");
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("_此文件由系统自动同步，请勿手工编辑。如需添加长期经验，使用 `write_memory` 工具，并选择合适的 layer/memoryType。_");

  return lines.join("\n");
}

function extractContent(contentJson: unknown): string {
  if (typeof contentJson === "string") return contentJson;
  if (contentJson && typeof contentJson === "object") {
    const obj = contentJson as Record<string, unknown>;
    if (typeof obj["content"] === "string") return obj["content"];
    if (typeof obj["summary"] === "string") return obj["summary"];
    return JSON.stringify(contentJson).slice(0, 500);
  }
  return String(contentJson ?? "");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + " ...(truncated)";
}

/** 把一个 workflow 涉及的所有 agent 都同步一次 memory.md */
export async function syncMemoryForWorkflow(workflowId: string): Promise<number> {
  const db = await getDb();
  const { agentInstance, agentStep } = await import("../../db/sqlite/schema");
  const rows = await db
    .selectDistinct({ definitionId: agentInstance.definitionId })
    .from(agentInstance)
    .innerJoin(agentStep, eq(agentStep.agentInstanceId, agentInstance.id))
    .where(and(eq(agentStep.workflowRunId, workflowId)));
  let count = 0;
  for (const row of rows) {
    if (!row.definitionId) continue;
    try {
      const res = await syncMemoryFromDb(row.definitionId);
      if (res) count += 1;
    } catch (err) {
      console.warn(
        `[memory-workspace-sync] failed to sync ${row.definitionId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return count;
}
