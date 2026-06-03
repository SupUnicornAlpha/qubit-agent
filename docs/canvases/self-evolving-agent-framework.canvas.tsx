/**
 * Qubit Self-Evolving Agent — 记忆体升级 + 自动进化框架 全景图
 *
 * 一张 canvas 把 P4a→P9 全部交付总览：
 *   - 飞轮三大能力 + 三处断点的现状
 *   - 9 个落地阶段（P4a..P9）的核心交付
 *   - 4 个 worker + 1 个 reason 注入 在数据流中的位置
 *   - 三层开关 + cron 编排建议
 *   - 量化指标（测试数、文件数）
 *   - P10 backlog 决策
 */

import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  Code,
  Grid,
  H1,
  H2,
  H3,
  Link,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
  useHostTheme,
} from "cursor/canvas";

// ============================================================================
// Data
// ============================================================================

const STAGES: Array<{
  id: string;
  title: string;
  scope: string;
  delivers: string;
  state: "done";
  tests: string;
}> = [
  {
    id: "P4a",
    title: "PnL 基础设施（路面）",
    scope: "数据底座",
    delivers:
      "daily_mark_price / strategy_pnl_snapshot / fee_schedule + 4 模块",
    state: "done",
    tests: "78 tests",
  },
  {
    id: "P4b",
    title: "PnL 反馈环（燃料）",
    scope: "归因",
    delivers:
      "PnlAttributor + SkillAttributor + agent_pnl_attribution + 后端只读接口 + 对账",
    state: "done",
    tests: "106 attribution + 12 metrics",
  },
  {
    id: "P5",
    title: "Skill 晋升（齿轮）",
    scope: "经验→skill",
    delivers:
      "SkillPromoter + skill_promotion_run + approve/reject + 前端 Skill Promotions sub-tab",
    state: "done",
    tests: "9 scoring + 8 worker + 9 routes + 1 metrics",
  },
  {
    id: "P6",
    title: "Skill 自动修订（自动触发链路）",
    scope: "skill→skill",
    delivers:
      "requestSkillRevision 队列 + SkillEvolverWatcher + LCS 行级 diff",
    state: "done",
    tests: "8 watcher + 1 metrics + 9 routes",
  },
  {
    id: "P7",
    title: "Tool Gap 观测",
    scope: "工具缺口检测",
    delivers:
      "3 detector + tool_gap_log + builtin tool.report_gap + 前端 Tool Gaps sub-tab",
    state: "done",
    tests: "55 tests",
  },
  {
    id: "P8",
    title: "Tool 自装配 propose 模式",
    scope: "工具自装配（人工审批）",
    delivers:
      "AutoInstaller + candidate-matcher + auto_install_proposal + 4 routes + Proposals UI",
    state: "done",
    tests: "51 tests",
  },
  {
    id: "P9",
    title: "PnL-aware reason + auto 模式 + 召回观察期",
    scope: "闭环最后一环",
    delivers:
      "self-evolve-config 三层开关 + reason 注入 top-K PnL skill + AutoInstaller auto 真装 + SkillBaselineObserver auto enable",
    state: "done",
    tests: "41 单测 + 6 auto 集成测",
  },
];

const WORKERS: Array<{
  name: string;
  期: string;
  trigger: string;
  reads: string;
  writes: string;
  cron: string;
}> = [
  {
    name: "PnlAttributor",
    期: "P4b",
    trigger: "snapshot 写入后增量",
    reads: "strategy_pnl_snapshot, fill",
    writes: "agent_pnl_attribution",
    cron: "60 min",
  },
  {
    name: "SkillPromoter",
    期: "P5",
    trigger: "procedural experience 召回阈值",
    reads: "experience(procedural), skill_recall_log",
    writes: "agent_skill(pending_review), skill_promotion_run",
    cron: "每日",
  },
  {
    name: "SkillEvolverWatcher",
    期: "P6",
    trigger: "reflective(skill_revision_request)",
    reads: "experience(reflective)",
    writes: "agent_skill(evolved, pending_review), skill_evolution_run",
    cron: "每日",
  },
  {
    name: "ToolGapWatcher",
    期: "P7",
    trigger: "agent_step.failure / report_gap",
    reads: "agent_step, experience(reflective)",
    writes: "tool_gap_log, tool_gap_run",
    cron: "60 min",
  },
  {
    name: "AutoInstaller",
    期: "P8/P9",
    trigger: "tool_gap_log.status=open",
    reads: "tool_gap_log, mcp_catalog, mcp_catalog_item",
    writes:
      "auto_install_proposal, (auto 模式) mcp_server_config + mcp_tool_binding",
    cron: "60 min",
  },
  {
    name: "SkillBaselineObserver",
    期: "P9",
    trigger: "evolved + pending_review skill 自然累积",
    reads: "agent_skill, skill_recall_log, agent_skill_run",
    writes: "agent_skill.state=active (via approveSkillPromotion)",
    cron: "每日",
  },
];

