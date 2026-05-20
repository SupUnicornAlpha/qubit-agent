-- M1: Provider 抽象层
-- 所有外部能力（因子计算、规则引擎、回测引擎、实盘 EMS、行情源、LLM、因子挖掘）
-- 通过 Provider 接口隔离，业务模块经 ProviderResolver 解析使用，无需直接 import 具体实现。
-- 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4。

CREATE TABLE IF NOT EXISTS `provider_registry` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `provider_key` text NOT NULL,
  `display_name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `capability_json` text NOT NULL DEFAULT '{}',
  `config_json` text NOT NULL DEFAULT '{}',
  `status` text NOT NULL DEFAULT 'enabled',
  `priority` integer NOT NULL DEFAULT 50,
  `version` text NOT NULL DEFAULT '0.1.0',
  `is_builtin` integer NOT NULL DEFAULT 0,
  `is_fallback` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_provider_registry_kind_key`
  ON `provider_registry` (`kind`, `provider_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_registry_kind_status`
  ON `provider_registry` (`kind`, `status`, `priority` DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `provider_binding` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `scope_id` text,
  `kind` text NOT NULL,
  `provider_id` text NOT NULL REFERENCES `provider_registry`(`id`) ON DELETE CASCADE,
  `params_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_provider_binding_scope_kind`
  ON `provider_binding` (`scope`, `scope_id`, `kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_provider_binding_unique`
  ON `provider_binding` (`scope`, `scope_id`, `kind`);
