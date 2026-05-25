-- HITL v2 重构：扩 workflow_hitl_request 支持多种交互形态。
--
-- input_kind：交互类型分发器，前端按此渲染对应组件。
--   - approve_only：批准 / 拒绝（兼容现有 v1 数据，所有老行默认填它）
--   - single_choice：单选（input_schema_json.options 给选项数组）
--   - multi_choice：多选（同上 + minSelect/maxSelect）
--   - free_form：自由文本（input_schema_json.placeholder/maxLength）
--
-- input_schema_json：渲染所需 schema（options 列表、placeholder 等）
-- response_json：用户实际选择 / 输入的内容；approve_only 时保持 NULL
--
-- 设计依据：docs/HITL_REDESIGN.md
ALTER TABLE workflow_hitl_request ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'approve_only';
ALTER TABLE workflow_hitl_request ADD COLUMN input_schema_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_hitl_request ADD COLUMN response_json TEXT;
