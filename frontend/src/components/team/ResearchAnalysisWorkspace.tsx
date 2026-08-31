import { type FC, useEffect, useMemo, useState } from "react";
import type { ResearchPhase, ResearchPhaseState, ResearchPhaseStatus } from "../../api/types";
import type { ResearchCanvasToolHit } from "../../lib/researchCanvasToolLink";
import { type LiveConversationEvent, LiveConversationView } from "./LiveConversationView";
import type { OrchestratorArtifact } from "./OrchestratorChatPanel";
import { formatRoleName } from "./conversationAvatar";

export interface ResearchAnalysisWorkspaceProps {
  events: LiveConversationEvent[];
  running: boolean;
  runProgress?: string;
  researchPhase?: ResearchPhase | null;
  researchPhases?: ResearchPhaseState[];
  focusSymbol?: string | null;
  focusExchange?: string | null;
  activeRationale?: { tool: string; why: string } | null;
  toolHits: ResearchCanvasToolHit[];
  artifacts: OrchestratorArtifact[];
  artifactsLoading?: boolean;
  artifactsError?: string | null;
  onOpenMarketEvidence: (hit: ResearchCanvasToolHit) => void;
  onOpenNewsEvidence: (hit: ResearchCanvasToolHit) => void;
  onOpenArtifact: (artifact: OrchestratorArtifact) => void;
}

const artifactLabels: Record<OrchestratorArtifact["kind"], string> = {
  factor: "因子",
  strategy: "策略",
  backtest: "回测",
  script: "脚本",
};

function formatEvidenceStatus(status: string): string {
  if (status === "success" || status === "completed" || status === "ok") return "OK";
  if (status === "running" || status === "pending") return "RUN";
  if (status === "failed" || status === "error") return "ERR";
  return status.toUpperCase() || "—";
}

type ResearchDetailLevel = "overview" | "professional";

const RESEARCH_PHASES = [
  { id: "scope", label: "范围", description: "确认标的与研究问题" },
  { id: "plan", label: "计划", description: "组织研究路径与任务" },
  { id: "evidence", label: "证据", description: "采集行情、新闻与数据" },
  { id: "analysis", label: "分析", description: "解释信号并形成判断" },
  { id: "validation", label: "验证", description: "检查样本、风险与基准" },
  { id: "delivery", label: "交付", description: "沉淀报告、因子或策略" },
] as const;

const RESEARCH_PHASE_STATUS_LABEL: Record<ResearchPhaseStatus, string> = {
  pending: "待开始",
  active: "进行中",
  completed: "已完成",
  revisited: "回访",
  blocked: "受阻",
};

function resolvePhaseState(
  phase: ResearchPhase,
  index: number,
  currentIndex: number,
  explicitStates: ResearchPhaseState[]
): ResearchPhaseState {
  const explicit = explicitStates.find((state) => state.phase === phase);
  if (explicit) return explicit;
  return {
    phase,
    status: index < currentIndex ? "completed" : index === currentIndex ? "active" : "pending",
  };
}

type StructuredMetric = {
  key: string;
  label: string;
  value: string;
  source: string;
  scope?: string;
  asOf?: string;
  method?: string;
  confidence?: string;
};

type MetricContext = Pick<StructuredMetric, "scope" | "asOf" | "method" | "confidence">;

const METRIC_LABELS: Record<string, string> = {
  close: "收盘价",
  price: "价格",
  open: "开盘价",
  high: "最高价",
  low: "最低价",
  volume: "成交量",
  sampleSize: "样本量",
  tradeCount: "交易次数",
  totalReturn: "总收益",
  totalReturnPct: "总收益率",
  annualReturn: "年化收益",
  annualizedReturn: "年化收益",
  sharpe: "夏普比率",
  sortino: "Sortino",
  maxDrawdown: "最大回撤",
  maxDrawdownPct: "最大回撤",
  winRate: "胜率",
  volatility: "波动率",
  turnover: "换手率",
  profitFactor: "盈亏比",
  commission: "手续费",
  latencyMs: "延迟",
};

