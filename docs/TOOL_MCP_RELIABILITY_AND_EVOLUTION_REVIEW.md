# 工具/MCP 可用性诊断 & 多 Agent 角色覆盖 & 进化能力评估

| 文档状态 | 草稿 |
|----------|------|
| 版本 | v0.2 |
| 更新日期 | 2026-06-12 |
| 数据来源 | 真库 `~/Library/Application Support/app.qubit.agent/db/core.sqlite`；样本 `tool_call_log` 784 条 + `mcp_call_log` 81 条（窗口 2026-06-05 → 06-10） |
| 关联文档 | [`AGENT_STABILITY_REVIEW.md`](./AGENT_STABILITY_REVIEW.md)、[`QUANT_READINESS_ASSESSMENT.md`](./QUANT_READINESS_ASSESSMENT.md)、[`SELF_EVOLVING_AGENT_DESIGN.md`](./SELF_EVOLVING_AGENT_DESIGN.md)、[`MONITORING_V2_DESIGN.md`](./MONITORING_V2_DESIGN.md) |

> 本文回答四个问题：
> 1. 跑了那么多任务，工具和 MCP 的报错原因是什么？怎么让它们更可用？
> 2. 当前多 Agent 角色设计能否模拟「量化研究 / 策略因子上线 / 实盘交易」全链路？欠缺什么？
> 3. 系统能否进化？现状到哪一步，怎么启动？
> 4. （v0.2 追加）MCP transport 支持的类型够不够（streamable-http 支持吗）？CLI 方式的工具调用做得如何？

---

## 〇、一句话结论

- **报错**：MCP `financex` stdio 子进程崩溃（失败率 ~55%）是头号问题；其次是 LLM 漏传业务参数；历史 schema 漂移已被 migration 0080 修复成历史。
- **角色**：研究链路（95%）、因子上线（90%）已接近生产级；**实盘运营层（60%）是最大缺口**——能下单，但缺执行算法 / 持仓守护 / live-gate。
- **进化**：基建大半已建，P&L 归因飞轮**已全接线**；但所有进化开关**默认 OFF**、且**无统一调度器**——**具备进化能力，但尚未启动进化**。
- **接入面（v0.2）**：MCP transport 只有 stdio/http/ws，**没有把 streamable-http 当独立 transport**（registry 同步时塌缩成 http），SSE 长连接缺独立实现；**CLI 工具调用部分支持但脱管**——sandbox policy 完全不生效、toolKind/status/latency 全是占位假值、调不了 ACP connector / skill。

---

## 一、工具/MCP 报错根因

`tool_call_log` 状态分布：success **672** / error **94** / sandbox_blocked **16** / timeout **2**。
`mcp_call_log` 状态分布：success **36** / failed **45**。

| # | 根因类别 | 量级 | 性质 | 状态 |
|---|----------|------|------|------|
| **A** | **MCP financex stdio 子进程崩溃** | 45 mcp_failed + ~28 tool error | 上游/进程稳定性 | ❌ 未修，**最高优先** |
| **B** | **LLM 漏传业务参数** | fetch_klines `symbol` ×16 / compare_peer「≥2 symbols」×8 / sign_intent `intentOrderId` ×3 / fetch_price_data `symbol` ×3 / factor_score `factor_ids` ×4 | prompt/schema 引导 | ❌ 未修 |
| **C** | **历史 schema 漂移** | `no column agent_instance_id` ×11 / `composition.name` ×2 / `discovery_job.created_by` ×2 | 迁移滞后 | ✅ 已修（migration 0080，末次报错 06-09） |
| **D** | **sandbox 拦截** | `strategy.create_version` ×9 / `call_team_*` ×6 | 策略白名单缺项 | ⚠️ 部分（#3 已收口判定，补 policy 数据即可） |
| **E** | **iteration_exceeded** | 12 | 循环预算耗尽 | ❌ 未修 |
| **F** | **circuit 熔断 / timeout** | 2 | 级联保护 | — |

### 关键洞察

