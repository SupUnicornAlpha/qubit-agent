/**
 * Agent binding service (F-P0-06 fix).
 *
 * 提供「带 sentinel 写入 + 跨 seed 持久」的 agent_definition 字段更新入口。
 * Seed / sync 路径会在 UPSERT 时检测 user_overrides_json 上对应 key 是否 true，
 * true 就跳过该字段 → user 的 binding 不会被启动期 seed 抹掉。
 *
 * 涉及字段一律 user-可改：mcpServersJson / toolsJson / skillsJson /
 *   subscriptionsJson / systemPrompt / llmProvider / llmConfigJson /
 *   outputsJson / maxIterations / sandboxPolicyId / enabled。
 * 不暴露 role / name / version（架构语义字段，user 不该改）。
 *
 * 兼容性：本模块**只**写 agent_definition 和 user_overrides_json，不写
 *   agent_definition_release / draft（那两张表负责"版本化发布"语义，正交）。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";

/**
 * Fields users are allowed to bind (and that seed / sync should respect when
 * the corresponding sentinel is set).
 *
 * Key = DB column name (snake_case, matches user_overrides_json key).
 * 保持 snake_case 以便直连 SQL 一句 `json_extract(user_overrides_json, '$.mcp_servers_json')`
 * 即可读出 sentinel，不需要在前端/脚本里做 camel/snake 互转。
 */
export const USER_BINDABLE_FIELDS = [
  "system_prompt",
  "tools_json",
  "mcp_servers_json",
  "skills_json",
  "subscriptions_json",
  "llm_provider",
  "llm_config_json",
  "outputs_json",
  "max_iterations",
  "sandbox_policy_id",
  "enabled",
] as const;

export type UserBindableField = (typeof USER_BINDABLE_FIELDS)[number];

const USER_BINDABLE_FIELD_SET: ReadonlySet<string> = new Set(USER_BINDABLE_FIELDS);

export function isUserBindableField(name: string): name is UserBindableField {
  return USER_BINDABLE_FIELD_SET.has(name);
}

/**
 * Parse `user_overrides_json` into a plain Record. Tolerates `null` / string /
 * malformed JSON: invalid input → empty map (we never throw on read-side).
 */
export function parseUserOverrides(raw: unknown): Record<string, boolean> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseUserOverrides(parsed);
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (USER_BINDABLE_FIELD_SET.has(k) && v === true) out[k] = true;
    }
    return out;
  }
  return {};
}

/** Whether seed / sync should preserve `field` for this row. */
export function shouldPreserveField(rawOverrides: unknown, field: UserBindableField): boolean {
  const map = parseUserOverrides(rawOverrides);
  return map[field] === true;
}

/**
 * Input shape accepted by `setAgentDefinitionBindings()`. Each key is optional;
 * keys not present are left untouched on the row. Setting `value: null` for
 * an array column resets to seed default on next reload (clearOverride=true).
 */
export interface AgentDefinitionBindingInput {
  mcpServers?: string[] | null;
  tools?: string[] | null;
  skills?: string[] | null;
  subscriptions?: string[] | null;
  systemPrompt?: string | null;
  llmProvider?: string | null;
  llmConfig?: Record<string, unknown> | null;
  outputs?: string[] | null;
  maxIterations?: number | null;
  sandboxPolicyId?: string | null;
  enabled?: boolean | null;
  /**
   * `false`（默认）：写入字段并把对应 sentinel 标 `true`（user-owned，跨 seed 持久）。
   * `true`：清掉对应 sentinel（回归 seed 管理）；如果同时给了 value，下次 seed 仍会覆盖。
   */
  clearOverride?: boolean;
}

export interface AgentDefinitionBindingResult {
  definitionId: string;
  changedFields: UserBindableField[];
  overridesAfter: Record<string, boolean>;
}

const FIELD_TO_COLUMN: Record<keyof Omit<AgentDefinitionBindingInput, "clearOverride">, UserBindableField> = {
  mcpServers: "mcp_servers_json",
  tools: "tools_json",
  skills: "skills_json",
  subscriptions: "subscriptions_json",
  systemPrompt: "system_prompt",
  llmProvider: "llm_provider",
  llmConfig: "llm_config_json",
  outputs: "outputs_json",
  maxIterations: "max_iterations",
  sandboxPolicyId: "sandbox_policy_id",
  enabled: "enabled",
};

/**
 * Set zero or more bindings on a single agent_definition row, and mark each
 * touched field as user-overridden so seed / sync won't trample it.
 *
 * 设计选择：先 SELECT 当前 overrides → 计算 next overrides → 一次 UPDATE 同时写
 * 所有 changed columns + new overrides + updatedAt。避免多次 round-trip 在 watcher
 * 触发的并发 reload 时出现局部更新窗口。
 */
