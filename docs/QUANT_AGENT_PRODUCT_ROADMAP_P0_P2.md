# QUBIT 量化 Agent 产品路线图（P0-P2）

| 项目 | 内容 |
|---|---|
| 目标 | 把 QUBIT 从“能力丰富的 Agent 研究平台”收敛为“结果可验证的投资决策系统” |
| 核心对象 | `DecisionSignal`（当前实现表名：`recommendation_snapshot`） |
| 核心原则 | 不再增加 Agent 编组或平行工作台；围绕推荐、策略、风险、效果验证形成闭环 |
| 文档状态 | Active |
| 起始日期 | 2026-07-10 |
| 最近更新 | 2026-07-14 |

状态标记：`[x]` 已完成；`[-]` 部分完成/持续增强；`[ ]` 未开始。

## 实施状态总览

| 阶段 | 状态 | 进度 | 当前结论 |
|---|---|---:|---|
| P0 决策结果闭环 | `[x]` | 100% | 工程功能和自动化验证完成；50 条真实成熟样本属于生产验收，不计入工程完成度 |
| P1 可信研究与策略晋级 | `[x]` | 100% | 工程基线完成：backtest、walk-forward、paper/live gate、PIT、golden dataset、统一血缘查询和跨阶段偏差报告 |
| P2 组合与执行治理 | `[x]` | 100% | 工程 MVP 完成：组合调仓、TCA、生命周期、对账、条件单、Bracket/OCO、实时 mark、统一 challenger 和并发审计链 |

按 P0 35%、P1 35%、P2 30% 加权，当前总体工程进度为 **100%**。该百分比只代表本路线图工程基线的实现与自动化验证，不代表真实资金生产认证完成度；真实样本积累、券商认证、灾备演练和生产 SLA 作为独立上线验收持续执行。

### 研究运行一致性修复

- [x] 专业场景不再统一套用 analyst-team；仅 `analyst_debate` 使用分析师团队，其他场景由 Orchestrator 按产出契约调专业 Agent/工具。
- [x] 场景 ID 在派发前写入 workflow，使工具权限和 readiness artifact gate 同时生效。
- [x] 空数组、`no_bars`、`barCount=0` 等结果记为 semantic failure，不再显示绿色 success。
- [x] 全部分析师为 HOLD 时禁止生成 bull/bear 辩论结论。
- [x] 专业场景向 Orchestrator 注入硬交付合同，限制专家范围并禁止无产物的模板化长报告。
- [x] `research_team_execute` 短路路径接入 artifact gate；缺少因子评估、结构化推荐等必需产物时不得标记 completed。
- [x] 已完成多任务数据库审计与第一轮修复后验证；行情 Provider 非空链路纳入上线环境验收，不伪造数据替代。
- [x] 主交易链已停止默认双写旧 `intent_order`；仅显式兼容开关可启用，旧 REIA 独立接口保留以满足“已有功能不删除”的兼容性红线。

## 0. 兼容性红线

- **已有功能默认保留**：研究工作台、研究团队、对话、量化工坊、资讯、交易 Agent、券商、监控和配置中心继续可用。
- “收敛”指统一核心数据与验证口径，不等于删除用户入口；任何入口调整必须先有等价或更好的承接页面。
- 新能力优先复用现有表、API、Agent、工具与工作流，不创建同义平行系统。
- 历史推荐、策略、回测和工作流必须可读；迁移采用增量字段与兼容默认值。
- Agent 过程、拓扑和工具调用继续保留为解释与诊断能力，但不作为效果北极星指标。

## 1. 北极星指标

产品不以 Agent 数量、报告长度或工具调用次数衡量效果，而以以下指标衡量：

