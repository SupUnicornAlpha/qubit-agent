-- EnvironmentManager P1 — 期望清单 + 安装历史（详见 docs/ENVIRONMENT_MANAGER_DESIGN.md §4.3 / §6.0）
--
-- 改动总览：
--   1) 新表 env_registry：把"期望装哪些 Python pip 包 / mcp-bin 下哪些 npm
--      stdio 包"沉淀到 DB。代码层有 seed-env-registry.ts 在启动时 upsert
--      系统默认（pandas/numpy/akshare/yfinance + 推荐 MCP）；用户在 UI 改
--      过的 status / user_version_spec / display_name 不会被 seed 覆盖
--      （参考 provider_registry 的 sync 模式）。
--   2) 新表 env_install_log：单包 install/uninstall 是异步任务（pip 装包
--      可能 5-30s），路由写一行 status='running' 立即返回 logId，前端短
--      轮询查 status；失败时 errorMessage 留 stderr 前 800 字符，便于排障。
--
-- 兼容性：两表均为新增；旧代码不读不写，0 风险。回滚见 down-0058.sql（手写 DROP）。
-- 决策落地点：
--   - kind 仅枚举 python / npm；HTTP/WS 类 MCP 不入 npm 视图（决议 §10.6）。
--   - is_builtin=true 的行不允许 DELETE，只允许 status=disabled。
--   - source='user' + is_builtin=false → 完全用户自建，CRUD 不受限。

-- ───────────────────────── env_registry ─────────────────────────
CREATE TABLE IF NOT EXISTS `env_registry` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `kind` TEXT NOT NULL,                       -- 'python' | 'npm'
  `package_name` TEXT NOT NULL,               -- 'yfinance' / '@houtini/fmp-mcp'
  `display_name` TEXT NOT NULL,
  `description` TEXT NOT NULL DEFAULT '',
  `version_spec` TEXT,                        -- 系统默认（来自 seed），如 '>=0.2.40'
  `user_version_spec` TEXT,                   -- 用户在 UI 覆写，优先于 version_spec
  `optional` INTEGER NOT NULL DEFAULT 1,      -- 1=可选；0=必需
  `capability` TEXT NOT NULL DEFAULT 'misc',  -- 'data-source/yfinance' 等
  `source` TEXT NOT NULL DEFAULT 'user',      -- 'requirements'|'connector-meta'|'seed-mcp'|'user'
  `status` TEXT NOT NULL DEFAULT 'enabled',   -- 'enabled' | 'disabled'
  `is_builtin` INTEGER NOT NULL DEFAULT 0,    -- 1=系统默认（不可 DELETE）；0=用户自建
  `extra_json` TEXT NOT NULL DEFAULT '{}',    -- 透传字段，如 npm 的 npxArgs
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS `idx_env_registry_kind_pkg`
  ON `env_registry` (`kind`, `package_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_env_registry_kind_status_cap`
  ON `env_registry` (`kind`, `status`, `capability`);
--> statement-breakpoint

-- ───────────────────────── env_install_log ─────────────────────────
CREATE TABLE IF NOT EXISTS `env_install_log` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `kind` TEXT NOT NULL,                       -- 'python' | 'npm'
  `operation` TEXT NOT NULL,                  -- 'install' | 'uninstall' | 'upgrade'
  `package_name` TEXT NOT NULL,
  `requested_version` TEXT,                   -- 用户请求的版本（可空）
  `installed_version` TEXT,                   -- 安装成功后实际落定的版本
  `status` TEXT NOT NULL,                     -- 'running' | 'success' | 'failed' | 'timeout'
  `error_message` TEXT,                       -- stderr 截断 800 字符
  `started_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `finished_at` TEXT,
  `triggered_by` TEXT NOT NULL DEFAULT 'user' -- 'user' | 'bootstrap' | 'connector_init' | 'test'
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_env_install_log_kind_pkg_started`
  ON `env_install_log` (`kind`, `package_name`, `started_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_env_install_log_status_started`
  ON `env_install_log` (`status`, `started_at` DESC);