- **A 是头号杀手**。`mcp_call_log` 里 financex 是唯一上榜服务（failed 45 / success 36，失败率 55%）。`error_code` 全部是 `mcp-financex/mcp_call_failed`。stdio 子进程在 `tools/call` 阶段提前退出，原文显示崩在 `CacheService.getOrSet` 附近——典型的上游 API 限频/超时触发未捕获异常，把整个子进程拖死，导致同一会话后续调用连带失败。`mcp_call_log.circuit_state` 历史快照全为 null，说明熔断器当时没真正记录/生效。
- **B 会自愈但很吵**。报错集中在早期（06-05~06-09），06-10 已明显下降，说明 prompt 在迭代中变好；但 schema 的 `required` 没硬约束，LLM 偶发漏字段。
- **C 已是历史**。migration 0080 给 `factor_definition` 补了 `created_by/agent_instance_id`，末次「no column」报错停在 06-09。
- **D 漂移风险已消除**。本周 commit `930614e`（#3）把授权判定收口到 `sandbox-executor.ts` 的 `isToolAuthorized/isConnectorAuthorized/isMcpAuthorized` 三个纯函数，filter 与 act 共用一份规则；剩下的只是 policy 白名单数据没把 `strategy.create_version`、`call_team_*` 列进对应角色。
- **观测断层**：现有 94 条 error 的 `error_class` 全为 null（都早于 migration 0084）。新调用已分类，可观测性从下一批数据起恢复。

---

## 二、可用性解决方案（按 ROI 排序）

### S1. MCP stdio 健壮化（最高优先，直接砍掉 ~55% MCP 失败）
- **现象**：单次 `tools/call` 抛出未捕获异常 → 整个 stdio 子进程退出 → 会话级连锁失败。
- **方案**：
  1. financex 子进程对每次 `tools/call` 包 per-call try/catch，**单调用失败不杀进程**，把错误作为正常 MCP error 响应返回。
  2. 熔断器真正写入 `mcp_call_log.circuit_state`（closed/open/half_open），让 open 状态能短路后续调用、避免雪崩。
  3. 对限频类错误（区别于 permanent 业务错误）做指数退避重试。
- **落点**：MCP server 侧（financex stdio 入口）+ `src/runtime/mcp/` 熔断/调用记录路径。
- **验收**：financex `mcp_call_log` 失败率从 55% 降到个位数；同会话不再出现「一崩全崩」；`circuit_state` 有非 null 取值。

### S2. 参数硬约束（消除 B 类漏参）
- schema 给 `fetch_klines / sign_intent / fetch_price_data / compare_peer / factor_score` 标 `required`，校验前置。
- reason 阶段 prompt 显式标注必填字段（注意：这些是**业务参数不能代填**，只能强引导；与 #1 的 context 参数 harness 注入不同——后者是上下文参数可由 harness 覆盖）。
- **落点**：各工具 schema 定义 + reason prompt 组装。
- **验收**：`error_message LIKE '%is required%'` 类报错趋零。

### S3. sandbox 白名单补齐（消除 D 类拦截）
- 把 `strategy.create_version`、`call_team_*` 加入对应角色的 `allowedTools`（改 policy 数据，非代码）。
- #3 收口后，filter 与 act 判定共用纯函数，补白名单**不再有「prompt 说可用、act 又拒」的漂移风险**。
- **落点**：`sandbox_policy` 表数据 / 角色 definition。
- **验收**：`sandbox_violation_log` 中 `tool_not_allowed` 不再出现这两类合法工具。

### S4. errorClass 观测恢复（持续可观测）
- 新调用已由 `classifyToolError` 分类（migration 0084 起）；历史 94 条 null **不回填**（成本高、价值低）。
- 下周起按 `error_class`（transient/permanent/blocked/unknown）看 transient 占比，作为 S1/S2 成效的度量。

---

## 三、多 Agent 角色覆盖

### 现状：11 个 active builtin 角色 + MSA 编排 + 12 个 agent group

| 层 | 角色 |
|----|------|
| 数据/情报 | market_data, news_event |
| 分析师团（MSA） | analyst_fundamental / _technical / _sentiment / _macro → 信号融合 → debate（confidence<0.6 或 ≥3 分歧时）→ risk veto |
| 研究/工程 | research, backtest, backtest_engineer（walk-forward） |
| 风控 | risk |

> 另有 11 个退役角色已合并（execution-trader→research.order.create_intent、risk-manager→risk、portfolio-manager→research+risk 等）。

### 全链路覆盖度

