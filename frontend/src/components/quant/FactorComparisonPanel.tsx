import { useEffect, useRef, useState } from "react";
import type { FactorRecord } from "../../api/backend";
import {
  type FactorComparisonSpec,
  type ResearchAttempt,
  type ResearchProtocol,
  submitFactorComparison,
} from "../../api/research-program";

type Metrics = {
  grossMeanBps: number | null;
  netMeanBps: number | null;
  meanTargetTurnover: number | null;
};
type Report = {
  version: "factor-incremental-v1";
  scope: "development_only";
  dataQualification: string;
  protocolId: string;
  datasetSnapshotId: string;
  horizonDays: number;
  verdict: "duplicate" | "insufficient_evidence" | "no_incremental_value" | "worth_validation";
  candidate: { id: string; name: string; expr: string };
  references: Array<{ id: string; name: string; expr: string }>;
  method: FactorComparisonSpec;
  expression: { duplicateFactorIds: string[] };
  signal: {
    days: number;
    eligibleDays: number;
    coverage: number;
    candidateRankIc: number | null;
    residualRankIc: number | null;
    residualDays: number;
    pairs: Array<{
      factorId: string;
      days: number;
      meanRankCorrelation: number | null;
      meanAbsoluteRankCorrelation: number | null;
      coverage: number;
    }>;
  };
  returns: { pairs: Array<{ factorId: string; periods: number; correlation: number | null }> };
  portfolio: {
    periods: number;
    eligiblePeriods: number;
    coverage: number;
    baseline: Metrics;
    candidate: Metrics;
    augmented: Metrics;
    deltaNetMeanBps: number | null;
    stability: Array<{
      segment: number;
      startDate: string;
      endDate: string;
      periods: number;
      deltaNetMeanBps: number | null;
    }>;
    costSensitivity: Array<{ costBps: number; deltaNetMeanBps: number | null }>;
    series: Array<{ date: string; deltaNetBps: number }>;
  };
  limitations: string[];
};
const verdictLabels = {
  duplicate: "已存在的表达式",
  insufficient_evidence: "证据不足",
  no_incremental_value: "暂未显示稳定增益",
  worth_validation: "值得进一步验证",
};
const verdictDetails = {
  duplicate:
    "候选在相同方向下与已有因子语法等价。调整已有因子的组合权重可能有用，但不能因此把它记成新因子。",
  insufficient_evidence: "共同样本、覆盖率或观测长度不足，当前不能判断新增价值。",
  no_incremental_value:
    "在预先约定的分配与成本下，增益没有跨三个开发子区间保持为正；这不等于所有使用方式都无价值。",
  worth_validation:
    "固定方法下观察到跨开发子区间的正增益。下一步需要独立评估，当前结果不构成封存验证。",
};
const number = (value: number | null | undefined, digits = 3) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percent = (value: number) => `${number(value * 100, 1)}%`;
export function isComparisonAttempt(attempt: ResearchAttempt) {
  return (
    !!attempt.requestJson &&
    typeof attempt.requestJson === "object" &&
    "operation" in attempt.requestJson &&
    attempt.requestJson.operation === "incremental_compare"
  );
}
function reportFrom(attempt: ResearchAttempt | undefined): Report | null {
  const value = attempt?.resultJson;
  return value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === "factor-incremental-v1" &&
    "portfolio" in value
    ? (value as Report)
    : null;
}

