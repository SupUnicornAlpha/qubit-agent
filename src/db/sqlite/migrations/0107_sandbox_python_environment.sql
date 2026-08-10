-- Per-policy configuration for the container-backed Python sandbox.
-- Empty JSON preserves the historical restricted in-process runner.
ALTER TABLE `sandbox_policy`
  ADD COLUMN `python_sandbox_json` TEXT NOT NULL DEFAULT '{}';