| 链路 | 覆盖度 | 强项 | 欠缺 |
|------|--------|------|------|
| **(A) 量化研究环境** | **95% 强** | MSA 四分析师 + 辩论 + 信号融合；因子发现/评估；回测引擎（含 walk-forward） | `extract_event` / `score_sentiment` / `analyze_social_media` 是 **stub**（返回假数据），让情绪/事件信号失真 |
| **(B) 策略/因子上线** | **90% 强** | factor.register → autoEvaluate → compose → create_version 全链路；composer 工坊；脚本工坊 | 缺自动晋级 gate（回测达标 → 自动上线无硬卡点） |
| **(C) 实盘交易** | **60% 部分** | order.create_intent → pre-trade-risk → execution-dispatcher（paper 即时成交 / live broker）→ Alpaca/Futu/IB/CCXT connector | ① 无执行算法（TWAP/VWAP/冰山）② 无组合编排 agent（多策略仓位分配）③ **无实盘持仓监控 agent** ④ **无硬 live-gate**（paper→live 缺人工/规则闸门）⑤ live 无自动 P&L 跟踪 |

**结论**：研究和因子上线已接近生产可用；**实盘是最大短板**——能下单但缺「实盘运营层」（执行质量、持仓守护、风险闸门）。另有 4 个 stub 工具（含 `cleanup_ttl`）是研究链路里的「空心点」。

---

## 四、实盘运营层解决方案

| # | 缺口 | 方案 |
|---|------|------|
| L1 | 无执行算法 | 在 execution-dispatcher 之上加 TWAP/VWAP/冰山切单层，按 child-order 分批下发 |
| L2 | 无组合编排 | 新增 portfolio-orchestrator agent：多策略仓位分配 + 资金约束 + 再平衡 |
| L3 | 无持仓监控 | 新增 live-position-monitor agent（长驻）：实时持仓/浮盈、止损止盈触发、异常告警 |
| L4 | 无硬 live-gate | paper→live 加规则闸门（回测达标 + 人工确认 + 资金上限），HMAC `risk_signature` 已有基建可复用 |
| L5 | live 无自动 P&L | live 成交回报自动回灌 P&L 表，喂给归因飞轮（见第六节 E1） |
| L6 | 4 个 stub 工具 | extract_event/score_sentiment/analyze_social_media 接真实数据源或下线；cleanup_ttl 实装 TTL 清理 |

> 优先级建议：L4（安全闸门）> L3（持仓守护）> L1（执行质量）> L2 > L5 > L6。L4/L3 是「敢不敢上小资金实盘」的前置门槛。

---

## 五、进化能力成熟度

| 机制 | 成熟度 | 说明 |
|------|--------|------|
| **P&L 归因飞轮** | ✅ **全接线** | PnL → SkillAttributor → pnl-aware-skill-block → reason，闭环已通 |
| Skill 自进化（M11） | ⚠️ 部分 | auto-skill-hook / attributor / promoter / evolver **都是真代码**，但新 skill 仅在手动/反思请求时生成，不自发 |
| AutoInstaller（P7/P8/P9） | ⚠️ 部分 | gap 检测 + propose 可用；安全扫描（safety-scan）+ dry-run-sandbox 已就绪；但 P9 自动安装从不自主触发（`AUTO_INSTALL_MODE=propose`） |
| Memory v2（P0/P1） | ⚠️ 部分 | schema（P0）就绪，P1 管道未写 |
| 因子/策略基因池 | ❌ stub | 只有表，零 GA 代码 |
| MCP 采纳反馈 | ❌ stub | 有采纳率统计，无自动 prune |

### 核心制约

1. **所有进化开关默认 OFF**：`SELF_EVOLVE_ENABLED=false`、`AUTO_INSTALL_MODE=propose`、`PNL_AWARE_REASON_ENABLED=false`。
2. **无统一调度器**：每个 worker 是独立 CLI 脚本，靠手动跑——没有定时/事件触发把它们周期性拉起。

---

## 六、进化启动路径（4 步）

| 步 | 动作 | 风险 | 说明 |
|----|------|------|------|
| **E1** | 打开 P&L 飞轮（`PNL_AWARE_REASON_ENABLED=true`） | 低 | 唯一已全接线的闭环，立刻让 reason 受真实盈亏反馈；无新代码 |
| **E2** | 补统一调度器 | 中 | 把散落的 worker CLI 收编进定时/事件触发，让 skill-evolver / attributor 周期性自动跑 |
| **E3** | AutoInstaller propose → gated auto | 中 | 达阈值 + 安全扫描通过才自动装（safety-scan / dry-run-sandbox 基建已有） |
| **E4** | 基因池 + MCP-prune | 高 | 属后置项：等 E2 调度器和 E1 飞轮数据沉淀后再投入 GA 与自动裁剪 |

