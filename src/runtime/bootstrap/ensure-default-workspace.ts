/**
 * Default User Workspace ensure：写死 ID，启动期幂等 INSERT。
 *
 * 背景（2026-06-05 复盘）：
 *   前端 MonitorDashboard / MainContent / TraderLivePanel 各自有一段
 *   `if (!workspaces[0]) createWorkspace({owner: "local-user"})` 兜底，
 *   设计本意是「DB 空时新建一个用户默认 workspace」；但因为系统级
 *   A2A Pool workspace 永远占着 `workspaces[0]?.id` 这个位置，那段兜底
 *   **从未真正触发过** —— 桌面用户上车默认用的是 A2A Pool 这个 system
 *   workspace（owner="system"），所有 chat / workflow 都默认挂到
 *   `A2A Pool Project` 下，跟设计「单租户多 project」的语义完全错位。
 *
 *   叠加单测（22 个 *.test.ts 直接 INSERT 到 prod DB）和 eval 脚本
 *   （每次跑都 createWorkspace），最终 DB 攒到 26 个 workspace × 26 个
 *   project（基本 1:1），监控页根本无法按"项目"为粒度切换查看。
 *
 * 修复范式：仿照 src/runtime/a2a/a2a-pool.ts 里 A2A_POOL_WORKSPACE_ID
 * 的 ensure 写法 —— 写死稳定 ID、`INSERT OR IGNORE` 风格、bootstrap chain
 * 显式调用一次。前端不再自己 createWorkspace，所有用户 project 一律挂
 * 在这个稳定的 DEFAULT_USER_WORKSPACE_ID 下；多市场需求继续靠 project
 * 上的 marketScope 字段区分。
 *
 * 多租户保留路径：未来真的要做多租户时，DEFAULT_USER_WORKSPACE_ID 仍是
 * "local-user" 这个单租户的 workspace；新租户走 POST /api/v1/workspaces
 * 显式申请（owner 字段区分）。这个 ensure 只是给「单机桌面 / 单租户」
 * 模式做兜底默认值，不影响多租户扩展。
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { project, workspace } from "../../db/sqlite/schema";

/**
 * 用户租户的稳定 workspace ID。
 *
 * - 区别于 a2a-pool.ts 的 `00000000-0000-4000-8000-a2a000000003`（system pool）。
 * - 选 `…-localuser0001` 后缀让运维一眼能识别 owner 类型。
 */
export const DEFAULT_USER_WORKSPACE_ID = "00000000-0000-4000-8000-localuser0001";
export const DEFAULT_USER_WORKSPACE_NAME = "Default Workspace";
export const DEFAULT_USER_WORKSPACE_OWNER = "local-user";

/**
 * 用户租户的稳定 default project ID + name + marketScope。
 *
 * 历史问题：前端 4 处 boot 各自 `if (!project) createProject({name:"QUBIT Default
 * Project", marketScope:"CN-A"})`，并发上车 / 多页面同时挂载会各建一份，攒出一堆
 * 同名 project。改由后端 `GET /workspaces/default/projects/default` 统一 get-or-create：
 * 写死 ID 幂等，前端只读取不再 create。name/marketScope 沿用历史前端兜底值，保证
 * useDefaultProject 的 PREFERRED_NAMES("QUBIT Default Project") 仍能命中。
 */
export const DEFAULT_USER_PROJECT_ID = "00000000-0000-4000-8000-localproj0001";
export const DEFAULT_USER_PROJECT_NAME = "QUBIT Default Project";
export const DEFAULT_USER_PROJECT_MARKET_SCOPE = "CN-A";

export async function ensureDefaultUserWorkspace(): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, DEFAULT_USER_WORKSPACE_ID))
    .limit(1);
  if (rows[0]) return;
  await db.insert(workspace).values({
    id: DEFAULT_USER_WORKSPACE_ID,
    name: DEFAULT_USER_WORKSPACE_NAME,
    owner: DEFAULT_USER_WORKSPACE_OWNER,
  });
  console.log(
    `[QUBIT] ensured default user workspace ${DEFAULT_USER_WORKSPACE_ID} (${DEFAULT_USER_WORKSPACE_NAME})`
  );
}

/**
 * 幂等 get-or-create default project（挂在 default workspace 下）。返回 project 行。
 *
 * 优先级：
 *   1. 稳定 ID 命中 → 直接返回（最常路径）。
 *   2. default workspace 下已有同名 "QUBIT Default Project" → 复用（兼容历史前端
 *      用随机 ID 建的那批，避免再造一份；不强行迁移它们的 ID）。
 *   3. 都没有 → INSERT 稳定 ID 的新 project。
 *
 * 先 ensure workspace 再 ensure project，保证 FK（project.workspace_id）一定有父。
 */
export async function ensureDefaultUserProject(): Promise<{
  id: string;
  workspaceId: string;
  name: string;
  marketScope: string;
  status: "active" | "archived" | "paused";
}> {
  await ensureDefaultUserWorkspace();
  const db = await getDb();

  const byId = await db
    .select()
    .from(project)
    .where(eq(project.id, DEFAULT_USER_PROJECT_ID))
    .limit(1);
  if (byId[0]) return byId[0];

  const byName = await db
    .select()
    .from(project)
    .where(
      and(
        eq(project.workspaceId, DEFAULT_USER_WORKSPACE_ID),
        eq(project.name, DEFAULT_USER_PROJECT_NAME)
      )
    )
    .limit(1);
  if (byName[0]) return byName[0];

  await db.insert(project).values({
    id: DEFAULT_USER_PROJECT_ID,
    workspaceId: DEFAULT_USER_WORKSPACE_ID,
    name: DEFAULT_USER_PROJECT_NAME,
    marketScope: DEFAULT_USER_PROJECT_MARKET_SCOPE,
    status: "active",
  });
  console.log(
    `[QUBIT] ensured default user project ${DEFAULT_USER_PROJECT_ID} (${DEFAULT_USER_PROJECT_NAME})`
  );
  const created = await db
    .select()
    .from(project)
    .where(eq(project.id, DEFAULT_USER_PROJECT_ID))
    .limit(1);
  // created[0] 一定存在（刚 INSERT）；保守兜底返回常量结构防 undefined 越界。
  return (
    created[0] ?? {
      id: DEFAULT_USER_PROJECT_ID,
      workspaceId: DEFAULT_USER_WORKSPACE_ID,
      name: DEFAULT_USER_PROJECT_NAME,
      marketScope: DEFAULT_USER_PROJECT_MARKET_SCOPE,
      status: "active",
    }
  );
}
