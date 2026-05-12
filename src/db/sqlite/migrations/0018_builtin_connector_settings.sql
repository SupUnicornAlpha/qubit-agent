-- Builtin connector init config (qubit-data / qubit-news), edited from the UI.
CREATE TABLE IF NOT EXISTS builtin_connector_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO builtin_connector_settings (id, config_json) VALUES ('default', '{}');