1. **推荐有效性**：1/5/20/60 交易日方向命中率、超额收益、MAE/MFE、止盈止损触发率。
2. **置信度可信度**：置信度分桶后的真实命中率、Brier Score、ECE。
3. **策略可信度**：OOS / walk-forward 收益、最大回撤、换手、成本后 Sharpe、regime 稳定性。
4. **研究可追溯性**：数据来源、`asof`、数据新鲜度、证据与最终决策之间的血缘。
5. **实盘一致性**：回测、paper、live 的信号、订单和收益偏差。

## 2. 目标主链路

```text
市场/主题/个股输入
  → Orchestrator 规划
  → 专业 Agent 调用数据与研究工具
  → DecisionSignal（方向 + 入场 + 止损 + 目标 + 失效条件）
  → 后验行情验证 / 策略回测
  → Promotion Gate
  → Paper / Live（HITL + 风控）
  → 成交与收益归因
  → 反馈到 Agent / Prompt / Tool 版本
```

## 3. P0：决策结果闭环（0-6 周）

### 3.1 交付范围

| 状态 | ID | 交付物 | 验收标准 |
|---|---|---|---|
| `[x]` | P0-1 | 结构化 `DecisionSignal` | 推荐包含方向、周期、置信度、入场区间、止损、止盈、仓位、失效条件、证据、状态 |
| `[x]` | P0-2 | Outcome Worker | 自动按 1/5/20/60 日及自定义周期计算收益、超额收益、MAE/MFE、SL/TP 触发结果 |
| `[x]` | P0-3 | 推荐查询 API | 支持项目、标的、方向、状态过滤；提供分周期效果与置信度校准指标 |
| `[x]` | P0-4 | 推荐效果 UI | 用户可直接查看当前推荐、多周期回测、风险计划和校准结果 |
| `[x]` | P0-5 | Harness 效果闸门 | 20 日成熟样本少于 50 条时 warming；达到阈值后按胜率、平均超额收益和 Brier Score 自动阻断 |
| `[x]` | P0-6 | Secret 安全 | API Key 不回显明文，UI 只显示已配置/重设 |
| `[x]` | P0-7 | 旧编组残留清理 | group 不再作为运行时编排概念；历史兼容字段保留只读 |

### 3.2 Outcome 口径

- 每条推荐默认生成 1/5/20/60 交易日多窗口快照；推荐自身 `horizon_days` 若不在默认集合中也会额外验证。
- 无显式入场区间时，用 `asof` 后首个可用日线收盘价作为模拟入场价。
- 有入场区间时，首根价格区间与入场区间相交的 K 线视为触发；未触发则为 `invalid`。
- 同一根 K 线同时触发止损与止盈时，采用**保守口径：止损优先**，并记录 `ambiguous_bar=true`。
- 多头收益为 `(exit-entry)/entry`；空头收益取反。
- `neutral` 不进入多空收益榜，按中性带判断 `flat/win/loss`。
- 数据不足、停牌、symbol 不存在必须显式记录失败原因，不得伪造行情。

### 3.3 P0 退出条件

- 至少 50 条成熟推荐有可复现 outcome。
- 推荐 API 与 UI 能解释任一结果的入场、退出、价格路径和证据。
- Outcome worker 重跑幂等。
- `stock_pick` readiness 仍验证推荐落库，并新增效果数据可用性报告。
- 用户默认入口不再以 Agent 拓扑为主要信息。

## 4. P1：可信研究与策略晋级（2-4 个月）

### 4.1 数据与研究

- [x] 已建立行情 point-in-time 契约，校验 provider、抓取/data asof、复权方式、证券上市/停牌/退市状态、未来数据、重复 bar 与 OHLC 合法性；财报披露契约随基本面 Provider 接入继续扩展。
- [x] 提供工作流统一血缘 API，聚合因子、策略、回测、评估、推荐、订单、Tool 与 Model 调用，并输出 `asof` / provider / freshness 覆盖率和缺失父节点告警；新增产物按统一契约接入。
- [x] 已建立可冻结的 A 股/美股/港股 golden dataset，覆盖正常、未来数据、退市后数据和非法 OHLC，并作为 readiness 启动前门禁。
- [x] 推荐使用 `source_artifact` 与 evidence 关联证据，统一血缘 API 将已有研究与执行产物串成可查询 DAG，并显式报告历史缺失关系。

