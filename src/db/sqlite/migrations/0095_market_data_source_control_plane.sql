ALTER TABLE `market_data_source` ADD COLUMN `supported_markets_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `supported_timeframes_json` text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `credential_mode` text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `credentials_ready` integer NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `health_status` text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `last_healthcheck_at` text;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `last_latency_ms` integer;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `p95_latency_ms` integer;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `success_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `failure_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `consecutive_failures` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `last_error` text;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `circuit_state` text NOT NULL DEFAULT 'closed';
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `circuit_opened_at` text;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `priority` integer NOT NULL DEFAULT 50;
--> statement-breakpoint
ALTER TABLE `market_data_source` ADD COLUMN `is_fallback` integer NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE `market_data_source_call` (
  `id` text PRIMARY KEY NOT NULL,
  `source_id` text NOT NULL,
  `market` text NOT NULL,
  `timeframe` text NOT NULL,
  `symbol` text NOT NULL,
  `status` text NOT NULL,
  `latency_ms` integer NOT NULL,
  `error_message` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`source_id`) REFERENCES `market_data_source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_market_source_call_source_created` ON `market_data_source_call` (`source_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_market_source_call_market_created` ON `market_data_source_call` (`market`,`created_at`);