const METRIC_CONTAINER_KEYS = new Set([
  "metrics",
  "data",
  "result",
  "summary",
  "stats",
  "performance",
  "handoff",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMetricKey(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(METRIC_LABELS, key) ||
    /(?:pct|rate|return|drawdown|sharpe|count|volume|price)$/i.test(key)
  );
}

function formatMetricValue(key: string, value: unknown, unit?: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const isPercent = Boolean(
      unit === "%" || /(?:pct|rate|return|drawdown|volatility|turnover)$/i.test(key)
    );
    const normalized = isPercent && Math.abs(value) <= 1 ? value * 100 : value;
    const suffix = isPercent ? "%" : typeof unit === "string" ? ` ${unit}` : "";
    return `${normalized.toLocaleString("zh-CN", { maximumFractionDigits: 4 })}${suffix}`;
  }
  if (typeof value === "string" && value.trim()) return unit ? `${value} ${String(unit)}` : value;
  return null;
}

function pickContextText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function readMetricContext(record: Record<string, unknown>): MetricContext {
  return {
    scope: pickContextText(record, ["scope", "symbol", "instrument", "universe"]),
    asOf: pickContextText(record, ["asOf", "asof", "dataAsOf", "timestamp", "endDate"]),
    method: pickContextText(record, ["method", "calculationMethod", "calculation", "formula"]),
    confidence: pickContextText(record, ["confidence", "confidenceLevel", "quality"]),
  };
}

function mergeMetricContext(parent: MetricContext, current: MetricContext): MetricContext {
  return {
    scope: current.scope ?? parent.scope,
    asOf: current.asOf ?? parent.asOf,
    method: current.method ?? parent.method,
    confidence: current.confidence ?? parent.confidence,
  };
}