const METRICS: Array<{ name: string; 期: string; meaning: string }> = [
  { name: "self_evolve.pnl_attributor.runs_total{status}", 期: "P4b", meaning: "PnL 归因 worker 运行次数" },
  { name: "self_evolve.skill_promoter.promoted_total", 期: "P5", meaning: "本日新晋升 skill 数" },
  { name: "self_evolve.skill_evolver.processed", 期: "P6", meaning: "本日成功进化 skill 数" },
  { name: "self_evolve.tool_gap_watcher.gaps_created", 期: "P7", meaning: "本日发现的新 tool gap" },
  { name: "self_evolve.auto_installer.proposals_created", 期: "P8", meaning: "本日新建 proposal 数" },
  { name: "self_evolve.auto_installer.tick.by_mode{mode}", 期: "P9", meaning: "propose vs auto 比例" },
  { name: "self_evolve.auto_installer.auto_installed", 期: "P9", meaning: "auto 模式真装成功数" },
  { name: "self_evolve.skill_baseline_observer.approved", 期: "P9", meaning: "召回观察期自动 enable 数" },
];

const CONFIG_ROWS: Array<{ env: string; def: string; meaning: string }> = [
  { env: "SELF_EVOLVE_ENABLED", def: "false", meaning: "总闸；关时 4 worker / reason 注入 / AutoInstaller 全停" },
  { env: "AUTO_INSTALL_MODE", def: "propose", meaning: "off / propose / auto（P9 自动审批+真装）" },
  { env: "PNL_AWARE_REASON_ENABLED", def: "随总闸", meaning: "单独关 reason 注入的逃生口" },
  { env: "AUTO_INSTALL_MIN_SCORE", def: "0.85", meaning: "auto 准入分数线（高于候选下限 0.3）" },
  { env: "REASON_PNL_TOP_N", def: "3", meaning: "reason 节点注入 top-K skill" },
  { env: "REASON_PNL_WINDOW_DAYS", def: "7", meaning: "reason 节点 PnL 聚合窗口" },
];

const CRON_ROWS: Array<{ freq: string; cmd: string; note: string }> = [
  { freq: "60 min", cmd: "run-pnl-attributor.ts", note: "P4b：先有 PnL 才有 P9 排行" },
  { freq: "60 min", cmd: "run-tool-gap-watcher.ts", note: "P7：先有 gap 才有 proposal" },
  { freq: "60 min", cmd: "run-auto-installer.ts --projectId=...", note: "P8/P9：mode=auto 时真装" },
  { freq: "每日", cmd: "run-skill-evolver-watcher.ts --projectId=...", note: "P6：跑 evolved skill" },
  { freq: "每日", cmd: "run-skill-baseline-observer.ts --projectId=...", note: "P9：召回观察期 → auto enable" },
  { freq: "每日", cmd: "run-skill-promoter.ts --projectId=...", note: "P5：propose 升级路径" },
];

const BACKLOG_ROWS: Array<{ id: string; title: string; effort: string; trigger: string }> = [
  {
    id: "P10-A",
    title: "SkillBaselineObserver dataset replay 第二档（上线前硬通过）",
    effort: "~4.5 人/日",
    trigger: "evolved skill pending 平均停留 ≥ 21 天，或线上误判事件 ≥ 1 起",
  },
  {
    id: "P10-B",
    title: "mcp_server_allowlist 显式表 + CRUD（按 project 单条覆盖）",
    effort: "~4.5 人/日",
    trigger: "用户提出单条 catalog 禁用，或 auto 装错事件 ≥ 1 起",
  },
];

// ============================================================================
// Pieces
// ============================================================================

