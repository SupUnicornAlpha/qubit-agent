ALTER TABLE broker_account ADD COLUMN provider_config_json TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE broker_account ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
