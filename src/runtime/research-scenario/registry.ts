/**
 * ResearchScenarioRegistry：内存索引 + DB 双向同步
 *
 * 数据流：
 *   启动：BUILTIN_RESEARCH_SCENARIOS → upsert DB → load 全表到内存
 *   读取：内存优先；reload() 时重新拉 DB
 *   写入：upsert / clone / setStatus 都直接走 DB，再 reload
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  researchScenario as scenarioTable,
  researchScenarioGroup,
} from "../../db/sqlite/schema";
import type {
  CapabilityRequirement,
  FieldSchema,
  LoopDefaults,
  OutputContract,
  ResearchScenarioSpec,
  ToolPreset,
} from "./types";

export class ResearchScenarioRegistry {
  private byKey = new Map<string, ResearchScenarioSpec & { id: string }>();

  /** 进程启动：upsert 内置场景到 DB，再把全表加载进内存 */
  async bootstrap(builtin: readonly ResearchScenarioSpec[]): Promise<void> {
    for (const spec of builtin) {
      await this.upsertInternal(spec, { preserveStatus: true });
    }
    await this.reload();
  }

  /** 列出所有场景 */
  async list(filter?: { status?: "enabled" | "disabled" }): Promise<Array<ResearchScenarioSpec & { id: string }>> {
    const all = [...this.byKey.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    if (filter?.status) return all.filter((s) => s.status === filter.status);
    return all;
  }

  get(key: string): (ResearchScenarioSpec & { id: string }) | null {
    return this.byKey.get(key) ?? null;
  }

  /** 通用 upsert：用户自建场景或内置场景的字段刷新都走这里 */
  async upsert(spec: ResearchScenarioSpec): Promise<{ id: string }> {
    const id = await this.upsertInternal(spec, { preserveStatus: false });
    await this.reload();
    return { id };
  }

  /** 克隆已有场景为 disabled 新场景（避免误用） */
  async clone(
    srcKey: string,
    newKey: string,
    overrides?: Partial<ResearchScenarioSpec>
  ): Promise<{ id: string }> {
    const src = this.get(srcKey);
    if (!src) throw new Error(`scenario_not_found: ${srcKey}`);
    const dup: ResearchScenarioSpec = {
      ...src,
      ...overrides,
      key: newKey,
      isBuiltin: false,
      status: "disabled",
    };
    return this.upsert(dup);
  }

  async setStatus(key: string, status: "enabled" | "disabled"): Promise<void> {
    const db = await getDb();
    await db
      .update(scenarioTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(scenarioTable.key, key));
    await this.reload();
  }

  async reload(): Promise<void> {
    const db = await getDb();
    const rows = await db.select().from(scenarioTable);
    this.byKey.clear();
    for (const r of rows) {
      this.byKey.set(r.key, {
        id: r.id,
        key: r.key,
        displayName: r.displayName,
        description: r.description,
        defaultAgentGroupId: r.defaultAgentGroupId ?? "",
        inputSchema: (r.inputSchemaJson as Record<string, FieldSchema>) ?? {},
        outputContract: (r.outputContractJson as unknown as OutputContract) ?? {
          primary: "",
        },
        requiredCapabilities:
          (r.requiredCapabilitiesJson as unknown as CapabilityRequirement[]) ?? [],
        toolPreset: (r.toolPresetJson as unknown as ToolPreset) ?? {
          builtinTools: [],
          connectors: [],
          mcpServers: [],
          defaultParams: {},
        },
        loopDefaults: (r.loopDefaultsJson as unknown as LoopDefaults) ?? {
          maxIterations: 1,
          reactLoop: false,
        },
        status: r.status as "enabled" | "disabled",
        sortOrder: r.sortOrder,
        isBuiltin: Boolean(r.isBuiltin),
      });
    }
  }

  /** 绑定场景 → 编组（默认编组或额外编组） */
  async bindGroup(input: {
    scenarioKey: string;
    agentGroupId: string;
    isDefault?: boolean;
    sortOrder?: number;
  }): Promise<void> {
    const spec = this.get(input.scenarioKey);
    if (!spec) throw new Error(`scenario_not_found: ${input.scenarioKey}`);
    const db = await getDb();
    const existing = await db
      .select()
      .from(researchScenarioGroup)
      .where(
        and(
          eq(researchScenarioGroup.scenarioId, spec.id),
          eq(researchScenarioGroup.agentGroupId, input.agentGroupId)
        )
      )
      .limit(1);
    if (existing[0]) return;
    await db.insert(researchScenarioGroup).values({
      id: randomUUID(),
      scenarioId: spec.id,
      agentGroupId: input.agentGroupId,
      isDefault: input.isDefault ?? false,
      sortOrder: input.sortOrder ?? 100,
    });
  }

  /** 列出场景绑定的所有编组 */
  async listGroupsForScenario(
    scenarioKey: string
  ): Promise<Array<{ agentGroupId: string; isDefault: boolean; sortOrder: number }>> {
    const spec = this.get(scenarioKey);
    if (!spec) return [];
    const db = await getDb();
    const rows = await db
      .select()
      .from(researchScenarioGroup)
      .where(eq(researchScenarioGroup.scenarioId, spec.id));
    return rows
      .map((r) => ({
        agentGroupId: r.agentGroupId,
        isDefault: Boolean(r.isDefault),
        sortOrder: r.sortOrder,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  _resetForTests(): void {
    this.byKey.clear();
  }

  // ── private ──

  private async upsertInternal(
    spec: ResearchScenarioSpec,
    opts: { preserveStatus: boolean }
  ): Promise<string> {
    const db = await getDb();
    const existing = await db
      .select()
      .from(scenarioTable)
      .where(eq(scenarioTable.key, spec.key))
      .limit(1);

    if (existing[0]) {
      const id = existing[0].id;
      const newStatus = opts.preserveStatus
        ? (existing[0].status as "enabled" | "disabled")
        : spec.status;
      await db
        .update(scenarioTable)
        .set({
          displayName: spec.displayName,
          description: spec.description,
          defaultAgentGroupId: spec.defaultAgentGroupId,
          inputSchemaJson: spec.inputSchema as never,
          outputContractJson: spec.outputContract as never,
          requiredCapabilitiesJson: spec.requiredCapabilities as never,
          toolPresetJson: spec.toolPreset as never,
          loopDefaultsJson: spec.loopDefaults as never,
          status: newStatus,
          sortOrder: spec.sortOrder,
          isBuiltin: spec.isBuiltin,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(scenarioTable.id, id));
      return id;
    }
    const id = randomUUID();
    await db.insert(scenarioTable).values({
      id,
      key: spec.key,
      displayName: spec.displayName,
      description: spec.description,
      defaultAgentGroupId: spec.defaultAgentGroupId,
      inputSchemaJson: spec.inputSchema as never,
      outputContractJson: spec.outputContract as never,
      requiredCapabilitiesJson: spec.requiredCapabilities as never,
      toolPresetJson: spec.toolPreset as never,
      loopDefaultsJson: spec.loopDefaults as never,
      status: spec.status,
      sortOrder: spec.sortOrder,
      isBuiltin: spec.isBuiltin,
    });
    return id;
  }
}

export const researchScenarioRegistry = new ResearchScenarioRegistry();