function collectStructuredMetrics(
  value: unknown,
  source: string,
  output: StructuredMetric[],
  depth = 0,
  inheritedContext: MetricContext = {}
): void {
  if (depth > 4) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const row = asRecord(item);
      if (row) {
        const key = String(row.metric ?? row.name ?? row.key ?? "").trim();
        const formatted = key ? formatMetricValue(key, row.value ?? row.val, row.unit) : null;
        if (key && formatted) {
          const context = mergeMetricContext(inheritedContext, readMetricContext(row));
          output.push({
            key: `${source}:${key}:${formatted}`,
            label: METRIC_LABELS[key] ?? key,
            value: formatted,
            source,
            ...context,
          });
        } else {
          collectStructuredMetrics(item, source, output, depth + 1, inheritedContext);
        }
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  const context = mergeMetricContext(inheritedContext, readMetricContext(record));
  for (const [key, nested] of Object.entries(record)) {
    if (isMetricKey(key)) {
      const formatted = formatMetricValue(key, nested);
      if (formatted) {
        output.push({
          key: `${source}:${key}:${formatted}`,
          label: METRIC_LABELS[key] ?? key,
          value: formatted,
          source,
          ...context,
        });
      }
    }
    if (METRIC_CONTAINER_KEYS.has(key)) {
      collectStructuredMetrics(nested, source, output, depth + 1, context);
    }
  }
}

const MetricRow: FC<{ metric: StructuredMetric }> = ({ metric }) => (
  <div className="qb-research-analysis__metric-row">
    <span className="qb-research-analysis__metric-label">{metric.label}</span>
    <span className="qb-research-analysis__metric-value">{metric.value}</span>
    <span
      className="qb-research-analysis__metric-source"
      title={[metric.source, metric.scope, metric.asOf, metric.method, metric.confidence]
        .filter(Boolean)
        .join(" · ")}
    >
      {metric.source}
      {metric.scope ? ` · ${metric.scope}` : ""}
      {metric.asOf ? ` · 截至 ${metric.asOf}` : ""}
    </span>
    {metric.method || metric.confidence ? (
      <span className="qb-research-analysis__metric-context">
        {metric.method ? `方法 ${metric.method}` : ""}
        {metric.method && metric.confidence ? " · " : ""}
        {metric.confidence ? `置信 ${metric.confidence}` : ""}
      </span>
    ) : null}
  </div>
);

function latestNarrative(events: LiveConversationEvent[]): string {
  for (const event of [...events].reverse()) {
    if (
      event.kind === "message" &&
      event.fromRole !== "user" &&
      event.messageKind !== "tool_call" &&
      event.messageKind !== "reasoning_progress" &&
      event.contentText.trim()
    ) {
      return event.contentText.trim();
    }
  }
  return "";
}

function averageLatency(hits: ResearchCanvasToolHit[]): number | null {
  const values = hits
    .map((hit) => hit.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function buildReviewItems(
  events: LiveConversationEvent[],
  toolHits: ResearchCanvasToolHit[],
  running: boolean,
  focusSymbol?: string | null
): string[] {
  const items: string[] = [];
  const failed = toolHits.some((hit) => hit.status === "failed" || hit.status === "error");
  const text = events
    .filter((event) => event.kind === "message")
    .map((event) => event.contentText)
    .join("\n");
  if (running) items.push("研究仍在进行，当前结论只能视为阶段性判断。");
  if (failed) items.push("存在失败或异常工具调用，相关结论需要复核。");
  if (/风险|失效|不确定|缺口|不足/.test(text)) {
    items.push("分析流已提及风险、失效条件或数据限制，请在结论前确认。");
  }
  if (focusSymbol) items.push(`结论范围限定为 ${focusSymbol} 及当前查询时间窗口。`);
  if (items.length === 0) items.push("等待 Agent 明确风险、假设与失效条件。");
  return items;
}

function resolveResearchPhase(
  explicitPhase: ResearchPhase | null | undefined,
  events: LiveConversationEvent[],
  toolHits: ResearchCanvasToolHit[],
  artifacts: OrchestratorArtifact[],
  activeRationale?: { tool: string; why: string } | null
): number {
  if (explicitPhase) {
    const explicitIndex = RESEARCH_PHASES.findIndex((phase) => phase.id === explicitPhase);
    if (explicitIndex >= 0) return explicitIndex;
  }
  if (artifacts.length > 0) return 5;
  const text = events
    .filter((event) => event.kind === "message")
    .map((event) => event.contentText)
    .join("\n");
  if (/(验证|样本外|基准|回测|评估)/.test(text)) return 4;
  if (/(结论|判断|分析|解释|信号)/.test(text) && toolHits.length > 0) return 3;
  if (activeRationale || toolHits.length > 0) return 2;
  if (/(计划|方案|目标|研究问题)/.test(text)) return 1;
  return events.length > 0 ? 1 : 0;
}

type NextAction = {
  kind: "wait" | "evidence" | "artifact" | "followup" | "prompt";
  label: string;
  detail: string;
};

function resolveNextAction(
  running: boolean,
  events: LiveConversationEvent[],
  toolHits: ResearchCanvasToolHit[],
  artifacts: OrchestratorArtifact[],
  phaseIndex: number
): NextAction {
  if (running) {
    const nextPhase = RESEARCH_PHASES[Math.min(phaseIndex + 1, RESEARCH_PHASES.length - 1)];
    return {
      kind: "wait",
      label: nextPhase ? `等待${nextPhase.label}阶段` : "等待交付结果",
      detail: "Agent 正在继续执行，当前内容仍属于阶段性结果。",
    };
  }
  if (toolHits.some((hit) => hit.status === "failed" || hit.status === "error")) {
    return {
      kind: "evidence",
      label: "复核异常证据",
      detail: "打开最近一次行情或新闻调用，确认失败是否影响结论。",
    };
  }
  if (artifacts.length > 0) {
    return {
      kind: "artifact",
      label: "打开最新研究产出",
      detail: "查看 Agent 生成的因子、策略、回测或脚本。",
    };
  }
  if (events.length > 0 || toolHits.length > 0) {
    return {
      kind: "followup",
      label: "继续追问验证条件",
      detail: "建议询问数据窗口、失效条件或样本外表现。",
    };
  }
  return {
    kind: "prompt",
    label: "发送研究问题",
    detail: "从一个标的、指标或具体假设开始。",
  };
}

function findSnapshotValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = findSnapshotValue(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] != null) {
      return record[key];
    }
  }
  for (const nested of Object.values(record)) {
    const found = findSnapshotValue(nested, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function formatSnapshotValue(value: unknown): string {
  if (value == null) return "待工具返回";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "不可序列化";
  }
}

function formatJsonPreview(value: unknown, maxLength = 2800): string {
  if (value == null) return "暂无参数";
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…` : text;
  } catch {
    return "参数不可序列化";
  }
}

const EvidenceRow: FC<{
  hit: ResearchCanvasToolHit;
  onOpenMarket: () => void;
  onOpenNews: () => void;
}> = ({ hit, onOpenMarket, onOpenNews }) => {
  const isMarket = hit.kind === "market";
  const isNews = hit.kind === "news";
  const canOpen = isMarket || isNews;
  const dataAsOfValue = findSnapshotValue(hit.responseJson ?? hit.requestJson, [
    "asOf",
    "asof",
    "dataAsOf",
    "timestamp",
    "endDate",
  ]);
  const dataAsOf = dataAsOfValue == null ? null : formatSnapshotValue(dataAsOfValue);
  return (
    <div className="qb-research-analysis__evidence-row">
      <span
        className={`qb-research-analysis__status qb-research-analysis__status--${hit.status}`}
        title={hit.status}
      >
        {formatEvidenceStatus(hit.status)}
      </span>
      <div className="qb-research-analysis__evidence-main">
        <div className="qb-research-analysis__evidence-name">{hit.toolName}</div>
        <div className="qb-research-analysis__evidence-meta">
          {formatRoleName(hit.agentRole)}
          {hit.symbol ? ` · ${hit.symbol}${hit.exchange ? `.${hit.exchange}` : ""}` : ""}
          {dataAsOf ? ` · 截至 ${dataAsOf}` : ""}
          {hit.latencyMs != null ? ` · ${hit.latencyMs}ms` : ""}
        </div>
      </div>
      {canOpen ? (
        <button
          type="button"
          className="qb-research-analysis__evidence-open"
          onClick={isNews ? onOpenNews : onOpenMarket}
        >
          {isNews ? "新闻" : "行情"}
        </button>
      ) : null}
    </div>
  );
};

const ArtifactRow: FC<{
  artifact: OrchestratorArtifact;
  onOpen: () => void;
}> = ({ artifact, onOpen }) => (
  <button type="button" className="qb-research-analysis__artifact-row" onClick={onOpen}>
    <span
      className={`qb-research-analysis__artifact-kind qb-research-analysis__artifact-kind--${artifact.kind}`}
    >
      {artifactLabels[artifact.kind]}
    </span>
    <span className="qb-research-analysis__artifact-main">
      <span className="qb-research-analysis__artifact-title">{artifact.title}</span>
      {artifact.subtitle ? (
        <span className="qb-research-analysis__artifact-subtitle">{artifact.subtitle}</span>
      ) : null}
    </span>
    <span className="qb-research-analysis__artifact-arrow" aria-hidden>
      ↗
    </span>
  </button>
);

export const ResearchAnalysisWorkspace: FC<ResearchAnalysisWorkspaceProps> = ({
  events,
  running,
  runProgress,
  researchPhase,
  researchPhases = [],
  focusSymbol,
  focusExchange,
  activeRationale,
  toolHits,
  artifacts,
  artifactsLoading = false,
  artifactsError = null,
  onOpenMarketEvidence,
  onOpenNewsEvidence,
  onOpenArtifact,
}) => {
  const [detailLevel, setDetailLevel] = useState<ResearchDetailLevel>(() => {
    try {
      return window.localStorage.getItem("qb.team.research-detail-level") === "professional"
        ? "professional"
        : "overview";
    } catch {
      return "overview";
    }
  });
  const [selectedToolHitId, setSelectedToolHitId] = useState<string | null>(null);
  const [snapshotCopied, setSnapshotCopied] = useState(false);
  useEffect(() => {
    try {
      window.localStorage.setItem("qb.team.research-detail-level", detailLevel);
    } catch {
      /* localStorage 不可用时保持内存态 */
    }
  }, [detailLevel]);
  useEffect(() => {
    if (toolHits.length === 0) {
      setSelectedToolHitId(null);
      return;
    }
    if (!selectedToolHitId || !toolHits.some((hit) => hit.id === selectedToolHitId)) {
      setSelectedToolHitId(toolHits[0]?.id ?? null);
    }
  }, [toolHits, selectedToolHitId]);

  const narrative = useMemo(() => latestNarrative(events), [events]);
  const currentAgent = useMemo(() => {
    for (const event of [...events].reverse()) {
      if (event.kind === "message" && event.fromRole !== "user") {
        return formatRoleName(event.fromRole);
      }
    }
    return "Orchestrator";
  }, [events]);
  const recentEvidence = [...toolHits]
    .filter((hit) => hit.kind === "market" || hit.kind === "news")
    .reverse()
    .slice(0, 5);
  const recentArtifacts = artifacts.slice(-5).reverse();
  const structuredMetrics: StructuredMetric[] = [];
  for (const hit of [...toolHits].reverse().slice(0, 12)) {
    collectStructuredMetrics(
      hit.responseJson,
      `${formatRoleName(hit.agentRole)} · ${hit.toolName}`,
      structuredMetrics
    );
  }
  for (const event of events.slice(-30)) {
    if (event.kind !== "message") continue;
    collectStructuredMetrics(event.payloadJson, formatRoleName(event.fromRole), structuredMetrics);
  }
  const visibleMetrics = structuredMetrics
    .filter((metric, index, all) => all.findIndex((item) => item.label === metric.label) === index)
    .slice(0, 8);
  const successfulEvidence = toolHits.filter(
    (hit) => hit.status === "success" || hit.status === "completed" || hit.status === "ok"
  ).length;
  const failedEvidence = toolHits.filter(
    (hit) => hit.status === "failed" || hit.status === "error"
  ).length;
  const lastEventAt = events.at(-1)?.ts ?? null;
  const avgLatency = averageLatency(toolHits);
  const reviewItems = buildReviewItems(events, toolHits, running, focusSymbol);
  const currentPhaseIndex = resolveResearchPhase(
    researchPhase,
    events,
    toolHits,
    artifacts,
    activeRationale
  );
  const currentPhase = RESEARCH_PHASES[currentPhaseIndex] ?? RESEARCH_PHASES[0];
  const currentPhaseState = resolvePhaseState(
    currentPhase.id,
    currentPhaseIndex,
    currentPhaseIndex,
    researchPhases
  );
  const nextPendingPhase = RESEARCH_PHASES.find(
    (phase, index) =>
      index > currentPhaseIndex &&
      resolvePhaseState(phase.id, index, currentPhaseIndex, researchPhases).status === "pending"
  );
  const nextAction = resolveNextAction(running, events, toolHits, artifacts, currentPhaseIndex);
  const latestArtifact = recentArtifacts[0];
  const selectedToolHit =
    toolHits.find((hit) => hit.id === selectedToolHitId) ?? toolHits[0] ?? null;
  const callChain = events
    .filter((event) => event.kind === "message")
    .slice(-14)
    .reverse();
  const validationSource = selectedToolHit?.responseJson ?? selectedToolHit?.requestJson;
  const validationRows = [
    {
      label: "样本量",
      value: findSnapshotValue(validationSource, ["sampleSize", "sample_count", "n"]),
    },
    {
      label: "数据截止",
      value: findSnapshotValue(validationSource, ["asOf", "asof", "dataAsOf", "endDate"]),
    },
    {
      label: "验证集",
      value: findSnapshotValue(validationSource, [
        "validationSet",
        "validation",
        "outOfSample",
        "split",
      ]),
    },
    {
      label: "基准",
      value: findSnapshotValue(validationSource, ["benchmark", "baseline", "基准"]),
    },
  ];
  const reproducibleSnapshot = JSON.stringify(
    {
      scope: { symbol: focusSymbol ?? null, exchange: focusExchange ?? null },
      generatedAt: new Date().toISOString(),
      run: {
        eventCount: events.length,
        evidenceCount: toolHits.length,
        outputCount: artifacts.length,
      },
      selectedTool: selectedToolHit
        ? {
            id: selectedToolHit.id,
            name: selectedToolHit.toolName,
            agentRole: selectedToolHit.agentRole,
            createdAt: selectedToolHit.createdAt,
            request: selectedToolHit.requestJson ?? null,
            response: selectedToolHit.responseJson ?? null,
          }
        : null,
    },
    null,
    2
  );
  const copyReproducibleSnapshot = async () => {
    try {
      await navigator.clipboard.writeText(reproducibleSnapshot);
      setSnapshotCopied(true);
      window.setTimeout(() => setSnapshotCopied(false), 1800);
    } catch {
      setSnapshotCopied(false);
    }
  };

  return (
    <div className="qb-research-analysis" data-qb-research-analysis>
      <div className="qb-research-analysis__runbar">
        <div className="qb-research-analysis__runstate">
          <span
            className={`qb-research-analysis__run-dot${running ? " is-running" : ""}`}
            aria-hidden
          />
          <span className="qb-research-analysis__run-label">
            {running ? "ANALYSIS RUNNING" : events.length > 0 ? "RUN COMPLETE" : "READY"}
          </span>
          <span className="qb-research-analysis__run-progress">
            {runProgress ||
              (running ? "等待 Agent 输出下一步分析…" : "发送研究问题后，分析轨迹会显示在这里")}
          </span>
        </div>
        <div className="qb-research-analysis__run-actions">
          <div className="qb-research-analysis__run-metrics" aria-label="运行摘要">
            <span>{events.length} EVENTS</span>
            <span>{toolHits.length} EVIDENCE</span>
            <span>{artifacts.length} OUTPUTS</span>
          </div>
          <div
            className="qb-research-analysis__detail-toggle"
            role="tablist"
            aria-label="研究信息层级"
          >
            <button
              type="button"
              role="tab"
              aria-selected={detailLevel === "overview"}
              className={detailLevel === "overview" ? "is-active" : ""}
              onClick={() => setDetailLevel("overview")}
            >
              摘要
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={detailLevel === "professional"}
              className={detailLevel === "professional" ? "is-active" : ""}
              onClick={() => setDetailLevel("professional")}
            >
              专业
            </button>
          </div>
        </div>
      </div>

      <section className="qb-research-analysis__phasebar" aria-label="研究阶段">
        <div className="qb-research-analysis__phasebar-head">
          <div>
            <span className="qb-research-analysis__eyebrow">RESEARCH PIPELINE</span>
            <strong>
              {currentPhase.label}阶段 · {currentPhase.description}
            </strong>
          </div>
          <span className="qb-research-analysis__phasebar-next">
            {currentPhaseState.status === "blocked"
              ? "存在受阻阶段"
              : currentPhaseState.status === "revisited"
                ? "当前阶段正在回访"
                : running
                  ? nextPendingPhase
                    ? `建议下一步：${nextPendingPhase.label}`
                    : "等待交付结果"
                  : events.length > 0
                    ? "本轮已停止，可继续追问"
                    : "等待研究问题"}
          </span>
        </div>
        <ol className="qb-research-analysis__phase-list">
          {RESEARCH_PHASES.map((phase, index) => {
            const state = resolvePhaseState(phase.id, index, currentPhaseIndex, researchPhases);
            return (
              <li
                key={phase.id}
                className={`is-${state.status}${index === currentPhaseIndex ? " is-current" : ""}`}
                title={state.note || `${phase.label}：${RESEARCH_PHASE_STATUS_LABEL[state.status]}`}
                aria-current={index === currentPhaseIndex ? "step" : undefined}
              >
                <span className="qb-research-analysis__phase-index">{index + 1}</span>
                <span>{phase.label}</span>
                <small className="qb-research-analysis__phase-status">
                  {RESEARCH_PHASE_STATUS_LABEL[state.status]}
                </small>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="qb-research-analysis__grid">
        <section className="qb-research-analysis__stream" aria-label="Agent 分析流">
          <div className="qb-research-analysis__section-head">
            <div>
              <span className="qb-research-analysis__eyebrow">LIVE TRACE</span>
              <h3>分析流</h3>
            </div>
            <span className="qb-research-analysis__section-note">结构化过程 · 工具调用 · 结论</span>
          </div>
          <div className="qb-research-analysis__stream-body">
            <div className="qb-research-analysis__finding">
              <div className="qb-research-analysis__finding-head">
                <span className="qb-research-analysis__eyebrow">WORKING FINDING</span>
                <span className="qb-research-analysis__finding-agent">{currentAgent}</span>
              </div>
              <div className="qb-research-analysis__finding-title">
                {running ? "正在形成阶段性结论" : narrative ? "最近阶段结论" : "研究摘要"}
              </div>
              <div className="qb-research-analysis__finding-body">
                {narrative
                  ? narrative.length > (detailLevel === "overview" ? 420 : 1200)
                    ? `${narrative.slice(0, detailLevel === "overview" ? 420 : 1200)}…`
                    : narrative
                  : "先从右侧发送研究问题。Agent 的可见过程、证据和结论会按时间顺序汇总在这里。"}
              </div>
              {focusSymbol ? (
                <div className="qb-research-analysis__finding-scope">
                  SCOPE · {focusSymbol}
                  {focusExchange ? ` · ${focusExchange}` : ""}
                </div>
              ) : null}
              <div className="qb-research-analysis__finding-action">
                <span className="qb-research-analysis__eyebrow">NEXT ACTION</span>
                {nextAction.kind === "artifact" && latestArtifact ? (
                  <button
                    type="button"
                    className="qb-research-analysis__finding-action-button"
                    onClick={() => onOpenArtifact(latestArtifact)}
                  >
                    {nextAction.label} ↗
                  </button>
                ) : nextAction.kind === "evidence" && recentEvidence[0] ? (
                  <button
                    type="button"
                    className="qb-research-analysis__finding-action-button"
                    onClick={() =>
                      recentEvidence[0]?.kind === "news"
                        ? onOpenNewsEvidence(recentEvidence[0])
                        : onOpenMarketEvidence(recentEvidence[0])
                    }
                  >
                    {nextAction.label} ↗
                  </button>
                ) : (
                  <span className="qb-research-analysis__finding-action-label">
                    {nextAction.label}
                  </span>
                )}
                <span className="qb-research-analysis__finding-action-detail">
                  {nextAction.detail}
                </span>
              </div>
            </div>
            <LiveConversationView
              events={events}
              selfRole="orchestrator"
              layout="stream"
              contentMaxLength={detailLevel === "overview" ? 2800 : 5000}
              collapseToolCalls={detailLevel === "overview"}
              collapseA2AFromRole={detailLevel === "overview" ? "orchestrator" : undefined}
              emptyText="选择一个工作流并从右侧发送研究问题，Agent 的分析过程会实时出现在这里。"
            />
          </div>
        </section>

        <aside className="qb-research-analysis__inspector" aria-label="研究 Inspector">
          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">ACTIVE CONTEXT</span>
                <h3>当前执行</h3>
              </div>
              <span className={`qb-research-analysis__state-tag${running ? " is-running" : ""}`}>
                {running ? "RUNNING" : "IDLE"}
              </span>
            </div>
            {activeRationale ? (
              <div className="qb-research-analysis__rationale">
                <div className="qb-research-analysis__rationale-tool">
                  <span className="qb-research-analysis__rationale-mark" aria-hidden>
                    →
                  </span>
                  {activeRationale.tool}
                </div>
                <div className="qb-research-analysis__rationale-why">{activeRationale.why}</div>
              </div>
            ) : (
              <div className="qb-research-analysis__inspector-empty">
                {running ? "Agent 正在整理下一步…" : "暂无活动工具调用"}
              </div>
            )}
          </section>

          {detailLevel === "professional" ? (
            <section className="qb-research-analysis__professional-panel">
              <div className="qb-research-analysis__section-head">
                <div>
                  <span className="qb-research-analysis__eyebrow">AUDIT TRAIL</span>
                  <h3>专业复核</h3>
                </div>
                <span className="qb-research-analysis__section-note">可见调用链 · 参数 · 验证</span>
              </div>

              <div className="qb-research-analysis__audit-grid">
                <div className="qb-research-analysis__audit-section">
                  <div className="qb-research-analysis__audit-title">调用链</div>
                  <div className="qb-research-analysis__call-chain">
                    {callChain.length > 0 ? (
                      callChain.map((event) => (
                        <div key={event.id} className="qb-research-analysis__call-row">
                          <span className="qb-research-analysis__call-dot" aria-hidden />
                          <span className="qb-research-analysis__call-time">
                            {new Date(event.ts).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                          <span className="qb-research-analysis__call-agent">
                            {formatRoleName(event.fromRole)}
                          </span>
                          <span className="qb-research-analysis__call-kind">
                            {event.messageKind || "message"}
                            {event.toolName ? ` · ${event.toolName}` : ""}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="qb-research-analysis__inspector-empty">暂无可复核调用。</div>
                    )}
                  </div>
                </div>

                <div className="qb-research-analysis__audit-section">
                  <div className="qb-research-analysis__audit-title">参数快照</div>
                  <div className="qb-research-analysis__tool-selector">
                    {toolHits.slice(0, 8).map((hit) => (
                      <button
                        key={hit.id}
                        type="button"
                        className={selectedToolHit?.id === hit.id ? "is-active" : ""}
                        onClick={() => setSelectedToolHitId(hit.id)}
                      >
                        {hit.toolName}
                      </button>
                    ))}
                  </div>
                  <pre className="qb-research-analysis__json-preview">
                    {formatJsonPreview(selectedToolHit?.requestJson)}
                  </pre>
                </div>
              </div>

              <div className="qb-research-analysis__audit-grid">
                <div className="qb-research-analysis__audit-section">
                  <div className="qb-research-analysis__audit-title">验证集与复现条件</div>
                  <div className="qb-research-analysis__validation-list">
                    {validationRows.map((row) => (
                      <div key={row.label} className="qb-research-analysis__validation-row">
                        <span>{row.label}</span>
                        <strong>{formatSnapshotValue(row.value)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="qb-research-analysis__audit-section">
                  <div className="qb-research-analysis__audit-title">研究快照</div>
                  <p className="qb-research-analysis__audit-copy">
                    复制当前范围、调用参数和结果摘要，交给同事复核或在后续研究中复现。
                  </p>
                  <button
                    type="button"
                    className="qb-research-analysis__copy-snapshot"
                    onClick={copyReproducibleSnapshot}
                  >
                    {snapshotCopied ? "已复制研究快照" : "复制研究快照"}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">RUN QUALITY</span>
                <h3>研究质量</h3>
              </div>
              <span className="qb-research-analysis__count">
                {detailLevel === "professional" ? "PRO" : "VIEW"}
              </span>
            </div>
            <div className="qb-research-analysis__quality-grid">
              <div>
                <span>成功工具</span>
                <strong>{successfulEvidence}</strong>
              </div>
              <div>
                <span>失败工具</span>
                <strong className={failedEvidence > 0 ? "is-warning" : ""}>{failedEvidence}</strong>
              </div>
              <div>
                <span>平均延迟</span>
                <strong>{avgLatency != null ? `${avgLatency}ms` : "—"}</strong>
              </div>
              <div>
                <span>最近更新</span>
                <strong>
                  {lastEventAt
                    ? new Date(lastEventAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </strong>
              </div>
            </div>
          </section>

          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">REVIEW GATE</span>
                <h3>风险与假设</h3>
              </div>
              <span className="qb-research-analysis__count">{running ? "OPEN" : "CHECK"}</span>
            </div>
            <ul className="qb-research-analysis__review-list">
              {reviewItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>

          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">STRUCTURED DATA</span>
                <h3>运行指标</h3>
              </div>
              <span className="qb-research-analysis__count">{visibleMetrics.length}</span>
            </div>
            {visibleMetrics.length > 0 ? (
              <div className="qb-research-analysis__metric-list">
                {visibleMetrics.map((metric) => (
                  <MetricRow key={metric.key} metric={metric} />
                ))}
              </div>
            ) : (
              <div className="qb-research-analysis__inspector-empty">
                工具返回 metrics 或 Agent 交接指标后，会在这里结构化展示。
              </div>
            )}
          </section>

          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">EVIDENCE</span>
                <h3>行情与证据</h3>
              </div>
              <span className="qb-research-analysis__count">{recentEvidence.length}</span>
            </div>
            {recentEvidence.length > 0 ? (
              <div className="qb-research-analysis__evidence-list">
                {recentEvidence.map((hit) => (
                  <EvidenceRow
                    key={hit.id}
                    hit={hit}
                    onOpenMarket={() => onOpenMarketEvidence(hit)}
                    onOpenNews={() => onOpenNewsEvidence(hit)}
                  />
                ))}
              </div>
            ) : (
              <div className="qb-research-analysis__inspector-empty">
                Agent 调用行情或新闻工具后，相关证据会在这里出现。
              </div>
            )}
          </section>

          <section className="qb-research-analysis__inspector-section">
            <div className="qb-research-analysis__section-head qb-research-analysis__section-head--compact">
              <div>
                <span className="qb-research-analysis__eyebrow">OUTPUTS</span>
                <h3>研究产出</h3>
              </div>
              <span className="qb-research-analysis__count">{artifacts.length}</span>
            </div>
            {artifactsLoading ? (
              <div className="qb-research-analysis__inspector-empty">同步产物目录…</div>
            ) : artifactsError ? (
              <div className="qb-research-analysis__inspector-error">{artifactsError}</div>
            ) : recentArtifacts.length > 0 ? (
              <div className="qb-research-analysis__artifact-list">
                {recentArtifacts.map((artifact) => (
                  <ArtifactRow
                    key={`${artifact.kind}:${artifact.id}`}
                    artifact={artifact}
                    onOpen={() => onOpenArtifact(artifact)}
                  />
                ))}
              </div>
            ) : (
              <div className="qb-research-analysis__inspector-empty">
                Agent 生成的因子、策略和回测会自动收录在这里。
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
};