### 4.2 回测与策略

- [x] backtest、paper、live 使用统一策略评估记录和 promotion gate，并提供阶段指标偏差报告；Provider 级撮合差异保留为显式 deviation，而非静默混用。
- [x] 工程基线支持费用、滑点和 Provider 撮合扩展点；涨跌停、借券成本与 corporate actions 由市场 Provider 明示能力，不支持时必须告警而非模拟成已支持。
- [x] 支持 walk-forward、purged split、真正 OOS 与 regime 分层评估；真实市场 regime 覆盖作为数据上线验收。
- [x] 建立策略版本注册表与逻辑 hash、数据窗口、回测血缘，并以统一 component evaluation 记录 Agent/Prompt/Tool/Model 版本效果。

### 4.3 Promotion Gate

```text
draft
  → research_passed
  → backtest_passed
  → paper_passed
  → live_eligible
  → retired
```

晋级至少检查：样本量、成本后收益、最大回撤、稳定性、过拟合风险、数据质量和人工审批。

当前 TODO：

- [x] 回测完成后自动写入 `strategy_eval_run`。
- [x] 自动检查样本量、成本后 Sharpe、最大回撤、换手率和年化收益。
- [x] 回测 UI 展示逐项 Gate 与 `BACKTEST PASSED / RESEARCH ONLY`。
- [x] 增加扩展训练窗 walk-forward、purge gap 与独立 OOS 测试折。
- [x] 自动记录 OOS 复合收益、平均 Sharpe、最差回撤、换手和正收益折占比。
- [x] 增加 regime 稳定性检查；支持显式 benchmark 的 point-in-time 行情分层，行情不足时依次降级并明确标注 benchmark equity 或策略净值代理。
- [x] 增加 paper gate：至少 20 个交易日，并检查净收益、Sharpe、最大回撤和换手。
- [x] 增加人工审批记录，只有 backtest、walk-forward、paper 均通过后才能批准。
- [x] live runtime 启动时强制检查 promotion gate，未通过不得进入 running。
- [x] 策略脚本通过完整 `script-${id}` logic hash 唯一关联策略版本，不再复用项目内第一条策略。

### 4.4 P1 退出条件

- 回测与 paper 使用同一信号/订单语义。
- 任一策略可复现到具体数据、代码、Prompt、模型和配置版本。
- 主要策略具备 walk-forward 与 regime 报告。
- 任何未通过 gate 的策略不能进入 live。

## 5. P2：组合、执行与机构级治理（6-12+ 个月）

### 5.1 组合与风险

- [x] 支持组合总资金、总风险预算、gross/net、单仓与行业上限约束；目标组合可生成确定性计划 hash，经显式确认后通过正常风控与幂等链自动下发 paper 调仓单，live 不允许绕过晋级门禁。
- [x] 输出行业 gross/net、风格、因子、beta、相关性和 HHI 集中度暴露，并从真实日线生成协方差/相关性矩阵；行业/因子主数据通过候选输入与 Provider 扩展，不存在时显式归入 `UNKNOWN`。
- [x] 已支持环境 kill switch、运行时 drawdown budget、下单前集中度、历史 VaR 95/99、ES 95/99、历史最大回撤和确定性压力测试。
- [x] 推荐仓位先由确定性 sizing 模型生成，再由组合级资金/风险预算、gross/net、行业与单仓上限统一缩放。

### 5.2 OMS / EMS

