-- Persisted indicator / strategy scripts linked to chat sessions and optional workflow runs (research team).

CREATE TABLE IF NOT EXISTS indicator_strategy_script (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
  workflow_run_id TEXT REFERENCES workflow_run(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ide_code TEXT NOT NULL DEFAULT '',
  signal_code TEXT NOT NULL DEFAULT '',
  ai_prompt_snapshot TEXT,
  chart_snapshot_json TEXT NOT NULL DEFAULT '{}',
  purpose TEXT NOT NULL DEFAULT 'both',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_indicator_strategy_script_session
  ON indicator_strategy_script(session_id);

CREATE INDEX IF NOT EXISTS idx_indicator_strategy_script_workflow
  ON indicator_strategy_script(workflow_run_id);