> 推进顺序即风险递增顺序。E1 可本周直接验证；E2 是把「能进化」变成「在进化」的关键。

---

## 七、下周可直接拾取的 Backlog

### P0（先做，解锁可用性与安全）
- [ ] **S1** MCP financex stdio 健壮化（per-call try/catch + circuit_state 真写 + 退避重试）— 砍 55% MCP 失败
- [ ] **S3** sandbox 白名单补齐 `strategy.create_version` / `call_team_*`（改 policy 数据）
- [ ] **L4** 实盘 live-gate（敢上小资金的前置门槛）

### P1（可用性 & 观测）
- [ ] **S2** 关键工具 schema `required` + reason prompt 必填标注
- [ ] **S4** 按 `error_class` 建监控看板（transient 占比作为 S1/S2 成效度量）
- [ ] **L3** live-position-monitor agent（长驻持仓守护）
- [ ] **E1** 打开 P&L 飞轮验证（仅开关，无新代码）
- [ ] **M1** MCP transport 补 streamable-http（独立 SSE 长连接，见第八节）
- [ ] **C1** CLI 路径接入 sandbox policy 授权（见第九节，安全相关，可提到 P0）

### P2（进化 & 实盘运营纵深）
- [ ] **E2** 统一调度器收编 evolver/attributor/auto-installer worker
- [ ] **L1** 执行算法（TWAP/VWAP）
- [ ] **L2** portfolio-orchestrator agent
- [ ] **L6** 4 个 stub 工具接真实数据源或下线
- [ ] **E3** AutoInstaller gated auto
- [ ] **C2** CLI 工具事件携带真实 toolKind/status/latency（见第九节）

### 关键改动点文件（预估）
- MCP 稳定性：MCP server 入口 + `src/runtime/mcp/`（熔断/调用记录）
- MCP transport：`src/runtime/mcp/dispatcher.ts`（transport switch）+ `schema.ts` transport 枚举 + `registry-sync.ts`
- 授权/sandbox：`src/runtime/sandbox-executor.ts`（#3 已收口）+ `sandbox_policy` 数据
- CLI 路径治理：`src/runtime/loop/cli-loop-driver.ts` + `external-loop-state.ts` + `loop-protocol.ts` + `mcp-bridge-server.ts`
- 工具 schema/prompt：各工具 schema + reason 节点 prompt 组装
- 实盘运营：execution-dispatcher / 新增 monitor·orchestrator agent / pre-trade-risk gate
- 进化：`self-evolve-config.ts`（开关）+ 新增统一调度器 + auto-installer/skill-evolver worker

---

## 八、MCP Transport 支持面（streamable-http 缺位）

### 现状

| transport | 支持 | 落点 |
|-----------|------|------|
| **stdio** | ✅ | `dispatcher.ts:287` `callMcpStdioTool` |
| **http**（POST，含 SSE 响应） | ✅ | `dispatcher.ts` `callMcpHttpTool` |
| **ws**（WebSocket） | ✅ | `dispatcher.ts` `callMcpWsTool` |
| **streamable-http**（MCP 2025 标准独立 transport） | ❌ | registry 同步时塌缩成 `http`（`registry-sync.ts:196-203`） |
| **sse**（独立长连接 transport） | ❌ | 同上，塌缩成 `http` |

- transport 枚举只有三种：`schema.ts:379` / `:456` → `text("transport", { enum: ["stdio", "http", "ws"] })`。
- 派发 switch 在 `dispatcher.ts:287-340`，遇到未知 transport 直接 `throw "unsupported mcp transport"`。
- MCP **协议版本**号支持到最新（`mcp-protocol.ts:13`：2025-06-18 / 2025-03-26 / 2024-11-05），且为**自研客户端**（package.json 不依赖 `@modelcontextprotocol/sdk`）——所以缺的是「传输层实现」，不是协议版本。

### 问题

