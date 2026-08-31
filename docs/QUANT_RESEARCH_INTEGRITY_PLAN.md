# Quant Research Integrity

> QUBIT 从“能编排研究的 Agent”升级为“可审计地研究因子与策略、可控地执行并从结果学习的量化系统”的项目规格。

## North-star

每一项研究、因子、策略、回测、投资决策和订单都必须回答五个问题：

1. **依据是什么？** 原始来源、数据版本、时间戳和市场数据质量。
2. **当时是否可得？** 数据可得时间、信号生成时间、下单和成交时间。
3. **能否复跑？** 不可变数据快照、代码/参数哈希、引擎和成本模型版本。
4. **如何被证伪？** OOS、反例、边界条件、反方审查和统计检验。
5. **后来是否兑现？** 推荐/交易 outcome、归因、校准和可控的经验更新。

系统闭环：

```text
数据快照 → 可证伪假设 → 因子/策略规格 → 防偏差实验
   → 反方审查 → 组合决策 → paper/shadow/live → 归因与反思
```

文字回答、模型偏好或单次回测曲线都不能替代上述产物。

## Harness 装配边界

闭环的具体证据与闸门仍分别由 `src/runtime/backtest`、`src/runtime/factor`、
`src/runtime/effect-validation` 和 `src/runtime/strategy` 持有；它们不是另一套
可替换的执行引擎。`src/runtime/harness/quant-research-integrity.ts` 是产品自有、无
I/O 的编排层：它把已有快照、反泄漏、因子风险暴露、Walk-Forward、paper 和人工
批准证据归为同一审计结果。`workflow-harness.ts` 以 workflow-scoped lease 装配
`quant-research-integrity` profile：登记的高保证研究场景得到 advisory 审阅，backtest /
simulation / live 得到 required 审阅；工作流终态统一 `dispose()`。也可用结构化
`harness.researchIntegrity={mode,reason}` 显式启用或撤销其审计投影。`paper-trading`
默认继承它。研究任务只得到 advisory 缺口报告，不能由 profile 配置获得执行权限；paper/live
的 required gate 仍在宿主服务内执行，因此卸载 profile 不会削弱实盘准入。最终独立 holdout 由 `backtest.final_holdout` 创建不可变合同后只执行
一次，单独写入 `strategy_eval_run.eval_kind='holdout'`；同一 source backtest 不能换窗口或
重复查看。live promotion 必须绑定同一 `backtest_run_id`、strategy version 与 dataset snapshot
的通过 holdout 记录。
人工 `approve-live` 也只能在 holdout 已通过后写入，不能先批准、后补测试；因此旧批准
不会因之后补跑保留集而自动变成有效实盘授权。

`math-audit` 是另一条独立、按 workflow 租约加载的 Harness：`workflow_run.loop_options_json`
中的结构化 `harness.mathAudit={mode,reason}` 可显式启用/关闭；登记的高保证量化场景
（因子、策略、规则、组合、风控、发现、实盘）和 `backtest` workflow 默认启用 required。
普通对话中的公式文本绝不会触发。租约同时约束 Prompt 工具面、CapabilityGate 与
`math.derivation.verify` handler；工作流终态会 `dispose()`，因此不能靠手写工具调用绕过。
其 handler 仅精确导入数学验证组件，不依赖全量 Harness barrel 或工具注册表，因此可单独
加载、测试和撤销。

## 当前基线与必须修复的断点

| 已落地基础 | 仍然缺失的生产级约束 |
| --- | --- |
| `market.snapshot.get` 可以生成不可变市场快照；BacktestJobService 强制写入并消费非空 `dataset_snapshot_id`；历史标的池、企业行为和 PIT 基本面账本都进入快照指纹 | 行业分类历史、因子预处理规格与官方源的持续版本治理仍待补齐；证据不完整时仍只能标为 `research_only` |
| 事件驱动回测只从绑定快照读取行情，具备下一根 open 成交、手续费、滑点/平方根冲击、成交量参与率、借券成本、真实多空和平仓语义；`asset-lifecycle-v2` 已支持合约乘数/整手、欧式现金结算期权到期、按冻结标的/IV/利率审计的 Black–Scholes Greeks、期货逐日盯市/初始与维持保证金/追保/强平、显式换月的平旧开新、币永续资金费，以及快照显式停牌/不可交易/涨跌停与显式闭市会话的方向性未成交约束。事件键为完整 UTC 时间戳，盘中年化频率仅由冻结会话窗口推导；交易日历版本、时区和逐交易所会话表均进入快照血缘 | 官方交易日历的自动接入、交易所参数曲线、美式期权提前行权、波动率曲面与按资产/券商校准的成本与容量参数仍需完善；快照未提供可交易性字段、日历版本、会话表或盘中窗口时必须标为 `research_only` 或直接拒绝盘中执行 |
| 因子值按 `dataset_snapshot_id` 隔离存储；因子评估表携带快照血缘，内置评估器输出并持久化 Newey–West HAC 的 IC/Rank IC 推断，发现任务输出 Benjamini–Hochberg FDR 证据 | 横截面回归、bootstrap、因子相关/VIF 与行业/风格/市场暴露仍未形成完整研究合同 |
| Walk-forward 支持扩展窗口、purge + pre-OOS embargo、regime 门槛及每折训练窗独立选参；胜者冻结后才首次进入测试窗。训练候选族执行 Benjamini–Hochberg FDR + White Reality Check，最终拼接 OOS 执行 block-bootstrap + Bonferroni + Deflated Sharpe。PIT、anti-leakage 与统计置信报告均为机器可读且 fail-closed | 完整的资产类别可成交性模型仍未形成硬门 |
| Math Harness 有数值、反例、量纲、敏感性和符号检查；Quant Stats 已具备 HAC 因子显著性与 FDR 候选族校正 | 尚未覆盖完整的回归诊断、bootstrap、暴露和共线性检查 |
| Order intent、风险签名、券商桥和环境级 kill switch 已存在；`trading_module_control` 提供持久化、版本化的全局暂停状态，直接 intent、策略运行时、execution worker 和 dispatcher 共享检查，执行监控会同时显示环境开关与持久化暂停 | 仍需按账户/策略细分的持久化暂停、跨服务原子租约、已被券商确认订单的撤单编排与外部风控服务高可用 |
| recommendation outcome 可生成保守的 confirmed / invalidated / inconclusive reflection，并明确非因果归因限制；显式绑定 `thesisId` 的主周期结果还会带着市场数据指纹写回其 Forecast Book | 仍需将真实成交、执行偏差与容量衰减纳入策略归因；组件升级只能使用冻结 cohort 的 offline + shadow/paper 对照，不能由单次结果自动推广 |

