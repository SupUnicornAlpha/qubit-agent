-- V2 Debate Protocol (SDP) migration
CREATE TABLE IF NOT EXISTS debate_session (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  topic TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT 'low_confidence',
  max_rounds INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'skipped')),
  consensus_score REAL,
  verdict TEXT CHECK(verdict IN ('agree_bull', 'agree_bear', 'no_consensus')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debate_turn (
  id TEXT PRIMARY KEY,
  debate_session_id TEXT NOT NULL REFERENCES debate_session(id),
  round_number INTEGER NOT NULL,
  speaker_role TEXT NOT NULL,
  stance TEXT NOT NULL CHECK(stance IN ('bull', 'bear', 'neutral')),
  statement TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debate_verdict (
  id TEXT PRIMARY KEY,
  debate_session_id TEXT NOT NULL REFERENCES debate_session(id),
  orchestrator_role TEXT NOT NULL DEFAULT 'orchestrator',
  reasoning TEXT NOT NULL,
  consensus_score REAL NOT NULL,
  final_stance TEXT NOT NULL CHECK(final_stance IN ('bull', 'bear', 'hold', 'abort')),
  veto_by_risk INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debate_session_workflow ON debate_session(workflow_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debate_turn_session_round ON debate_turn(debate_session_id, round_number);
