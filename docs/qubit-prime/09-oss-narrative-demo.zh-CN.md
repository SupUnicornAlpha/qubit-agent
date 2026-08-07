# Qubit Prime — 开源叙事减负与一键演示路径

| 项 | 内容 |
|----|------|
| 文档状态 | **规划稿 v0.1 · 主战场之一** |
| 日期 | 2026-08-07 |
| 对标 | QuantDinger `README` + `install.sh` + GHCR Compose + Live App / Demo |
| 依赖 | [06](./06-strategy-contract.zh-CN.md) · [07](./07-execution-trader-agent.zh-CN.md) · [08](./08-data-catalog-pit.zh-CN.md) 的 **演示切片**（不必等全量 Crypto） |
| 非目标 | 复制赞助商墙式营销；把商业闭环绑进默认安装 |

---

## 1. 问题陈述

QuantDinger 星标心智来自三句话就能复述的产品，加一条命令能跑起来：

> AI research → Strategy → Backtest → Paper/Live → Monitoring  
> `curl …/install.sh | bash`

我们强在 Agent Runtime / HITL / IDE，但对外叙事偏「架构升级文档丛」，启动是多终端 `bun` + `cargo` + 可选 Python 桥——**非专业用户在 15 分钟内形不成成功体验**。

本篇只解：**一句话 + 一条演示路径（研究→纸交易）**。

---

## 2. 一句话闭环（建议冻结文案）

**中文（README 首屏）**

> Qubit：会研究、会辩论、能落纸交易的量化 Agent 工作台——从对话与多智能体研究，到同源策略回测与纸盘意图，全程可审计、可 HITL。

**English**

> Qubit is a multi-agent quant research workbench: debate → strategy contract → backtest → paper intents, with human-in-the-loop and an IDE-grade workspace.

**刻意不写**：全交易所实盘、高频、Instant Star。  
**必须露出**：Multi-agent · HITL · Strategy contract · Paper trading · Self-hosted。

与 QD 差异一句话（可选「Why Qubit」小节）：

> QuantDinger 偏 Trading OS；Qubit 偏 Research OS——同一条 Intent 链可接到纸盘，研究过程才是一等公民。

---

## 3. 演示路径（Happy Path · 15–20 min）

目标：陌生人按文档做，不需读 01–05。

| Step | 用户动作 | 系统行为 | 依赖切片 |
|------|----------|----------|----------|
| 0 | `./scripts/demo-up.sh`（或 compose） | 起 Bun API + Frontend +（可选）Prime Core | 见 §4 |
| 1 | 打开研究页，HITL=智能 | Orchestrator 会话就绪 | 现有 TeamPage |
| 2 | 发送：「用日线均线做 SPY/沪深300 示例策略」 | 写出/编译策略（06）或落到示例仓库路径 | SC1+ |
| 3 | 点「回测」 | 输出权益曲线 + Manifest 只读 | SC1 · DC1 最小池 |
| 4 | 点「纸交易启动」或对话批准 | PaperSession + intents 出现在执行/Run 条 | SC2 · EX1 |
| 5 | （可选）HITL=每次，见到审批卡 | 证明人工闸门 | 现有 HITL |

**演示资产（进仓）**：

```text
examples/demo/
  ma_cross_spy.py          # 合法 Strategy API 脚本
  README.md                # 只讲这 5 步
scripts/demo-up.sh         # 一键
docker-compose.demo.yml    # 可选
```

---

## 4. 一键技术形态

### 4.1 P0（最快，对齐现状）

不追求 QD 级多容器：

```bash
# scripts/demo-up.sh
# 1) 检查 bun / python venv
# 2) 迁移 SQLite
# 3) 并行：API + Vite
# 4) 打印 URL + 示例话术
# 5) 可选：QUBIT_CORE_BACKEND=ts 降低失败面（演示默认 ts）
```

验收：干净机器（已装 bun）`demo-up` 后浏览器打开即可 Step1。

### 4.2 P1（接近星标体验）

`docker-compose.demo.yml`：

| Service | 镜像/构建 | 端口 |
|---------|-----------|------|
| `api` | Dockerfile.api（bun） | 3000 |
| `web` | Dockerfile.web 或 vite preview | 5173 |
| （可选）`core` | qubit-app-server | 8787 |

默认 **不开** 实盘、**不开** 重可观测栈。  
`.env.demo` 仅演示密钥位。

### 4.3 明确不做（演示）

- 强制 Rust Core 健康才启动（演示默认 `ts`，文档写「生产可切 rust」）  
- 多用户计费 / OAuth / Telegram  
- 全市场数据镜像  

---

## 5. README 信息架构（减负）

建议仓库根 README 分区（草稿提纲）：

1. **Hero**：一句话 + 徽章（License / Bun / Rust optional）  
2. **30 秒理解**：研究 → 契约 → 回测 → 纸交易（小流程图）  
3. **Quick start**：`demo-up`  
4. **What makes Qubit different**：多专家 · HITL · IDE · 可审计 Intent  
5. **Architecture（短）**：链到 `docs/qubit-prime/`  
6. **Status**：诚实写纸交易就绪 / 实盘外挂  
7. **Contributing / 深文档入口**

深度文档 **下沉**，禁止把 01 全文顶到首页。

中英：可先中文完整 + README_EN 精简，或对调——建议 **英文短 Hero + 中文详演示**（国内团队）或双语文首屏。

---

## 6. 里程碑

| ID | 产出 | 验收 |
|----|------|------|
| **OS0** | 冻结一句话文案 + README 提纲 PR | 外人 10s 能复述 |
| **OS1** | `examples/demo` + `scripts/demo-up.sh` | 内部新人跟做 ≤20min |
| **OS2** | 演示路径打通到纸交易 Intent（依赖 06/07/08 P0） | 录 3min 屏或 GIF |
| **OS3** | `docker-compose.demo.yml` | 无本地 bun 也能起（可选） |
| **OS4** | 短视频 / Discussions 模板 | 传播物料 |

**依赖**：OS2 卡在 06 SC2 + 08 DC2；OS0–OS1 **可立刻做**。

---

## 7. 成功指标（务实）

| 指标 | 目标 |
|------|------|
| 冷启动到首条 Orchestrator 回复 | ≤ 10 min（含装依赖） |
| 演示路径完成率（内部试用） | ≥ 80% 无人工救火 |
| README 首屏无「架构法庭」段落 | 通过 |

---

## 8. 风险

| 风险 | 缓解 |
|------|------|
| 演示夸大实盘 | 文案固定 Paper；按钮禁用 Live |
| demo-up 与开发脚本分叉 | demo 调复用 `dev-backend` 子集 |
| 星标导向扭曲产品 | 演示只兑现真实已有能力 |

---

## 9. 修订记录

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-08-07 | v0.1 | 叙事 + demo-up；主战场之四 |