### 实施进展（2026-08-27）

- 已完成：回测快照强绑定、回测/因子运行时禁止隐式取行情、快照因子值版本隔离、因子评估快照血缘、多因子同快照合成、研究级结果阻断实盘晋级。
- 已完成：历史 universe 与企业行为账本已纳入不可变 market snapshot。`universe_history` 冻结 universeId、版本、来源、as-of 与逐标的 membership interval；`corporate_action_ledger` 冻结版本、来源、as-of、调整方法以及带 `knownAt` 的逐标的 action arrays。两者均进入 snapshot 指纹；绑定数据集时逐根 Bar 校验成员覆盖、逐标的校验账本存在且 adjustment method 匹配。只有同时具备这些证据、PIT 与 L1+ 验证数据源的快照才可标为 `strategy_validation`，否则严格保持 `research_only`。
- 已完成：PIT 基本面账本与计算时点。`fundamental_ledger` 冻结财报、估值或预期观测的版本、来源、as-of、财报期末（`fiscalPeriodEnd`）、市场可得时点（`availableAt`）、数值与修订链；它进入 snapshot 指纹并被投影到绑定回测数据集。PIT verifier 自动拒绝在 snapshot 边界之后才可得的基本面修订；Qlib 表达式可用规范化字段名（如 `fund_revenue_ttm`）消费这些观测，并严格在 `availableAt` 之后的第一根 Bar 才显示数值，修订仅向后生效。该保守日线规则不会假设盘中发布时间或交易所 session；更精细的 session-aware 可得时点属于 Phase 2C。
- 已完成：退市结算保护。企业行为账本中的 `delisting` 会在 effectiveDate 从冻结 `cashAmount`（若无则同日冻结 open）强制结清持仓、留下单独审计 trade/lifecycle event，并从后续选股目标中排除该代码；若回测区间内缺结算现金与同日 Bar，Provider fail-closed，不会把退市标的以最后一根价格无限期保留。
- 已完成：事件引擎的多空持仓、空信号退出、缺失 K 线持仓估值和最低佣金预算修正。
- 已完成：`anti-leakage-v1` 报告、参数选择血缘、固定参数 purged walk-forward、PIT 证据降级、可复算 block-bootstrap Sharpe 置信区间、候选试验次数与 Bonferroni 校正、全窗口敏感性扫描 research-only 标记，以及 validation/live 的完整性闸门。
- 已完成：`backtest.walk_forward` Agent 工具；支持 2–20 个候选在每折训练窗内按 Sharpe/Calmar/年化收益选优，冻结后运行测试窗，并返回逐折榜单、拼接 OOS 统计与可审计泄漏报告。固定参数模式保留原始参数选择证据，不会被自动升级为“预先冻结”。
- 已完成：`anti-leakage-v2` 将 embargo 作为独立必备证据；默认在每折训练与 OOS 间设置 5 日 purge + 5 日 pre-OOS embargo，并记录两段隔离日期。`statistical-validation-v2` 增加中心化 block-bootstrap 单侧 p 值和 Bonferroni adjusted p；训练候选族缺少足够样本或未通过 Benjamini–Hochberg FDR 时，Walk-Forward 晋级 fail-closed。
- 已完成：训练窗候选收益按共同日期对齐，并用同步 moving-block bootstrap 执行 `white-reality-check-v1`，保留候选间依赖；`statistical-validation-v3` 根据完整候选 Sharpe 分布、独立试验数、OOS 样本长度、偏度和峰度计算 Deflated Sharpe。候选分布缺失、Reality Check 或 DSR 未通过时不允许晋级。
- 已完成：可卸载的 `asset-lifecycle-v2` 合约适配层。`backtest.run` 可接收 point-in-time `instruments`；合约乘数与最小交易单位贯穿目标仓位、成交和估值，现金结算欧式期权/期货在到期日使用快照 `settlementPrice` 强制结算，币永续按每根 Bar 的 `fundingRateBps` 计提。期货要求冻结 initial/maintenance margin 与目标杠杆，收盘逐日盯市；跌破维持保证金会从可用现金补缴，现金不足按结算价强平。显式 `future_roll:{roll_date,successor_symbol}` 会在冻结日期按快照 open 平旧合约、按合约乘数换算整手后开新合约；新合约必须同时出现在冻结合约表与回测标的集，换月链不得成环；缺 successor、换月日在到期后或新旧任一换月 Bar 缺失时均 fail-closed/审计，不会从连续代码猜测。期权在同一不可变快照同时提供标的价格、IV 与无风险利率时，以 Black–Scholes 计算逐期 Delta/Gamma/Theta/Vega，只做风险审计且绝不以理论价替换成交价；`derivative_pricing_ledger` 会冻结 IV 报价/曲面及利率曲线的版本、来源、时点和方法，缺失或晚于快照会明确降级。普通资产与期货在开盘撮合前检查快照的 `tradable`/`suspended`/`priceLimitUp`/`priceLimitDown`：停牌、不可交易、涨停买入和跌停卖出均不成交，并留下原因审计事件。若快照完全不含可交易性字段，生命周期报告显式标记 `tradability_flags_missing`，结果保持 `research_only`。衍生品字段缺失、实物交割或美式提前行权均 fail-closed；实际曲面插值模型与交易所保证金参数曲线仍未建模，因此结果保持 `research_only`。
- 已完成：交易日历血缘与闭市撮合约束。`market.snapshot.get` 接收 `calendar_version` / `timezone` / `calendar_sessions_by_venue` 并将规范化后的会话表写入不可变快照指纹；绑定到回测的数据集时按 symbol 映射对应交易所会话。生命周期校验不从缺失 Bar 猜节假日或开市：日历版本、合法 IANA 时区或逐标的会话表缺失时加入 `calendar_*` 限制并保持 `research_only`。当某 Bar 日期被显式标为 `closed`，普通资产和期货均不会在 open 撮合，输出 `order_unfilled_tradability/calendar_closed` 审计事件。会话表必须是外部冻结输入；当前不自动编造官方节假日、半日市或盘中 session。
- 已完成：盘中会话窗口与执行频率。`calendar_session_windows_by_venue` 可冻结每日一个或多个 ISO `openAt/closeAt` 区间（含早收盘或分段交易标签），并进入快照指纹后按 symbol 投影到数据集；无效、倒置或缺失的窗口不会被推断为开市。`event_driven` 对盘中数据以完整 UTC 时间戳而非自然日作为执行键，信号生成和成交始终隔开至少一根 Bar，实际调仓仍遵从策略声明的 `rebalance` 频率；年化周期由冻结窗口的平均时长和 K 线频率推导，并同时进入绩效与统计验证报告。任一盘中 Bar 没有窗口、落在午间休市/收市边界外或无法得出周期时 fail-closed，绝不把盘中收益伪装为日收益。
- 已完成：交易成本证据门。`costs` 现可冻结佣金、滑点、最小佣金、冲击、容量参与率、借券和禁空标的，以及 `cost_model_version` / `cost_model_source` / `cost_model_as_of`；工具层不得再静默丢弃高级成本字段。缺少三项成本血缘、或使用内置 5bp 默认值时，反泄漏报告中的 `transaction_costs` 必须为 `unknown`，结果不得作为验证级交易成本证据。
- 已完成：因子统计与准入最小闭环。`FactorResearchContract` 以轻量、可卸载的 `definition_json.researchContract` 保存经济机制、PIT 可得性、与可执行表达式一致的公式、预处理、适用域、失效条件及独立验证计划。内置因子评估按日横截面输出 Newey–West HAC 标准误、t 值、p 值与正 IC 比例；至少 60 个日截面且 IC 或 Rank IC 显著才可通过。报告作为 `factor_evaluation.statistical_report_json` 持久化，因子发现对完整候选族做 Benjamini–Hochberg FDR 校正，并把方法、候选数、发现数及逐候选 adjusted p-value 一同返回。`strategy.compose` 的显式选因子和自动补全，以及 `factor.promote_backtest` 的快捷路径，都会拒绝缺合同、未通过 HAC、未绑定冻结快照或（回测时）快照不匹配的因子；未经校正的 IC 排名不可伪装成验证结论。
- 已完成：多因子独立性最小闸门。`factor.correlation.diagnose` 仅在同一冻结快照中逐 `(date,symbol)` 对齐因子值，输出每一对的共同样本数、Pearson signal correlation、常量/缺失状态与超阈值 pair；它不以收益相关冒充因子独立性。多因子 `factor.promote_backtest` 要求所有 pair 至少 60 个共同、非恒定观测，且绝对相关小于 0.7，否则停止在验证级回测之前。该轻量诊断尚不等同于完整多因子横截面回归、行业/风格暴露或边际组合风险模型。
- 已完成：信号基底暴露与共线性诊断。`factor.exposure.diagnose` 在同一冻结快照的共同 `(date,symbol)` 观测上，以其余候选因子作控制变量，输出每个因子的 OLS R²、VIF、样本数和秩/方差不足原因；默认 VIF ≥ 5 明确失败。多因子 `factor.promote_backtest` 将其作为与 pairwise correlation 并列的准入门；它不把内部信号回归误称为行业、风格或市场暴露：后者仍必须引入版本化外部分类/风险暴露账本。
- 已完成：外部风险暴露账本的快照血缘。`market.snapshot.get` 可接收 `risk_exposure_ledger:{version,source,asOf,model,observationsBySymbol}`；每条 observation 带 `effectiveDate`、`availableAt`、风险暴露向量及可选 revision/reference，所有修订均进入不可变快照指纹。该基础协议防止事后风险模型覆盖历史可得暴露；横截面回归与行业/风格中性结论仍只能在此账本真正提供足够 PIT 覆盖时生成。
- 已完成：因子外部风险回归与 live 闭环。`factor.risk_exposure.regress` 对同一快照的单因子值，仅匹配决策时间前已发布的外部暴露，输出每个行业/风格/市场维度的横截面 OLS beta、R² 与覆盖缺口。因子组合的 backtest evaluation 会持久化 `factorRiskExposure`；若它声明 `required=true`，Champion–Challenger 与 live promotion 都必须读取 `status=passed`，否则不得晋级。非因子/历史记录不被追溯性阻断。
- 已完成：受控发现的候选墓地。每个 `discovery_job` 除 top-K 短名单外持久化完整 `candidateAudit`，逐条记录计算错误、统计证据缺失、FDR 未通过或排名淘汰的原因；短名单也保留“尚未通过 FDR”的事实。Agent 不能再把 top-K 截断当作删除其余假设，也必须把同一搜索预算内的完整候选数计入后续 `candidate_trials`。`discovery.promote` 强制只创建 draft，并把候选族规模和 FDR 证据写入 lineage；即使调用方传入 `status:'active'` 也会拒绝。可通过 `factor.set_research_contract` 补齐合同，完成同一冻结快照评估后再由 `factor.activate` 进行 fail-closed 激活。
- 已完成：持久化交易模块暂停。`trading_module_control` 单例记录 enabled、reason、changedBy、revision 与 changedAt，服务重启后仍可恢复相同状态；环境变量关闭优先级更高。创建 order intent、创建/启动 strategy runtime、execution worker 和 dispatcher 都在派发前检查该状态。关闭模块时，路由会停止 running runtime，并只取消尚未派发的 pending/held/conditional/awaiting-review task，写入取消事件；已获券商确认的订单不会被伪装成“已取消”，仍交给对账/撤单流程。`execution.kill_switch.status` 同时输出环境级和数据库级停机原因。
- 已完成：框架化选股的可审计执行。命名 `ResearchThesis.framework` 现在必须绑定版本化 `InvestmentFrameworkCard`：来源、原则、经济机制、可观测代理及阈值/权重、适用资产/市场/regime、排除/失效条件和风险预算。`research.framework.assess` 依据冻结卡片作确定性评估；每个代理数值均需 evidence ref，缺数据或引用只能为 `research_only`，适用域不匹配或分数低于阈值即为 `rejected`。这避免把“像某个投资流派”的自由文本直接升级为可交易建议。
- 已完成：策略 Champion–Challenger 的同 cohort 比较门。backtest 与 walk-forward 会写入由冻结 snapshot、时框、标的池、universe、benchmark 和成本模型生成的 `strategy_cohort_*`；paper/shadow 只能在同一策略已具备该 backtest + walk-forward 证据时引用该 ID。`strategy.champion_challenger.compare` 仅在 backtest、walk-forward、paper 三者均共享同 cohort 时计算分数，缺失/歧义/不匹配时明确返回不可比较，绝不自动切换 live runtime。
- 已完成：策略反思的可复用证据闸门。`strategy_recipe` 只有在其**精确 composition** 已绑定同一 strategy version、backtest run、冻结 dataset snapshot 和 comparison cohort 的通过 backtest、walk-forward、一次性 final holdout 与 paper 证据后，才可被 Skill Curator 晋升为 `pending_review` 技能；仍需人工审核才会启用。未验证 recipe 只能以 hypothesis 留存：不能通过高 quality / useCount 直接晋升，Finance Recall 会将其 importance 与 outcome 权重分别封顶为 0.30 / 0.20，并在 Prompt 中明确标注 `unverified_hypothesis`。paper runtime 可显式绑定 `params.compositionId`；旧 runtime 只会在同一 strategy version 恰有一个 composition 时安全推断，歧义时保持未绑定，因而不能为任一 recipe 提供验证证据。
- 已完成：通用组件的冻结 benchmark 对比。`component_eval_run` 现在把 `comparison_cohort_id` 作为结构化证据；Agent、Prompt、Tool、Model、Skill、数据源与 Harness 的控制/挑战版本只能在显式指定的同一 cohort 内比较。候选版本必须达到样本下限、所有记录通过，并同时拥有 offline 与 shadow/paper 证据；缺 cohort 的历史行仍可审计但不会参与推广。所有晋级仍只生成 `candidate_for_manual_promotion`，live 流量一律留在 control。
- 已完成：组件运行时证据入口收敛。通用 `/governance/component-evaluations` API 只允许写入 offline 证据；paper/shadow 证据必须由对应的权威 evaluator 采集，避免任意客户端伪造第二阶段 benchmark 记录。即使 scorecard 满足阈值，也仍只能成为人工审查候选，不能自动推广或分配 live 流量。
- 已完成：paper 组件证据自动采集。`PaperEvaluationService` 在 strategy 的同 cohort backtest + Walk-Forward 已验证后，才将实际 workflow 中记录的 Agent、Prompt（system prompt SHA-256 内容指纹）、LLM model、Tool、Skill 与冻结数据源投影为 `component_eval_run.eval_kind='paper'`；样本量来自真实 paper trading days，指标来自净收益、Sharpe、回撤与换手。Harness 不接受 runtime params 伪造版本，等待 profile build identity 持久化后再接入该层。每个 component/workflow/cohort/evalKind 仅写一次，重复“评估”不会累积伪样本；无冻结 cohort 时仍只生成策略 paper 结果，不产生可用于组件升级的证据。
- 已完成：成交归因与 paper 评估 worker 进入进程生命周期。`PnlAttributionWorker` 每 15 分钟（可由 `QUBIT_PNL_ATTRIBUTOR_*` 配置或关闭）重放最近 7 天的 fill/mark 窗口，物化 strategy PnL、Skill 归因和分析师准确率，因而迟到成交或延迟行情不会漏算；`PaperEvaluationWorker` 在其后独立按 6 小时（`QUBIT_PAPER_EVALUATION_*`）更新 paper runtime 的绩效与受控组件证据。二者都可独立停用，任何单次失败只记录 warning，不影响订单执行主链。
- 已完成：归因读取按真实项目血缘隔离。`/monitor/pnl/strategies?projectId=` 现在经 `strategy_runtime → indicator_strategy_script → workflow_run` 过滤；没有 workflow 血缘的旧 runtime 只可在不带项目范围的兼容视图中观察，绝不会混入任一项目的结果或成为该项目的反思依据。执行 TCA 仍独立按 strategy project 过滤，二者均为只读审计报告。
- 已完成：只读完整性审阅按**精确 cohort**展示策略证据。每行从一个通过或失败的 base backtest 出发，只接受同 cohort 的 Walk-Forward、paper 与 live 记录，并把 final holdout 绑定到该 source backtest、strategy version 与 dataset snapshot；不同 cohort 的绿色阶段不能再被拼接成“完整”策略。缺 cohort 的历史记录会保留为 `unbound`，但绝不显示为可晋级。
- 已完成：实验平台组件证据自动采集。完成的 `eval_run` 以 eval dataset 的版本和全部 case 输入/期望/元数据摘要生成不可混用的 cohort 指纹，并将每个 case 的 Agent、LLM provider/model、Tool、实际执行 Skill 和 Harness profile 使用版本记为 `offline` 组件评测。采集是幂等的，记录引用 workflow、case、eval run 和配置指纹；它不会从 production workflow 自动学习，且 offline 证据仍不足以触发组件晋级。
- 已完成：数据源的版本化评测血缘。实验组件采集只从 workflow 关联的 `backtest_run.dataset_snapshot_id` 读取持久化 market snapshot 的 `sourceIds`；每条数据源证据以 `sourceId + snapshotId` 表示版本，快照不可读时宁可缺证据也不猜测实时 provider。不同 snapshot 的数据修订不能被聚合为同一数据源挑战版本。
- 已完成：最终独立 Holdout。`backtest.final_holdout` 要求 `train_end` 精确等于源 backtest 的结束日，并用同一不可变 snapshot、代码、参数和成本在后续保留区间执行一次；它会从该 snapshot **重新绑定** Holdout 窗口，而不会复用源回测的训练期 dataset binding，快照窗口或标的 K 线未覆盖保留区间时明确 fail-closed，provider 不得回退到运行时行情。合同固定 `purge_days` / `embargo_days` 与指纹；晋级评分和 execution admission 会重算该指纹，并核验同一 strategy version、source backtest 与 dataset snapshot。相同 source run 的相同合同不能重复读取，不同窗口也会被拒绝，防止在最终测试集上反复挑窗。结果以独立 `holdout` evaluation 写入，完整性报告按单一保留集（而非伪装成多折 Walk-Forward）审计；live promotion 与 execution admission 都要求该 holdout 针对当前 base backtest 通过。
- 已完成：策略候选墓地。`strategy_candidate_review` 以 project + strategy version + frozen/review cohort 幂等保存 `eligible`、`incomplete`、`rejected`、`retired` 结论和明确 reason codes；可附结构重复指向、regime、容量、相关性证据。每次 Champion–Challenger 比较都会沉淀最低限度的评审记录，Agent 可通过 `strategy.candidate.review` 补齐证据；同项目内完全一致的脚本标识或组合内核会被保守地自动标记为结构重复，而“输给 champion”只代表相对表现，不会被错误标记为重复。
- 已完成：三级持久化交易暂停。`trading_module_control` 的记录键可表达 `global`、`broker_account:<id>` 与 `strategy_runtime:<id>`；环境级关闭仍优先于全部数据库状态。下单意图、策略 runtime 启动、dispatcher 都按当前账户/运行时求交集并 fail-closed；暂停路由只停止匹配 runtime、只取消尚未派发的匹配任务，返回真实取消列表，不会把已被 worker 获取或已获券商确认的订单误报为已取消。
- 已完成：完整策略晋级门已下沉到所有真钱入口。除 live runtime 启动和人工 reconcile 外，`createOrderIntentWithExecution` 与 broker dispatcher 在订单创建及真正提交券商前都会重验同 cohort 的 backtest、Walk-Forward、final holdout、paper、人工批准与冻结数据集资格。若一个已排队订单在等待期间失去资格，worker 将其标为 `rejected`，而不是按网络故障重试。
- 已完成：真钱执行入口收敛。遗留 `intent_order → executeIntentLive`、旧 REIA route、旧 broker connector 与 broker MCP 都不再能直连券商；它们对真钱请求统一 fail-closed 并指向 canonical `order_intent` 管线。`POST /execution/intents` 现完整透传 `dispatchMode`、券商账户、strategy runtime、thesis、snapshot 与 framework assessment Artifact，真实订单只能通过同一套创建与派发复核。
- 已完成：回测 K 线频率的端到端绑定。`BacktestJobService`、`backtest.run`、因子 promotion 与 Quant API 都显式透传 `timeframe` 到 immutable snapshot binding；日线和已冻结会话窗口的盘中快照均可通过事件引擎执行，但请求频率与快照不一致、或盘中会话窗口缺失时仍 fail-closed。策略版本的 promotion 参数同时保存该频率，避免将 5m/1h 研究伪装为日线回测。
- 已完成：live strategy runtime 的证据配置闭环。`StrategyRuntimeParams` 持久化 `thesisId`、可选 `snapshotId` 与框架评估 Artifact；创建或启动 live runtime 时缺少 thesis 立即拒绝，运行中每一笔订单继续由 canonical `order_intent` 管线重新校验 thesis↔snapshot、一致性、数据质量、策略晋级及（若适用）框架标的资格。这样既避免“已启动、首个信号才失败”，也不会把长时间空闲 runtime 的旧证据当成永久授权。
- 已完成：执行证据贯穿所有高层订单入口。Trader 单笔/命令、Bracket 三腿、REIA bridge、计划任务、组合 rebalance 和持仓对账修复均能承载 thesis、snapshot 与框架评估 Artifact；使用 live runtime 的对账修复只读取该 runtime 已持久化的证据，而不会相信请求体覆盖。它们最终均复用 canonical `order_intent` 的实时复核，不能靠某个 UI 或服务层漏传字段取得真钱派发。
- 已完成：REIA/Trader/计划任务的 runtime-bound 执行上下文。传入 `strategyRuntimeId` 时，订单会从 runtime 的脚本解析精确 strategy version、标的、券商账户、源 workflow 与已持久化证据；请求体不能替换该 runtime 的 thesis/snapshot/framework assessment。`auto-bridge` 仅保留 paper/sim 迁移兼容，真钱请求缺少已晋级 runtime 会直接拒绝。计划任务不再丢弃 `strategyRuntimeId`、账户、市场、时框和证据字段。`live_with_confirm` 已改用 canonical `order_intent → risk_review_ticket`：满足 promotion/evidence gate 后订单保持 `awaiting_review`，只有 `/execution/review/:ticketId/approve` 放行才会进入 worker；订单持久化 thesis、snapshot 与 framework Artifact，并在实际 broker dispatch 前重验，确认等待不会把旧数据当作授权。
- 已完成：多分析师研究信号重新接入可审计链。`research.signal_fuse` 只接受同一 workflow、同一冻结 snapshot、同一 ticker 的带方向/置信度/理由信号；逐条写入 `analyst_signal`，再以确定性、历史准确率受限的权重写入 `signal_fusion_result`。低置信度只建议辩论，融合永远只是研究证据，不能创建订单或替代 thesis、回测与风控。过期异步团队遥测会在父 workflow 不存在时安全丢弃，避免将交互附着到错误的数据库生命周期或产生 FK 噪声。
- 已完成：推荐 outcome 的因果边界与幂等反思。推荐结果只回写同一 workflow 的 `research_conclusion`，或 metadata 中显式绑定同一 recommendation 的结论；不再因“同一个 symbol”把新结果归因给旧 thesis。每个 `recommendationId + horizonDays` 形成 outcome 去重键，worker 重放不会重复增加 experience 的 success/fail 计数；该经验更新只表示预测校准/关联证据，仍不构成单次结果的因果验证。
- 已完成：推荐 outcome 的成交时点防前视。无 entry range 的推荐在首个可用日线的 close 才建仓，止盈/止损、MFE/MAE 和退出判定从下一根 K 线开始；带 entry range 的同根 K 线触发仍以 stop-first 保守处理。结果不会把已知收盘前的 high/low 伪装成可执行的同根交易。
- 已完成：推荐 outcome 的行情证据冻结。成熟 outcome 持久化本次评分实际消费的目标和基准 OHLCV 片段、窗口、市场、版本及 SHA-256 指纹，并在审计日志留下目标指纹；之后数据源修订不会被误写为原始反思事实。该证据仅说明历史评分输入，尚不构成推荐或策略的因果证明。
- 已完成：显式 thesis 绑定的推荐反思投影。`recommendation.record` 传入 `thesisId` 时会将其保存为 `research_thesis` source artifact；其**主持有期** outcome（辅助 1/5/20/60 日校准不重复解释 thesis）会幂等写入对应 Forecast Book，保留收益、MAE、止盈/止损、评估时点和冻结 OHLCV 指纹。旧的已结算结果会在后续 worker tick 安全补写，不覆盖 SQLite 中的原 outcome。无显式绑定、未知 thesis 或同一 thesis 的冲突 recommendation 一律跳过，绝不以同标的/同 workflow 猜测因果关系；该反思只读，不会自动调参、推广策略或升级模型。
- 已完成：推荐校准的只读审计摘要。`research.recommendation.calibration` 按 recommendation 的方向与持有期，从已结算的 `win/loss/flat` outcome 汇总样本量、命中率、Brier、平均收益与平均超额收益；`flat` 明确计为非 win，默认少于 30 个样本只标为 `insufficient_evidence`。它是供研究 Agent 复盘的描述性证据，不会自动调整策略参数、仓位或模型置信度。
- 已完成：投资框架与执行证据的最小闭环。Research thesis 可登记 `quality_growth`、`value_margin_of_safety`、`growth_at_reasonable_price`、`trend_following`、`event_driven`、`macro_regime`、`market_neutral_factor` 或 `custom`；命名框架必须有可引用 claim 和可观测 invalidation。live evidence binding 会拒绝缺证据、不可证伪的 thesis。终态推荐 outcome 会生成保守 reflection，且明确单次结果不验证框架、不是因果归因。
- 下一硬门：官方交易日历自动接入、半日市/盘中会话的持续治理、交易所参数曲线，以及期权提前行权与可复现波动率曲面；因子端还需补齐回归诊断、暴露与独立验证集。

