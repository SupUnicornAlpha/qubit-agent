-- 扩展 communication_channel：支持 feishu / wecom / whatsapp / dingtalk
-- 注：SQLite 的 text enum 只是应用层约束，DDL 不需要改 kind 列。
-- 这里仅补充 meta_json 字段（provider 私有配置）与 communication_message_log.channel_id 反向引用。

ALTER TABLE `communication_channel` ADD COLUMN `meta_json` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE `communication_message_log` ADD COLUMN `channel_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_communication_channel_kind_enabled` ON `communication_channel` (`kind`,`enabled`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_communication_message_log_kind_created` ON `communication_message_log` (`channel_kind`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_communication_message_log_channel_created` ON `communication_message_log` (`channel_id`,`created_at`);