export async function setAgentDefinitionBindings(
  definitionId: string,
  input: AgentDefinitionBindingInput
): Promise<AgentDefinitionBindingResult> {
  const db = await getDb();
  const existing = await db
    .select({
      id: agentDefinition.id,
      userOverridesJson: agentDefinition.userOverridesJson,
    })
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!existing[0]) {
    throw new Error(`agent definition not found: ${definitionId}`);
  }
  const overridesBefore = parseUserOverrides(existing[0].userOverridesJson);

  const set: Record<string, unknown> = {};
  const changed: UserBindableField[] = [];
  const overridesAfter: Record<string, boolean> = { ...overridesBefore };
  const clear = input.clearOverride === true;

  for (const [key, col] of Object.entries(FIELD_TO_COLUMN) as Array<
    [keyof typeof FIELD_TO_COLUMN, UserBindableField]
  >) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    /**
     * 接受 null 作为「显式清空」语义：array 字段 → [], string → "", number → seed
     * 默认下一次 seed 写入时填回。这等价于"我撤回我的 binding"。
     */
    if (value === null) {
      const reset = resetValueFor(col);
      if (reset !== undefined) {
        set[mapColumnNameToDrizzleField(col)] = reset;
        changed.push(col);
      }
      if (clear) {
        delete overridesAfter[col];
      } else {
        /**
         * 显式 null 也算 user-edit（user 想留空），所以 sentinel 仍设 true，
         * 否则下次 seed 又把 SEED_AGENT_DEFINITIONS 的列表填回去。
         */
        overridesAfter[col] = true;
      }
      continue;
    }
    set[mapColumnNameToDrizzleField(col)] = value;
    changed.push(col);
    if (clear) {
      delete overridesAfter[col];
    } else {
      overridesAfter[col] = true;
    }
  }

  if (changed.length === 0 && !clear) {
    return { definitionId, changedFields: [], overridesAfter };
  }

  set["userOverridesJson"] = overridesAfter;
  set["updatedAt"] = new Date().toISOString();
  await db.update(agentDefinition).set(set).where(eq(agentDefinition.id, definitionId));

  return { definitionId, changedFields: changed, overridesAfter };
}

/**
 * Clear all `user_overrides_json` flags for one definition (回归 seed 管理）。
 * 不动列实际值——下次启动 seed 会按 SEED_AGENT_DEFINITIONS 重置。
 */
export async function clearAgentDefinitionOverrides(definitionId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(agentDefinition)
    .set({ userOverridesJson: {}, updatedAt: new Date().toISOString() })
    .where(eq(agentDefinition.id, definitionId));
}

/**
 * Bulk variant：清掉所有内置 def 的 overrides。被 builtin/reload (force=true) 复用，
 * 等价于 factory reset。返回被重置的行数。
 */
export async function clearAllAgentDefinitionOverrides(): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ id: agentDefinition.id }).from(agentDefinition);
  let count = 0;
  for (const row of rows) {
    await db
      .update(agentDefinition)
      .set({ userOverridesJson: {}, updatedAt: new Date().toISOString() })
      .where(eq(agentDefinition.id, row.id));
    count += 1;
  }
  return count;
}

function mapColumnNameToDrizzleField(col: UserBindableField): string {
  switch (col) {
    case "system_prompt":
      return "systemPrompt";
    case "tools_json":
      return "toolsJson";
    case "mcp_servers_json":
      return "mcpServersJson";
    case "skills_json":
      return "skillsJson";
    case "subscriptions_json":
      return "subscriptionsJson";
    case "llm_provider":
      return "llmProvider";
    case "llm_config_json":
      return "llmConfigJson";
    case "outputs_json":
      return "outputsJson";
    case "max_iterations":
      return "maxIterations";
    case "sandbox_policy_id":
      return "sandboxPolicyId";
    case "enabled":
      return "enabled";
  }
}

function resetValueFor(col: UserBindableField): unknown {
  switch (col) {
    case "tools_json":
    case "mcp_servers_json":
    case "skills_json":
    case "subscriptions_json":
    case "outputs_json":
      return [];
    case "llm_config_json":
      return {};
    case "system_prompt":
      return "";
    case "llm_provider":
      return undefined; // skip — provider is required, can't null out
    case "max_iterations":
      return undefined;
    case "sandbox_policy_id":
      return undefined;
    case "enabled":
      return undefined;
  }
}
