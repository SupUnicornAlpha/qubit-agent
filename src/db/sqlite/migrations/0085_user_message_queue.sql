-- 0085_user_message_queue.sql — 运行中向 Orchestrator/agent「随时插话」的消息队列
--
-- 背景：后端 ReAct 循环（run-react-loop.ts）只在 HITL 节点硬暂停；要做到 coding-agent
--   风格的「循环跑动中随时追加指令」，需要一张轻量队列表承接用户消息：
--     - 前端 POST /api/v1/workflows/:id/inject-message 入队（status=queued）
--     - ReAct 循环每轮 reason 前 drain 本工作流的 queued 消息 → 注入 LLM 上下文（status=injected）
--   软注入，不阻塞工作流；与 workflow_hitl_request（硬暂停）互补、互不冲突。
--
-- target_role：NULL = 任意 agent 可消费；指定 role（如 orchestrator）= 仅该角色 drain。

CREATE TABLE `user_message_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`target_role` text,
	`content` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`injected_at` text,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_user_msg_queue_wf_status` ON `user_message_queue` (`workflow_run_id`,`status`);