function FlywheelDiagram(): JSX.Element {
  const theme = useHostTheme();
  // 简单 4-box 流水图：选股 → 成交 → 归因 → reason+skill；线上节点 + skill 配工具
  const nodeStyle = {
    border: `1px solid ${theme.stroke.secondary}`,
    background: theme.bg.elevated,
    borderRadius: 6,
    padding: "10px 14px",
    minWidth: 120,
    textAlign: "center" as const,
  };
  const arrowText = { color: theme.text.tertiary, fontSize: 11, padding: "0 6px" };
  const accentArrow = { color: theme.accent.primary, fontSize: 11, padding: "0 6px", fontWeight: 600 };

  return (
    <Stack gap={12}>
      <Row gap={4} align="center" wrap>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">选股 / 因子</Text>
          <Text tone="tertiary" size="small">workflow_run</Text>
        </div>
        <span style={arrowText}>→ 实盘</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">成交</Text>
          <Text tone="tertiary" size="small">fill / pnl_snapshot</Text>
        </div>
        <span style={accentArrow}>→ P4b 归因</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">PnL 归因</Text>
          <Text tone="tertiary" size="small">agent_pnl_attribution</Text>
        </div>
        <span style={accentArrow}>→ P9 注入</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">reason + skill</Text>
          <Text tone="tertiary" size="small">召回 top-K PnL skill</Text>
        </div>
      </Row>
      <Row gap={4} align="center" wrap>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">Tool / MCP 调用</Text>
          <Text tone="tertiary" size="small">tool_call_log</Text>
        </div>
        <span style={accentArrow}>← P7 gap</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">Tool Gap 上报</Text>
          <Text tone="tertiary" size="small">tool_gap_log</Text>
        </div>
        <span style={accentArrow}>← P8/P9 装配</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">AutoInstaller</Text>
          <Text tone="tertiary" size="small">propose / auto</Text>
        </div>
        <span style={accentArrow}>← P5/P6/P9</span>
        <div style={nodeStyle}>
          <Text weight="semibold" size="small">Skill 进化 + enable</Text>
          <Text tone="tertiary" size="small">SkillPromoter + Evolver + BaselineObserver</Text>
        </div>
      </Row>
    </Stack>
  );
}

