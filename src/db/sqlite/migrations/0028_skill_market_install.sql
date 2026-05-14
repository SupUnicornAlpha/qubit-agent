CREATE TABLE IF NOT EXISTS `skill_market_install` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `registry` text NOT NULL DEFAULT 'open-skill-market',
  `external_skill_id` text NOT NULL,
  `skill_name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `meta_json` text NOT NULL DEFAULT '{}',
  `install_status` text NOT NULL DEFAULT 'installed',
  `installed_by` text NOT NULL DEFAULT 'user',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS `idx_skill_market_install_project_ext` ON `skill_market_install` (`project_id`, `external_skill_id`);
CREATE INDEX IF NOT EXISTS `idx_skill_market_install_project` ON `skill_market_install` (`project_id`);