export function FactorComparisonPanel(props: {
  projectId: string;
  protocol: ResearchProtocol | undefined;
  factors: FactorRecord[];
  attempts: ResearchAttempt[];
  disabled: boolean;
  onSubmitted: () => void;
}) {
  const [factorId, setFactorId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const keys = useRef(new Map<string, string>());
  useEffect(() => () => controller.current?.abort(), []);
  const method = props.protocol?.spec.comparison;
  const candidates = props.factors.filter(
    (f) =>
      f.lang === "qlib_expr" &&
      f.providerKey === "qlib_expr" &&
      !method?.references.some((ref) => ref.factorId === f.id)
  );
  const attempts = props.attempts.filter(isComparisonAttempt);
  const selected = attempts.find((a) => a.id === selectedId) ?? attempts[0];
  const report = reportFrom(selected);
  const submit = async () => {
    if (!props.protocol || !method || !factorId || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    const key = `${props.protocol.id}:${factorId}`;
    const idempotencyKey = keys.current.get(key) ?? crypto.randomUUID();
    keys.current.set(key, idempotencyKey);
    try {
      const attempt = await submitFactorComparison(
        props.projectId,
        { factorId, idempotencyKey },
        abort.signal
      );
      if (abort.signal.aborted) return;
      keys.current.delete(key);
      setSelectedId(attempt.id);
      props.onSubmitted();
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!abort.signal.aborted) {
        setBusy(false);
        controller.current = null;
      }
    }
  };
  return (
    <section className="qb-research-section" aria-label="因子增量评估">
      <div className="qb-research-section-title">
        <h3>因子增量评估</h3>
        <span className="qb-research-muted">表达式 → 信号 → 收益 → 组合</span>
      </div>
      {!method ? (
        <p className="qb-research-note">
          先在“修订协议”中启用增量评估，选择对照因子、方向、固定加入权重和成本。比较条件随协议保存，不会在看到结果后自动调参。
        </p>
      ) : (
        <>
          <p className="qb-research-muted">
            {method.references.length} 个对照因子等权组成基准 · 候选占{" "}
            {percent(method.candidateWeight)} · 单边成本 {method.costBps} bps · 同一开发快照
          </p>
          <div className="qb-research-run">
            <label className="qb-research-field">
              <span>待比较候选</span>
              <select
                aria-label="待比较候选"
                value={factorId}
                disabled={busy || props.disabled}
                onChange={(event) => setFactorId(event.target.value)}
              >
                <option value="">选择不在基准中的候选</option>
                {candidates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="qb-quant-btn qb-quant-btn--primary"
              disabled={busy || props.disabled || !candidates.some((f) => f.id === factorId)}
              onClick={() => void submit()}
            >
              {busy ? "正在登记…" : "登记并比较"}
            </button>
          </div>
          {!candidates.length ? (
            <p className="qb-research-muted">
              没有可比较的内置表达式候选。请先在因子工坊注册与基准不同的候选。
            </p>
          ) : null}
          <p className="qb-research-muted">
            一次比较消耗 1 次总尝试额度，包含全部基准；不消耗封存评估额度。
          </p>
        </>
      )}
      {error ? (
        <p role="alert" className="qb-research-alert">
          {error}
        </p>
      ) : null}
      {attempts.length ? (
        <label className="qb-research-field">
          <span>查看比较记录</span>
          <select
            aria-label="查看比较记录"
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            {attempts.map((a) => (
              <option key={a.id} value={a.id}>
                {new Date(a.createdAt).toLocaleString("zh-CN")} ·{" "}
                {props.factors.find((f) => f.id === a.candidateId)?.name ?? a.candidateId} ·{" "}
                {a.status}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selected && !report ? (
        <output className="qb-research-note">
          {selected.status === "running" || selected.status === "pending"
            ? "实验已登记，正在比较；完成后报告会自动更新。"
            : `此次比较未产生报告：${selected.error ?? selected.status}`}
        </output>
      ) : null}
      {report ? <ComparisonReport report={report} /> : null}
    </section>
  );
}
function ComparisonReport({ report }: { report: Report }) {
  const portfolio = report.portfolio;
  return (
    <article className="qb-comparison-report">
      <header className="qb-comparison-verdict" data-verdict={report.verdict}>
        <div>
          <span className="qb-research-muted">{report.candidate.name} · 开发集证据</span>
          <h3>{verdictLabels[report.verdict]}</h3>
        </div>
        <span>
          {report.dataQualification === "passed" ? "数据检查通过" : "数据来源证据未齐 · 仅供研究"}
        </span>
        <p>{verdictDetails[report.verdict]}</p>
      </header>
      <dl className="qb-comparison-metrics">
        <div>
          <dt>候选 Rank IC</dt>
          <dd>{number(report.signal.candidateRankIc)}</dd>
        </div>
        <div>
          <dt>扣除基准后 Rank IC</dt>
          <dd>{number(report.signal.residualRankIc)}</dd>
        </div>
        <div>
          <dt>每期平均净增量</dt>
          <dd>
            {number(portfolio.deltaNetMeanBps, 2)} <small>bps</small>
          </dd>
        </div>
        <div>
          <dt>组合期覆盖</dt>
          <dd>
            {percent(portfolio.coverage)}{" "}
            <small>
              ({portfolio.periods}/{portfolio.eligiblePeriods})
            </small>
          </dd>
        </div>
      </dl>
      <div className="qb-research-table-wrap">
        <table className="qb-research-table">
          <caption>与已有因子的比较 · 相关性高低本身不决定是否有价值</caption>
          <thead>
            <tr>
              <th>已有因子</th>
              <th>同表达式</th>
              <th>日均排序相关</th>
              <th>平均绝对相关</th>
              <th>收益相关</th>
              <th>信号覆盖</th>
            </tr>
          </thead>
          <tbody>
            {report.references.map((ref) => {
              const signal = report.signal.pairs.find((p) => p.factorId === ref.id);
              const returns = report.returns.pairs.find((p) => p.factorId === ref.id);
              return (
                <tr key={ref.id}>
                  <td data-label="已有因子">{ref.name}</td>
                  <td data-label="同表达式">
                    {report.expression.duplicateFactorIds.includes(ref.id) ? "是" : "未识别为相同"}
                  </td>
                  <td data-label="日均排序相关">{number(signal?.meanRankCorrelation)}</td>
                  <td data-label="平均绝对相关">{number(signal?.meanAbsoluteRankCorrelation)}</td>
                  <td data-label="收益相关">{number(returns?.correlation)}</td>
                  <td data-label="信号覆盖">
                    {percent(signal?.coverage ?? 0)} · {signal?.days ?? 0} 日
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="qb-research-table-wrap">
        <table className="qb-research-table">
          <caption>固定分配的组合收益代理 · 非交易回测</caption>
          <thead>
            <tr>
              <th>组合</th>
              <th>每期毛收益（bps）</th>
              <th>每期净收益（bps）</th>
              <th>目标权重换手</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["基准组合", portfolio.baseline],
                ["候选单独", portfolio.candidate],
                ["加入候选后", portfolio.augmented],
              ] as const
            ).map(([label, metrics]) => (
              <tr key={label}>
                <td data-label="组合">{label}</td>
                <td data-label="每期毛收益">{number(metrics.grossMeanBps, 2)}</td>
                <td data-label="每期净收益">{number(metrics.netMeanBps, 2)}</td>
                <td data-label="目标权重换手">{number(metrics.meanTargetTurnover, 3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="qb-research-muted">
        次日开盘进入，持有 {report.horizonDays} 个共同交易日，不重叠采样。统一目标总敞口 1、净敞口
        0；成本基于目标权重变化近似。
      </p>
      <div className="qb-comparison-splits">
        <div>
          <h4>按时间三等分 · 每期净增量</h4>
          {portfolio.stability.map((part) => (
            <p key={part.segment}>
              <span>
                {part.startDate || "—"} — {part.endDate || "—"} · {part.periods} 期
              </span>
              <strong>{number(part.deltaNetMeanBps, 2)} bps</strong>
            </p>
          ))}
        </div>
        <div>
          <h4>单边成本敏感性</h4>
          {portfolio.costSensitivity.map((part) => (
            <p key={part.costBps}>
              <span>{part.costBps} bps 成本</span>
              <strong>{number(part.deltaNetMeanBps, 2)} bps 增量</strong>
            </p>
          ))}
        </div>
      </div>
      <details>
        <summary>方法边界与复核信息</summary>
        <ul>
          {report.limitations.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p>
          快照：<code>{report.datasetSnapshotId}</code>
        </p>
        <p>
          协议：<code>{report.protocolId}</code>
        </p>
        <p>原始报告与冻结表达式保留在下方实验台账中。</p>
      </details>
    </article>
  );
}