## Phase 1 — 研究可信度与证据血缘

### 目标

建立不可变的研究证据链：`thesis → factor → strategy_version → dataset_snapshot → backtest_run → decision → order → outcome`。

### 交付

- `DatasetSnapshotBinding`：包含 `snapshotId`、数据源、快照 `asOf`、可得时间、时间窗、标的池历史版本、公司行为/复权策略和数据质量 verdict。
- 回测提交必须绑定非空、存在、覆盖回测时间窗的 market snapshot；严禁再写空 `datasetSnapshotId`。
- BacktestRequest、因子计算和事件引擎均从同一绑定快照读取价格/成交量，禁止在回测过程中隐式重新抓取“今天的数据”。
- 所有研究产物在 artifact ledger 中携带 `sourceSnapshotRefs` 与代码/参数/成本模型哈希。
- 对动态 universe 引入历史成分版本；无法提供历史成分/退市状态时，只能标为 `research_only`，不可晋级。

### 硬门

- snapshot 不存在、时窗不覆盖、标的未覆盖、质量不足或为 synthetic：回测拒绝执行。
- 任何 `backtest_run` 的空 `datasetSnapshotId`：数据库约束/服务校验拒绝。
- 回测报告必须展示 snapshot、来源、时间窗、覆盖率和数据警告。