function StageCard({ stage }: { stage: (typeof STAGES)[number] }): JSX.Element {
  return (
    <Card>
      <CardHeader trailing={<Pill tone="success" active size="sm">交付</Pill>}>
        {stage.id} · {stage.title}
      </CardHeader>
      <CardBody>
        <Stack gap={6}>
          <Row gap={6} align="center">
            <Pill size="sm" tone="info">{stage.scope}</Pill>
            <Pill size="sm" tone="neutral">{stage.tests}</Pill>
          </Row>
          <Text tone="secondary" size="small">{stage.delivers}</Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function SelfEvolvingAgentFramework(): JSX.Element {
  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1280 }}>
      {/* ── Header ───────────────────────────── */}
      <Stack gap={6}>
        <Row align="center" gap={10}>
          <H1>Self-Evolving Agent 框架全景</H1>
          <Pill tone="success" active>P4a–P9 全部交付</Pill>
        </Row>
        <Text tone="secondary">
          从「听话的 ReAct 执行者」升级为「用得越多越聪明、缺什么自己补」的自进化系统。
          数据飞轮三大能力 + 9 期落地 + 4 worker + 三层开关 + cron 编排，一张图看完。
        </Text>
        <Text tone="tertiary" size="small">
          源文档：<Link href="vscode://file//Users/jiajun.wu03/repos/mine_repos/qubit-agent/docs/SELF_EVOLVING_AGENT_DESIGN.md">SELF_EVOLVING_AGENT_DESIGN.md</Link>
          {" · "}
          backlog：<Link href="vscode://file//Users/jiajun.wu03/repos/mine_repos/qubit-agent/docs/SELF_EVOLVING_AGENT_P10_BACKLOG.md">SELF_EVOLVING_AGENT_P10_BACKLOG.md</Link>
          {" · "}最新 commit：<Code>4233991</Code>
        </Text>
      </Stack>

      {/* ── KPI 数字 ───────────────────────────── */}
      <Grid columns={5} gap={12}>
        <Stat value="9" label="交付期 (P4a–P9)" tone="success" />
        <Stat value="6" label="新 worker + reason 注入" />
        <Stat value="14" label="self_evolve.* metrics" />
        <Stat value="128" label="P9 回归全过 (single-run)" tone="success" />
        <Stat value="20" label="人/日 总投入" />
      </Grid>

      {/* ── 飞轮全景 ───────────────────────────── */}
      <Stack gap={10}>
        <H2>一、飞轮全景</H2>
        <Text tone="secondary">
          黑色箭头 = 数据采集（一直有）；蓝色箭头 = P4b/P7/P8/P9 新增的"反馈/补救/引导"边。
          飞轮从此能闭环：成交 → 归因 → 引导 → 更好决策 → 更多 PnL。
        </Text>
        <Card>
          <CardBody style={{ padding: 18 }}>
            <FlywheelDiagram />
          </CardBody>
        </Card>
      </Stack>

      {/* ── 9 期路线图 ───────────────────────────── */}
      <Stack gap={10}>
        <H2>二、9 期路线图（已全部交付）</H2>
        <Grid columns={3} gap={12}>
          {STAGES.map((s) => (
            <StageCard key={s.id} stage={s} />
          ))}
        </Grid>
      </Stack>

      {/* ── 4 worker + 1 reason 注入 ───────────── */}
      <Stack gap={10}>
        <H2>三、Worker 矩阵（数据流定位）</H2>
        <Text tone="secondary">
          6 个常驻角色：5 个 worker + reason 节点的 PnL skill 注入（不是 worker 但是关键的飞轮闭合点）。
        </Text>
        <Table
          headers={["Worker", "期", "触发", "Reads", "Writes", "频率"]}
          rows={WORKERS.map((w) => [
            <Text weight="semibold">{w.name}</Text>,
            <Pill size="sm" tone="info">{w.期}</Pill>,
            <Text size="small">{w.trigger}</Text>,
            <Code>{w.reads}</Code>,
            <Code>{w.writes}</Code>,
            <Pill size="sm">{w.cron}</Pill>,
          ])}
          columnAlign={["left", "left", "left", "left", "left", "center"]}
          striped
        />
      </Stack>

      {/* ── 三层开关 ─────────────────────────── */}
      <Grid columns="1fr 1fr" gap={16}>
        <Stack gap={8}>
          <H2>四、三层开关（self-evolve-config.ts）</H2>
          <Text tone="secondary" size="small">
            进入 P9 后，所有自进化能力都受这 6 个 env 控制；总闸默认 <Code>false</Code>，
            开线上才打开。所有 worker 在入口 gate <Code>selfEvolveDisabledReason()</Code> 留 audit。
          </Text>
          <Table
            headers={["env", "默认", "含义"]}
            rows={CONFIG_ROWS.map((r) => [
              <Code>{r.env}</Code>,
              <Pill size="sm" tone={r.def === "false" ? "warning" : "neutral"}>{r.def}</Pill>,
              <Text size="small">{r.meaning}</Text>,
            ])}
            columnAlign={["left", "center", "left"]}
          />
        </Stack>

        {/* ── cron 编排 ──────────────────────── */}
        <Stack gap={8}>
          <H2>五、Cron 编排建议</H2>
          <Text tone="secondary" size="small">
            顺序很重要：先 PnL 归因和 Gap 检测，再 AutoInstaller，最后 SkillPromoter / Evolver / Observer。
            前者是后者的输入。
          </Text>
          <Table
            headers={["频率", "命令", "备注"]}
            rows={CRON_ROWS.map((r) => [
              <Pill size="sm">{r.freq}</Pill>,
              <Code>{r.cmd}</Code>,
              <Text size="small" tone="secondary">{r.note}</Text>,
            ])}
            columnAlign={["center", "left", "left"]}
          />
        </Stack>
      </Grid>

      {/* ── Metrics ─────────────────────────── */}
      <Stack gap={10}>
        <H2>六、监控指标</H2>
        <Text tone="secondary">
          全部接入 <Code>src/runtime/experience/metrics.ts</Code>，前端 MemoryTab 顶部展示。
          下面是各期最该盯的"信号灯"指标（不是全量），剩余指标见
          <Link href="vscode://file//Users/jiajun.wu03/repos/mine_repos/qubit-agent/docs/SELF_EVOLVING_AGENT_DESIGN.md">设计文档 §7.3</Link>。
        </Text>
        <Table
          headers={["Metric", "期", "含义"]}
          rows={METRICS.map((m) => [<Code>{m.name}</Code>, <Pill size="sm" tone="info">{m.期}</Pill>, m.meaning])}
          columnAlign={["left", "center", "left"]}
          striped
        />
      </Stack>

      {/* ── 灰度建议 ─────────────────────────── */}
      <Stack gap={10}>
        <H2>七、灰度上线 5 阶段</H2>
        <Grid columns={5} gap={10}>
          <Card>
            <CardHeader trailing={<Pill size="sm" tone="info">stage 1</Pill>}>接入</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>SELF_EVOLVE_ENABLED=true</Code> + <Code>AUTO_INSTALL_MODE=off</Code>
              </Text>
              <Text size="small" tone="tertiary">看到 attributor / mark_price / accuracy 三组指标有数据</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill size="sm" tone="info">stage 2 · 1 周</Pill>}>观察</CardHeader>
            <CardBody>
              <Text size="small">同上，只看不动</Text>
              <Text size="small" tone="tertiary">sharpe 出数；agent_skill.pnl_attribution_json 非空</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill size="sm" tone="info">stage 3 · 2 周</Pill>}>开晋升</CardHeader>
            <CardBody>
              <Text size="small">加跑 SkillPromoter</Text>
              <Text size="small" tone="tertiary">≥ 1 个 skill 晋升且被召回成功</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill size="sm" tone="warning">stage 4</Pill>}>上线 propose</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>AUTO_INSTALL_MODE=propose</Code>
              </Text>
              <Text size="small" tone="tertiary">用户实际 approve ≥ 1 个 proposal</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader trailing={<Pill size="sm" tone="warning">stage 5 · 仅实验</Pill>}>真 auto</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>AUTO_INSTALL_MODE=auto</Code> 仅实验 project
              </Text>
              <Text size="small" tone="tertiary">sandbox agent 完成端到端自装配</Text>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      {/* ── P10 backlog ─────────────────────── */}
      <Stack gap={10}>
        <Row align="center" gap={10}>
          <H2>八、P10 Backlog（暂不排期）</H2>
          <Pill tone="warning">观察后再决定</Pill>
        </Row>
        <Callout tone="info" title="为什么不直接做 P10">
          P9 已闭环；先看 30 天实际运行数据，看 evolved skill 停留时间 / auto 误装事件 / 用户单条
          catalog 禁用诉求 这些信号是否真出现，再决定是否排期。详见 backlog 文档。
        </Callout>
        <Table
          headers={["ID", "标题", "工时", "何时做（触发信号）"]}
          rows={BACKLOG_ROWS.map((b) => [
            <Pill size="sm" tone="info">{b.id}</Pill>,
            <Text weight="semibold">{b.title}</Text>,
            <Pill size="sm">{b.effort}</Pill>,
            <Text size="small" tone="secondary">{b.trigger}</Text>,
          ])}
          columnAlign={["center", "left", "center", "left"]}
        />
      </Stack>

      {/* ── 关键文件 ─────────────────────────── */}
      <Stack gap={10}>
        <H2>九、关键代码入口</H2>
        <Grid columns={2} gap={12}>
          <Card>
            <CardHeader>P9 三层开关</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/config/self-evolve-config.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">getSelfEvolveConfig() / setSelfEvolveConfigForTest() / selfEvolveDisabledReason()</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>reason 节点 PnL skill 注入</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/langgraph/nodes/pnl-aware-skill-block.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">buildPnlAwareSkillBlock(db, definitionId)，独立失败域</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>AutoInstaller (P8 propose + P9 auto)</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/auto-installer/installer.ts</Code> + <Code>./candidate-matcher.ts</Code> + <Code>./lifecycle.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">mode=auto + safety=low + score≥0.85 → 真装</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>MCP 自装配 service（抽出）</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/mcp/install-service.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">installMcpCatalogToProject() — route + worker 共用</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>SkillBaselineObserver</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/skill-baseline-observer/observer.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">召回观察期 → auto enable evolved skill</Text>
            </CardBody>
          </Card>
          <Card>
            <CardHeader>P4b PnL 归因（agent 维度 reader）</CardHeader>
            <CardBody>
              <Text size="small">
                <Code>src/runtime/attribution/skill-attributor.ts</Code>
              </Text>
              <Text size="small" tone="tertiary">listSkillRankingsByDefinition(definitionId, days, topK)</Text>
            </CardBody>
          </Card>
        </Grid>
      </Stack>

      {/* ── Footer ───────────────────────────── */}
      <Row align="center" gap={8}>
        <Text size="small" tone="tertiary">
          源：commit <Code>4233991</Code> · P4b/P5/P6/P7/P8/P9 单跑回归 128/128 全过
        </Text>
        <Spacer />
        <Text size="small" tone="tertiary">2026-06-03</Text>
      </Row>
    </Stack>
  );
}
