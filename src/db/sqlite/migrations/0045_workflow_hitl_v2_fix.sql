ALTER TABLE workflow_hitl_request ADD COLUMN input_schema_json TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE workflow_hitl_request ADD COLUMN response_json TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_hitl_request_workflow
  ON workflow_hitl_request(workflow_run_id, status, created_at);