### 验收

给定同一 snapshot、策略代码、参数、引擎和成本版本，重复运行必须产生相同的输入指纹；不允许依赖运行时网络数据。

## Phase 2 — 回测实验系统

### 目标

将回测变为可证伪的实验，而非 Sharpe 图表生成器。

### 交付

- 明确 `signal_at`、`decision_at`、`order_at`、`fill_at`；默认 `t` 收盘信号、`t+1` 可成交时段成交。
- 支持复权、停牌、涨跌停、最小交易单位、借券、期货换月、期权行权/Greeks/IV、交易日历与时区。
- 成本模型版本化：佣金、点差、滑点、冲击成本、容量和流动性约束。
- 参数只允许在训练区搜索；OOS 冻结。实现 expanding/rolling walk-forward、purged/embargo CV、bootstrap CI 与多重假设修正。
- 输出 IS/OOS、容量、换手、尾部风险、暴露、不同 regime 的稳定性及失败原因。

### 硬门

- 回测未说明可得时间、成交模型、成本、OOS 或数据快照：不得标记为 `validated`。
- 全样本寻参、使用未来财报修订值、幸存者标的池、同一数据跨 IS/OOS 泄漏：标记 `rejected`。

### 验收

每份可晋级策略都具有一份 machine-readable 的 anti-leakage report，逐项覆盖 lookahead、survivorship、restatement、parameter leakage。

