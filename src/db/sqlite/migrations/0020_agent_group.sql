CREATE TABLE IF NOT EXISTS agent_group (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_group_member (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES agent_group(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  definition_id TEXT NOT NULL REFERENCES agent_definition(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(group_id, definition_id)
);
--> statement-breakpoint
ALTER TABLE workflow_run ADD COLUMN agent_group_id TEXT REFERENCES agent_group(id);