- `registry-sync.ts:196-203` 把 `streamable-http` 和 `sse` 都映射成 `transport: "http"`。如果对端是真正的 **streamable-http**（单 endpoint、POST 发请求 + SSE 流式回多事件 + session 续连），用普通「POST 等一个完整 JSON 响应」的 `callMcpHttpTool` 去打，会拿不到流式中间事件、长任务超时、session 无法保持——**表现为连接得上但调用经常失败/截断**。
- 这会和第一节 A 类「MCP 调用失败」部分重叠：未来接入更多远程 MCP（越来越多 server 默认走 streamable-http）时，失败面会扩大。

### 简单方案（M1）

1. transport 枚举加 `streamable-http`（schema + migration），`registry-sync.ts` 不再塌缩。
2. `dispatcher.ts` switch 增一个分支 `callMcpStreamableHttpTool`：单 endpoint POST 初始化 + `Accept: text/event-stream` 读 SSE 流、聚合多事件、维持 `Mcp-Session-Id`。
3. 过渡期可先复用自研 http 客户端加 SSE 解析；长期建议直接引 `@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`，省得自己维护协议细节。
4. **验收**：能连真正的 streamable-http server（如官方 everything server 的 http 模式），长任务不截断、session 保持。

---

## 九、CLI 工具调用（部分支持但脱管）

### 现状：claude_cli / codex_cli 两种 CLI loop（`loop.ts:2`）

CLI loop 通过 `qubit.loop.v1` NDJSON 协议（`loop-protocol.ts`）回吐 `tool` 事件，被 `cli-loop-driver.ts:296-314` 接住，最小化写入 `tool_call_log`（`external-loop-state.ts:121-156`）。**能记录，但管不住**。

### Native vs CLI 工具能力对比

| 维度 | Native（a2a ReAct） | CLI（claude_cli / codex_cli） |
|------|--------------------|------------------------------|
| 工具类型 | MCP + ACP connector + builtin + skill | 全由外部 CLI 决定 |
| **sandbox 授权** | 强制（act 阶段 `loadPolicy` + check*Call） | **完全不生效**（driver 不 load policy） |
| toolKind 精度 | 精确区分 mcp/acp_connector/skill/builtin | **恒 `builtin`** |
| status | success/error/timeout/sandbox_blocked | **恒 `success`**（靠后续 error 行兜底） |
| latency | 真实 ms | **恒占位 1ms** |
| MCP 调用 | 直接 `dispatchMcpToolCall` | 仅经 MCP bridge（`mcp-bridge-server.ts` 的 `call_qubit_mcp`）回跳 native |
| ACP connector / skill | 支持 | **不支持** |

### 问题

1. **安全**：CLI 路径完全绕过 sandbox policy（`cli-loop-driver.ts` 不涉及 `sandboxExecutor`）——授权收口（#3）只覆盖 native，CLI 是治理盲区。一旦 CLI 路径用于实盘相关工具，等于无闸门。
2. **观测失真**：CLI 工具调用在监控里 toolKind 恒 builtin、status 恒 success、latency 恒 1ms（与第一节 #4 治理同源的「假 1ms」问题，但 CLI 是结构性写死，连区分都做不到）。p50/p95 和成功率被污染。
3. **能力缺口**：CLI 调不到 ACP connector / skill，MCP 也只能绕 bridge——CLI 路径本质是「外部 agent 借壳跑」，与本系统工具体系半脱节。

### 简单方案

- **C1（安全，建议提到 P0）**：在 CLI 接收 `tool` 事件、或 MCP bridge 转发 `call_qubit_mcp` 时，过一遍 `isToolAuthorized/isMcpAuthorized`（#3 已抽好的纯函数），拒绝则回 error 行 + 记 `sandbox_blocked`。先覆盖 bridge 这条「CLI→本系统工具」的真实通道，成本最低、收益最大。
- **C2（观测）**：扩 `qubit.loop.v1` 的 `tool` 行，让 CLI 携带 `toolKind` / `ok` / `durationMs`；`recordExternalLoopToolCall` 按实填写，去掉写死的 builtin/success/1ms。CLI 侧不传时再退回占位。
- **定位**：明确 CLI 路径定位为「轻量调试/研究」，生产关键链路（尤其实盘）走 native；在文档/产品层面标注，避免误用。
- **验收**：bridge 调用受 policy 约束（越权被拒并留痕）；监控里 CLI 工具调用 toolKind/status/latency 不再恒为占位值。