- [x] 统一订单生命周期：created → risk_checked → submitted → partial → filled/cancelled/rejected，并在风险、worker 和券商轮询路径同步状态。
- [x] 支持幂等 `client_order_id`、stop、stop-limit、trailing-stop 与 long/short bracket；实时/分钟级 execution mark 优先、日线 fallback，支持乐观锁撤改单，父单成交后激活子单，OCO 同步本地/券商取消，高级订单已接入交易 UI。
- [x] 已支持内部 fill 与券商持仓对账、定时告警、修复方向建议和确定性计划哈希；交易 UI 可展示修复提案并选择已绑定券商的 Live Runtime，显式确认后会重新对账，严格校验项目/工作流/策略/券商上下文与 live promotion gate，再通过正常风控/HITL/幂等订单链执行。
- [x] 主 `order_intent → broker_order → fill` 链路支持实现差额、成交率、费用、intent→submit、submit→fill、总延迟及风险/券商/重试拒单归因；旧 REIA 保留兼容查询，但不再作为 canonical TCA 数据源。

### 5.3 持续学习治理

- [x] 策略版本采用 champion-challenger scorecard；Agent/Prompt/Tool/Model 使用统一 evaluation 表、样本门槛、加权 scorecard 和手工晋级候选。
- [x] 策略 challenger 必须先过 backtest、walk-forward 和 paper；组件 shadow 使用确定性分流，比例上限 20%，live 恒定回到 control。
- [x] 反馈只生成候选变更，所有 compare API 均返回 `autoPromoted=false`，不得自动绕过 promotion gate。
- [x] 新增审计事件使用逐条 SHA-256 previous-hash 链，并对同一 workflow/trace 的并发写入串行化和单调时间排序；历史未封存记录保持不可篡改并在校验结果中显式计数，不进行破坏原链的回填重写。

### 5.4 P2 退出条件

- 回测、paper、live 可执行对账并量化偏差。
- 组合风险超限可自动降仓或阻断订单。
- Agent 版本升级有可比较的效果证据和安全回滚。
- live 运行具备明确 SLA、灾备、权限和审计责任人。

## 6. UI 信息架构

顶级用户入口收敛为：

1. **今日**：市场简报、关注列表、有效推荐、风险提醒。
2. **研究**：个股、主题、筛选、因子与证据。
3. **策略**：策略草稿、回测、paper、晋级状态。
4. **交易**：持仓、订单、止盈止损、账户与组合风险。

Agent、MCP、Provider、运行拓扑和原始日志进入“设置 / 开发者工具”。推荐详情默认顺序固定为：

```text
行动结论 → 入场/止损/目标 → 风险收益 → 核心证据 → 反向条件 → 历史效果 → Agent 过程
```

## 7. 实施顺序

当前启动批次已完成 `P0-1 → P0-4`，并完成 P0-6/7。当前执行顺序：

1. [x] P0 决策结果、效果评估、校准与 readiness 闭环。
2. [x] P1 回测、walk-forward、paper/live gate、统一血缘和偏差报告。
3. [x] P2 高级条件订单、组合调仓、全版本 challenger、审计与实盘一致性治理工程基线。
4. [ ] 生产验收：累计 50 条成熟推荐、完成目标券商认证、灾备演练与 SLA 签署（外部依赖，不计入工程进度）。

每次合并实现后必须同步本文件的 `[x] / [-] / [ ]`，不得只更新代码不更新状态。

## 8. 上线验收（工程完成后）

以下为单人连续开发、现有测试环境可用、不包含券商生产认证等待的估算：

| 范围 | 预计时间 | 主要内容 |
|---|---:|---|
| P0 样本验收 | 随真实样本成熟 | 至少 50 条 20 日成熟推荐及校准指标 |
| P1 真实运行验收 | 1-4 周 | 多市场数据覆盖、regime 稳定性与 paper 观察期 |
| P2 券商生产认证 | 2-8+ 周 | 多券商沙箱/实盘一致性、权限、灾备与生产 SLA |

因此，P0-P2 工程基线已经完成；上线时间取决于真实样本自然成熟、目标市场数据质量和券商认证，不能用修改代码替代生产证据。
