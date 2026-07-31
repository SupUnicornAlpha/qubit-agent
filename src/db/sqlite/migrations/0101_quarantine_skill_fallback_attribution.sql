-- The legacy auto-hook guessed Skill completion from body substring matches.
-- Those rows are telemetry, not verified success: retain them as unknown for
-- audit while removing their influence from skill ranking/promotion.
UPDATE `agent_skill_run`
SET
  `outcome` = 'unknown',
  `notes` = 'suspect_auto_attribution: ' || `notes`
WHERE `outcome` = 'success'
  AND `notes` LIKE 'auto-hook[fallback_substring]:%';
--> statement-breakpoint
UPDATE `agent_skill`
SET `success_count` = (
  SELECT COUNT(*)
  FROM `agent_skill_run`
  WHERE `agent_skill_run`.`skill_id` = `agent_skill`.`id`
    AND `agent_skill_run`.`outcome` = 'success'
);