统计实现依据：Bailey 与 López de Prado 的 [Deflated Sharpe Ratio 原文](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)，以及 White 的 [A Reality Check for Data Snooping](https://doi.org/10.1111/1468-0262.00152)。DSR 的 IID/独立试验近似会写入报告 assumptions；时间依赖另由同步 moving-block bootstrap 审计，不能用 DSR 单项替代。

## Phase 3 — 因子研究与量化统计 Harness

### 目标

让因子 Agent 按研究合同工作，而非“想一个公式再试跑”。

### 交付

- `FactorResearchContract`：经济机制、数据可得性、公式、频率、缺失处理、winsorize、标准化、中性化、预期方向、失效条件。
- 将 Math Harness 扩展为 Quant Stats Harness：IC/Rank IC、ICIR、分层收益、横截面回归、t-stat、置信区间、bootstrap、因子相关性、VIF、行业/风格/市场 beta 暴露。
- 支持横截面、时间序列和不同 horizon 的独立检验；登记验证集和 OOS 集。
- 因子晋级状态：`draft → registered → evaluated → validated → retired/rejected`。

### 硬门

- 未通过数据可得性、最小样本、稳定性、暴露或多重检验门槛的因子，不得进入 strategy composition。
- Agent 只能输出可审计推导记录和验证证据，不输出或保存隐藏思维链。

### 验收

任一入选因子可打开完整研究合同、统计检查、关联快照、反例和晋级理由。

## Phase 4 — 投资思想研究库与选股评价

### 目标

把投资大师的思想转化为来源可查、可证伪、可编译的研究框架；不让模型凭印象模仿权威。

### 交付

- `InvestmentFrameworkCard`：原始来源、原则、经济机制、可观测代理、适用资产/市场/regime、持有期、排除条件、失效条件与风险预算。
- 框架被编译为选股/过滤/评分/组合约束规则，且每条规则保留来源引用。
- Bull Agent 给出正向 thesis；Bear Agent 只负责寻找替代解释、数据问题、反例、估值/拥挤/流动性风险；CIO Agent 负责证据加权而非多数投票。
- 输出三层结论：思想框架一致性、实证证据强度、当前 regime 适配度。

### 硬门

- 没有可核验来源的“某大师会买”不得成为投资依据。
- 任何框架都必须有明确不适用或会失效的情形。

### 验收

选股建议可以回放到“哪张思想卡、哪些数据证据、何种反例和什么 regime 判断”。

## Phase 5 — 受控策略发现

### 目标

让 Agent 探索新 alpha，但把研究自由度限制在可追踪、可复现、抗过拟合的搜索流程中。

### 交付

- 策略假设图谱：经济机制、特征集合、调仓/持有期、资产域、预注册实验与独立复验。
- 候选生成空间由批准的因子、事件、微观结构、基本面和宏观 regime 构成；每次搜索保存 seed、版本、预算和试验次数。
- 策略墓地记录失败、重复、拥挤、容量不足与失效 regime，避免反复挖掘同一伪 alpha。
- Champion–challenger：新候选只能在固定 OOS/shadow book 上挑战现有策略，并按组合增量价值、相关性和边际风险贡献晋级。

### 硬门

- 禁止依据同一 OOS 多次调参后继续把它称为 OOS。
- 单策略 Sharpe 不能单独作为晋级理由。

### 验收

每个候选均可追溯其搜索预算、相近策略、失败记录、OOS 成绩和相对 champion 的增量价值。

## Phase 6 — 分级交易与生产风控

### 目标

研究 Agent 只产生建议；交易由独立、可撤销、可审计的执行与风险系统完成。

### 环境分级

| 级别 | 权限 |
| --- | --- |
| `research` | 只读数据与研究产物，不得创建订单 |
| `paper` | 可模拟下单和对账 |
| `shadow_live` | 实时产生信号，与理论可成交价格对比，不向券商下单 |
| `limited_live` | 白名单账户/标的/名义金额/频率/日损失限制，必须 HITL |
| `live` | 仅在连续 shadow 与 limited-live 验证通过后开放，独立风险服务仍可否决 |

### 交付

- 持久化、签名、跨进程一致的 kill switch；服务重启不能意外解除暂停。
- 盘前数据/账户/风控检查，盘中限额与异常暂停，盘后券商成交/持仓/现金对账。
- 订单前检查：数据质量、策略版本、approved snapshot、风险预算、持仓/相关性、流动性、账户权限和人工审批。
- 订单后检查：部分成交、拒单、延迟、滑点、偏离和回调工作流。

### 硬门

- 不存在“research 成功后自动无限制实盘”的路径。
- 没有风险签名、批准 snapshot、账户权限和持久化 kill switch 的订单必须 fail-closed。

### 验收

任一订单从信号到成交、取消或拒绝都能重放；任何单点服务重启不会放大交易权限。

## Phase 7 — 结果驱动反思与持续评测

### 目标

让系统从已验证的结果学习，而不是从自己生成的文字中自我强化。

### 交付

- 对 thesis/推荐记录收益 outcome、Brier/置信度校准和事后归因。
- 对策略记录收益归因、factor/regime/行业暴露、执行偏差、容量衰减和数据/模型/执行故障分类。
- Skill、提示词、模型、数据源和 Harness 升级都进入 champion–challenger benchmark；只在统计与业务指标改善后推广。
- 反思产物区分事实、假设、失败模式和可复用 playbook；未经 outcome 证实的内容不能提升为高权重记忆。
- 策略 recipe 的“已验证”只能由宿主查询持久化的 backtest / OOS / final holdout / paper 证据得出；模型文本、召回次数、质量分和单次 outcome 都不能代替该判断。

### 硬门

- `unknown` outcome 不能被计为成功。
- 自我反思不得绕过数据、回测或人工审批门槛。
- 不同 composition、不同回测实例、不同 dataset snapshot 或不同 comparison cohort 的证据不得拼接为同一 recipe 的验证记录。

### 验收

系统能量化回答：某个 Skill/模型/策略版本是否改善了 OOS、paper 或 live 的表现，以及改善是否可归因。

## 里程碑与推进顺序

1. **M1 — Reproducible Research**：Phase 1；所有新回测必须绑定并消费 dataset snapshot。
2. **M2 — Scientific Backtesting**：Phase 2 与 3；产出 anti-leakage 与统计检验报告。
3. **M3 — Research Committee**：Phase 4 与 5；思想卡、反方审查、候选搜索与晋级机制。
4. **M4 — Controlled Capital**：Phase 6；完成 paper、shadow、limited-live 的运营门。
5. **M5 — Measured Learning**：Phase 7；结果归因与 benchmark 驱动持续改进。

只有前一里程碑的硬门与验收全部通过，才允许提高下一阶段的自主权。
