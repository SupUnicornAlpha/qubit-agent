CREATE TABLE IF NOT EXISTS `trading_module_control` (
  `id` text PRIMARY KEY NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `reason` text,
  `changed_by` text,
  `revision` integer NOT NULL DEFAULT 0,
  `changed_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `trading_module_control` (`id`, `enabled`, `revision`, `changed_at`)
VALUES ('global', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
