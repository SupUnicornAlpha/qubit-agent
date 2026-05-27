-- P2a: 给 def-risk 加 fetch_klines 工具授权 + 同步 system_prompt 新增段落。
--
-- 背景：复盘 workflow d0a41743 时发现 risk 角色 thought 反复说
--   "本角色的授权工具集中没有任何行情/查询工具（无 fetch_klines、无 search_asset）"
-- 然后 stopped，没有跑任何 VaR / Stress Test / 流动性评估。
--
-- 根因：risk 的 tools_json 里没 fetch_klines，无法在 portfolio pnl 缺失时
-- 自助拉单标的日线估算波动率 / VaR。
--
-- 修复方案：
--   1. 在 tools_json 末尾追加 "fetch_klines"（仅当尚未存在时）。
--   2. system_prompt 追加一段"数据不足时自助 fetch_klines"指引。
--
-- 注意：必须用 statement-breakpoint 分隔每条 UPDATE，否则 bun:sqlite 只跑第一条。
-- 详见 0055_redo_0054_with_breakpoints.sql 注释。

-- ─── Step 1: tools_json 末尾追加 fetch_klines（如已存在则跳过）
-- JSON 数组操作：去最后的 ]，加 ,"fetch_klines"]，前提是当前数组里没有这条工具。
UPDATE agent_definition
SET tools_json = json_insert(tools_json, '$[#]', 'fetch_klines')
WHERE id = 'def-risk'
  AND tools_json NOT LIKE '%"fetch_klines"%';
--> statement-breakpoint

-- ─── Step 2: 升级版本号（4.0.0 → 4.1.0），便于审计与回滚定位
UPDATE agent_definition
SET version = '4.1.0',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'def-risk'
  AND version = '4.0.0';
--> statement-breakpoint

-- ─── Step 3: system_prompt 追加"数据不足时自助 fetch_klines"段落（仅当尚未追加）
-- 用一个独特字符串做幂等保护：如果 prompt 里已含 "当 portfolio / pnl 数据不足时" 就不再追加。
UPDATE agent_definition
SET system_prompt = system_prompt || '

## 当 portfolio / pnl 数据不足时（自助拉数据，不许"无数据 → 跳过"）

如果上游 backtest 没提供 pnl 序列、或 strategy-pipeline 直接派给你做单标的风控：

- 先调 `fetch_klines` 拉日线（默认 timeframe=1d, limit=252 ≈ 1Y）；
- 用 `code.run_python` 算 daily_return = pct_change(close)，再当 pnl 序列估算 VaR / 历史波动率分位；
- 不要再用 "无 portfolio pnl 数据 → 无法评估" 作为不出意见的理由 —— 你拥有 fetch_klines 授权。'
WHERE id = 'def-risk'
  AND system_prompt NOT LIKE '%当 portfolio / pnl 数据不足时%';
