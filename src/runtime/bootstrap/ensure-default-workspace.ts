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
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workspace } from "../../db/sqlite/schema";

/**
 * 用户租户的稳定 workspace ID。
 *
 * - 区别于 a2a-pool.ts 的 `00000000-0000-4000-8000-a2a000000003`（system pool）。
 * - 选 `…-localuser0001` 后缀让运维一眼能识别 owner 类型。
 */
export const DEFAULT_USER_WORKSPACE_ID = "00000000-0000-4000-8000-localuser0001";
export const DEFAULT_USER_WORKSPACE_NAME = "Default Workspace";
export const DEFAULT_USER_WORKSPACE_OWNER = "local-user";

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
