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

## 当前基线与必须修复的断点

| 已落地基础 | 仍然缺失的生产级约束 |
| --- | --- |
| `market.snapshot.get` 可以生成不可变市场快照；BacktestJobService 强制写入并消费非空 `dataset_snapshot_id` | 历史标的池成分、退市样本和企业行为版本仍未进入快照协议，因此当前回测只能标为 `research_only` |
| 事件驱动回测只从绑定快照读取行情，具备下一根 open 成交、手续费、滑点/平方根冲击、成交量参与率、借券成本、真实多空和平仓语义；`asset-lifecycle-v2` 已支持合约乘数/整手、欧式现金结算期权到期、按冻结标的/IV/利率审计的 Black–Scholes Greeks、期货逐日盯市/初始与维持保证金/追保/强平、显式换月的平旧开新、币永续资金费，以及快照显式停牌/不可交易/涨跌停与显式闭市会话的方向性未成交约束；交易日历版本、时区和逐交易所会话表均进入快照血缘 | 官方交易日历的自动接入、半日市/盘中 session、交易所参数曲线、美式期权提前行权、波动率曲面与按资产/券商校准的成本与容量参数仍需完善；快照未提供可交易性字段、日历版本或会话表时必须标为 `research_only` |
| 因子值按 `dataset_snapshot_id` 隔离存储；因子评估表携带快照血缘，IC/IR 权重只能读取同快照评估 | 财务数据修订、行业分类历史与因子预处理规格仍未版本化 |
| Walk-forward 支持扩展窗口、purge + pre-OOS embargo、regime 门槛及每折训练窗独立选参；胜者冻结后才首次进入测试窗。训练候选族执行 Benjamini–Hochberg FDR + White Reality Check，最终拼接 OOS 执行 block-bootstrap + Bonferroni + Deflated Sharpe。PIT、anti-leakage 与统计置信报告均为机器可读且 fail-closed | 完整的资产类别可成交性模型仍未形成硬门 |
| Math Harness 有数值、反例、量纲、敏感性和符号检查 | 尚未覆盖因子统计、回归诊断、bootstrap、暴露与多重假设校正 |
| Order intent、风险签名、券商桥和 kill switch 已存在；直接 intent 与 runtime 两条 live 路径均要求验证级快照、回测、walk-forward、paper 和人工批准 | 交易开关尚是进程内状态；实盘仍需持久化、多进程一致、可审计的风险与暂停机制 |
| recommendation outcome、reflection 和 Skill outcome 已存在 | 还未形成对策略/模型/数据源升级的 champion–challenger 与因果归因闭环 |

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
- 已完成：可卸载的 `asset-lifecycle-v2` 合约适配层。`backtest.run` 可接收 point-in-time `instruments`；合约乘数与最小交易单位贯穿目标仓位、成交和估值，现金结算欧式期权/期货在到期日使用快照 `settlementPrice` 强制结算，币永续按每根 Bar 的 `fundingRateBps` 计提。期货要求冻结 initial/maintenance margin 与目标杠杆，收盘逐日盯市；跌破维持保证金会从可用现金补缴，现金不足按结算价强平。显式 `future_roll:{roll_date,successor_symbol}` 会在冻结日期按快照 open 平旧合约、按合约乘数换算整手后开新合约；新合约必须同时出现在冻结合约表与回测标的集，换月链不得成环；缺 successor、换月日在到期后或新旧任一换月 Bar 缺失时均 fail-closed/审计，不会从连续代码猜测。期权在同一不可变快照同时提供标的价格、IV 与无风险利率时，以 Black–Scholes 计算逐期 Delta/Gamma/Theta/Vega，只做风险审计且绝不以理论价替换成交价；缺数据会明确降级。普通资产与期货在开盘撮合前检查快照的 `tradable`/`suspended`/`priceLimitUp`/`priceLimitDown`：停牌、不可交易、涨停买入和跌停卖出均不成交，并留下原因审计事件。若快照完全不含可交易性字段，生命周期报告显式标记 `tradability_flags_missing`，结果保持 `research_only`。衍生品字段缺失、实物交割或美式提前行权均 fail-closed；交易所参数曲线与期权波动率曲面未建模，因此结果保持 `research_only`。
- 已完成：交易日历血缘与闭市撮合约束。`market.snapshot.get` 接收 `calendar_version` / `timezone` / `calendar_sessions_by_venue` 并将规范化后的会话表写入不可变快照指纹；绑定到回测的数据集时按 symbol 映射对应交易所会话。生命周期校验不从缺失 Bar 猜节假日或开市：日历版本、合法 IANA 时区或逐标的会话表缺失时加入 `calendar_*` 限制并保持 `research_only`。当某 Bar 日期被显式标为 `closed`，普通资产和期货均不会在 open 撮合，输出 `order_unfilled_tradability/calendar_closed` 审计事件。会话表必须是外部冻结输入；当前不自动编造官方节假日、半日市或盘中 session。
- 已完成：盘中快照防伪日线保护。当前 event-driven 引擎的执行与年化语义是日线级；它会直接拒绝非 `1d` 快照，避免把同一交易日的多根盘中 K 线覆盖、合并并错误地按日频年化。半日市和盘中 session 将与真实盘中执行键、频率化指标和冻结交易所会话表一起引入，不能以当前日线模型模拟。
- 已完成：交易成本证据门。`costs` 现可冻结佣金、滑点、最小佣金、冲击、容量参与率、借券和禁空标的，以及 `cost_model_version` / `cost_model_source` / `cost_model_as_of`；工具层不得再静默丢弃高级成本字段。缺少三项成本血缘、或使用内置 5bp 默认值时，反泄漏报告中的 `transaction_costs` 必须为 `unknown`，结果不得作为验证级交易成本证据。
- 进行中：Phase 1 的历史 universe、退市样本、企业行为与 PIT 基本面证据；未完成前不会把数据标记成 `strategy_validation`。
- 下一硬门：Phase 2 的官方交易日历自动接入、半日市/盘中会话、交易所参数曲线，以及期权提前行权与波动率曲面。

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

### 硬门

- `unknown` outcome 不能被计为成功。
- 自我反思不得绕过数据、回测或人工审批门槛。

### 验收

系统能量化回答：某个 Skill/模型/策略版本是否改善了 OOS、paper 或 live 的表现，以及改善是否可归因。

## 里程碑与推进顺序

1. **M1 — Reproducible Research**：Phase 1；所有新回测必须绑定并消费 dataset snapshot。
2. **M2 — Scientific Backtesting**：Phase 2 与 3；产出 anti-leakage 与统计检验报告。
3. **M3 — Research Committee**：Phase 4 与 5；思想卡、反方审查、候选搜索与晋级机制。
4. **M4 — Controlled Capital**：Phase 6；完成 paper、shadow、limited-live 的运营门。
5. **M5 — Measured Learning**：Phase 7；结果归因与 benchmark 驱动持续改进。

只有前一里程碑的硬门与验收全部通过，才允许提高下一阶段的自主权。
