import { useEffect, useRef, useState } from "react";
import {
  type ResearchAttempt,
  type ResearchStrategyVersion,
  manageResearchStrategy,
} from "../../api/research-program";

type Event = {
  id: string;
  kind: string;
  sequence: number;
  payloadJson: Record<string, unknown>;
  createdAt: string;
};
type Detail = {
  revision: number;
  status: string;
  events: Event[];
  readyRunIds: string[];
  source: ResearchAttempt | null;
  protocol: { version: number; spec: { hypothesis: string } } | null;
  dataError: string | null;
  checklist: Array<{ code: string; label: string; passed: boolean }>;
  receipts: Array<{
    attemptId: string;
    receipt: { status: string; reasonCodes: string[]; metrics: Record<string, number | null> };
  }>;
};
type Session = {
  id: string;
  status: string;
  automatic: boolean;
  reason: string | null;
  cursor: string | null;
  definition: { validationAtCreation: boolean };
  attempts: ResearchAttempt[];
};
type Comparison = {
  comparable: boolean;
  reason: string;
  diffs: Array<{ field: string; left: unknown; right: unknown }>;
  performance: {
    left: { metrics: Record<string, number> } | null;
    right: { metrics: Record<string, number> } | null;
  } | null;
};
const statusNames: Record<string, string> = {
  research: "研究中",
  review: "待验证",
  validated: "验证门通过",
  archived: "已归档",
  passed: "通过",
  rejected: "未通过",
  insufficient_evidence: "证据不足",
};
const receiptReasons: Record<string, string> = {
  research_only_diagnostics_not_validation: "已完成研究诊断；缺少时点证明，不能作为验证通过",
  verified_pit_evidence_required: "缺少可核验的历史时点证明",
  predeclared_strategy_gate_not_met: "未达到预先登记的策略门槛",
  predeclared_strategy_gate_passed: "达到预先登记的策略门槛",
  insufficient_observations_or_trades: "有效观测或交易数量不足",
};
const errors: Record<string, string> = {
  research_sealed_dataset_not_configured:
    "当前协议未绑定封存数据集。请先配置独立评估服务，再修订研究协议。",
  sealed_evaluator_not_configured: "尚未配置独立评估服务，无法进行正式验证。",
  strategy_validation_not_supported: "当前封存数据集未配置策略验证方法，请管理员在签名配置中登记。",
  strategy_revision_conflict: "状态已被更新，请刷新后重试。",
  strategy_archived: "版本已归档，请恢复研究后再运行。",
  research_evaluation_budget_exhausted: "封存验证额度已耗尽，不能通过换会话或改名称恢复。",
  research_attempt_budget_exhausted: "本项目总研究预算已耗尽。",
};
const errorText = (e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  return errors[message] ?? message;
};
const stageNames: Record<string, string> = {
  input: "输入数据",
  signal: "信号",
  target: "目标持仓",
  order: "调仓意图",
  fill: "成交",
  position: "持仓与资金",
};
export function ResearchStrategyLifecycle({
  projectId,
  version,
  versions,
  attempts,
  disabled,
  onSubmitted,
  onStatus,
}: {
  projectId: string;
  version: ResearchStrategyVersion;
  versions: ResearchStrategyVersion[];
  attempts: ResearchAttempt[];
  disabled: boolean;
  onSubmitted: () => void;
  onStatus: (status: string) => void;
}) {
  const onRefresh = useRef(onSubmitted);
  onRefresh.current = onSubmitted;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");
  const [other, setOther] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [reason, setReason] = useState("");
  const [snapshot, setSnapshot] = useState("");
  const [notice, setNotice] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and persisted attempt changes invalidate the server-derived evidence.
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      manageResearchStrategy<Detail>(
        projectId,
        version.id,
        { action: "inspect" },
        controller.signal
      ),
      manageResearchStrategy<Session[]>(
        projectId,
        version.id,
        { action: "paper_list" },
        controller.signal
      ),
    ])
      .then(([d, s]) => {
        if (!controller.signal.aborted) {
          setDetail(d);
          setSessions(s);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    return () => controller.abort();
  }, [projectId, version.id, refresh, attempts]);
  const automatic = sessions.some((s) => s.automatic && s.status === "running");
  useEffect(() => {
    if (!automatic) return;
    const timer = setInterval(() => {
      setRefresh((r) => r + 1);
      onRefresh.current();
    }, 5000);
    return () => clearInterval(timer);
  }, [automatic]);
  useEffect(() => {
    if (detail) onStatus(detail.status);
  }, [detail, onStatus]);
  const active = detail?.readyRunIds.includes(reference)
    ? reference
    : (detail?.readyRunIds[0] ?? "");
  async function act(command: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await manageResearchStrategy<unknown>(projectId, version.id, command);
      if (command.action === "compare") setComparison(result as Comparison);
      else {
        setRefresh((r) => r + 1);
        onSubmitted();
        setNotice("已保存。计算结果和失败原因保留在实验台账。");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const plan = detail?.events.find((e) => e.kind === "validation_plan");
  return (
    <section className="qb-research-section" aria-label="策略证据与生命周期">
      <div className="qb-research-section-title">
        <h3>策略证据与生命周期</h3>
        <strong>{statusNames[detail?.status ?? ""] ?? "加载中…"}</strong>
      </div>
      {error ? (
        <p role="alert" className="qb-research-alert">
          {error}
        </p>
      ) : null}
      {notice ? <output>{notice}</output> : null}
      {detail ? (
        <>
          <p>
            来源：
            {(detail.source?.candidateJson as { name?: string })?.name ??
              version.recipe.factor.name}{" "}
            → 比较 {version.recipe.sourceAttemptId.slice(0, 8)} → 协议 v
            {detail.protocol?.version ?? "—"} → 策略 {version.id.slice(-8)}
          </p>
          <p className="qb-research-muted">
            假设：{detail.protocol?.spec.hypothesis ?? "暂无记录"}
          </p>
          <ul className="qb-research-checklist">
            {detail.checklist.map((c) => (
              <li key={c.code} data-passed={c.passed}>
                {c.passed ? "✓" : "○"} {c.label}
              </li>
            ))}
          </ul>
          {detail.dataError ? <p role="alert">输入检查失败：{detail.dataError}</p> : null}
          <label className="qb-research-field">
            <span>引用回测（待验证与模拟使用同一版本证据）</span>
            <select
              aria-label="引用策略回测"
              value={active}
              onChange={(e) => setReference(e.target.value)}
            >
              <option value="">暂无成功回测</option>
              {detail.readyRunIds.map((id) => (
                <option key={id} value={id}>
                  {new Date(attempts.find((a) => a.id === id)?.createdAt ?? 0).toLocaleString()} ·{" "}
                  {id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <div className="qb-research-form">
            <label className="qb-research-field">
              <span>状态变更原因</span>
              <input
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
                placeholder="说明继续研究、送审或归档的依据"
              />
            </label>
            <div className="qb-research-actions">
              {(["review", "archived", "research"] as const).map((status) => (
                <button
                  type="button"
                  className="qb-quant-btn"
                  key={status}
                  disabled={
                    busy ||
                    !reason.trim() ||
                    (status === "review" && (!active || !detail.checklist[1]?.passed))
                  }
                  onClick={() =>
                    void act({
                      action: "state",
                      status,
                      reason,
                      expectedRevision: detail.revision,
                      ...(status === "review" ? { referenceAttemptId: active } : {}),
                    })
                  }
                >
                  {status === "review"
                    ? "提交待验证"
                    : status === "archived"
                      ? "归档版本"
                      : "恢复研究"}
                </button>
              ))}
            </div>
          </div>
          <details>
            <summary>版本差异与可比性</summary>
            <div className="qb-research-actions">
              <select
                aria-label="对照策略版本"
                value={other}
                onChange={(e) => {
                  setOther(e.target.value);
                  setComparison(null);
                }}
              >
                <option value="">选择另一版本</option>
                {versions
                  .filter((v) => v.id !== version.id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.recipe.factor.name} · {v.id.slice(-8)}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="qb-quant-btn"
                disabled={busy || !other}
                onClick={() => void act({ action: "compare", otherVersionId: other })}
              >
                比较版本
              </button>
            </div>
            {comparison ? (
              <>
                <p className="qb-research-note">{comparison.reason}</p>
                <dl className="qb-research-diff">
                  {comparison.diffs.map((d) => (
                    <div key={d.field}>
                      <dt>{d.field}</dt>
                      <dd>
                        {JSON.stringify(d.left)} → {JSON.stringify(d.right)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {comparison.performance ? (
                  <p>
                    同条件净收益：本版{" "}
                    {comparison.performance.left
                      ? `${(100 * comparison.performance.left.metrics.totalReturn).toFixed(2)}%`
                      : "无结果"}{" "}
                    / 对照{" "}
                    {comparison.performance.right
                      ? `${(100 * comparison.performance.right.metrics.totalReturn).toFixed(2)}%`
                      : "无结果"}
                  </p>
                ) : null}
              </>
            ) : null}
          </details>
          <section className="qb-research-section" aria-label="策略独立验证">
            <h3>策略独立验证</h3>
            <p className="qb-research-muted">
              验证方法与门槛由独立服务的签名数据配置固定；先冻结计划，再提交。每次同时消耗总尝试与封存额度。不能手动设置“通过”，验证门通过也不是实盘许可。
            </p>
            <div className="qb-research-actions">
              <button
                type="button"
                className="qb-quant-btn"
                disabled={busy || disabled || !["review", "validated"].includes(detail.status)}
                onClick={() => void act({ action: "plan", expectedRevision: detail.revision })}
              >
                冻结验证计划
              </button>
              <button
                type="button"
                className="qb-quant-btn qb-quant-btn--primary"
                disabled={
                  busy || disabled || !plan || !["review", "validated"].includes(detail.status)
                }
                onClick={() =>
                  void act({
                    action: "validate",
                    planId: plan?.id,
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                提交策略封存验证
              </button>
            </div>
            {!plan ? (
              <p>尚无验证计划。需要先登记含封存数据集的研究协议，并在独立服务配置策略验证方法。</p>
            ) : (
              <details>
                <summary>查看冻结验证方案</summary>
                <pre>{JSON.stringify(plan.payloadJson, null, 2)}</pre>
              </details>
            )}
            {detail.receipts.map((r) => (
              <p className="qb-research-note" key={r.attemptId}>
                {statusNames[r.receipt.status]} ·{" "}
                {r.receipt.reasonCodes.map((code) => receiptReasons[code] ?? code).join("、")}
                <br />
                净收益{" "}
                {r.receipt.metrics.totalReturn === null
                  ? "—"
                  : `${(100 * (r.receipt.metrics.totalReturn ?? 0)).toFixed(2)}%`}{" "}
                · 基准{" "}
                {r.receipt.metrics.benchmarkReturn === null
                  ? "—"
                  : `${(100 * (r.receipt.metrics.benchmarkReturn ?? 0)).toFixed(2)}%`}
              </p>
            ))}
          </section>
          <section className="qb-research-section" aria-label="逐日模拟与核对">
            <h3>逐日模拟与核对</h3>
            <p className="qb-research-muted">
              按已冻结日线逐步推进，使用同一回测引擎。仅当前数据前缀进入信号计算；持久记录进度，支持暂停、恢复和追加快照。属于研究模拟，不发送真实订单。
            </p>
            <button
              type="button"
              className="qb-quant-btn"
              disabled={busy || disabled || !active || detail.status === "archived"}
              onClick={() =>
                void act({
                  action: "paper_create",
                  referenceAttemptId: active,
                  expectedRevision: detail.revision,
                })
              }
            >
              创建逐日模拟
            </button>
            <label className="qb-research-field">
              <span>追加快照 ID（可选，必须保留已处理历史）</span>
              <input
                value={snapshot}
                onChange={(e) => setSnapshot(e.target.value)}
                placeholder="不填写则沿用会话快照"
              />
            </label>
            {sessions.length === 0 ? (
              <p>暂无模拟会话。创建后可推进日线并与引用回测逐阶段核对。</p>
            ) : (
              sessions.map((s) => {
                const latest = s.attempts[0];
                const result = s.attempts.find((a) => a.status === "completed")?.resultJson as
                  | {
                      differences: Array<{
                        date: string;
                        status: string;
                        firstDifference: string | null;
                      }>;
                    }
                  | undefined;
                const changes = result?.differences.filter((d) => d.status !== "matched") ?? [];
                const running = s.attempts.some((a) => ["pending", "running"].includes(a.status));
                return (
                  <div key={s.id} className="qb-research-note">
                    <strong>
                      {s.status === "paused" ? "已暂停" : "运行就绪"} · {s.id.slice(0, 8)}
                    </strong>
                    <p>
                      {s.automatic ? "持续推进中 · " : ""}已处理至 {s.cursor ?? "尚未开始"} ·{" "}
                      {s.definition.validationAtCreation ? "创建时验证门通过" : "未完成独立验证"}
                    </p>
                    <div className="qb-research-actions">
                      <button
                        type="button"
                        className="qb-quant-btn"
                        disabled={
                          busy ||
                          disabled ||
                          running ||
                          s.status !== "running" ||
                          detail.status === "archived"
                        }
                        onClick={() =>
                          void act({
                            action: "paper_advance",
                            sessionId: s.id,
                            expectedCursor: s.cursor,
                            bars: 20,
                            idempotencyKey: crypto.randomUUID(),
                            ...(snapshot.trim() ? { snapshotId: snapshot.trim() } : {}),
                          })
                        }
                      >
                        推进 20 根日线
                      </button>
                      <button
                        type="button"
                        className="qb-quant-btn"
                        disabled={busy || running}
                        onClick={() =>
                          void act({
                            action: "paper_status",
                            sessionId: s.id,
                            status: s.status === "paused" ? "running" : "paused",
                            expectedRevision: detail.revision,
                          })
                        }
                      >
                        {s.status === "paused" ? "恢复模拟" : "暂停模拟"}
                      </button>
                      <button
                        type="button"
                        className="qb-quant-btn"
                        disabled={busy || disabled || running || detail.status === "archived"}
                        onClick={() =>
                          void act({
                            action: "paper_status",
                            sessionId: s.id,
                            status: "running",
                            automatic: !s.automatic,
                            expectedRevision: detail.revision,
                          })
                        }
                      >
                        {s.automatic ? "停止持续推进" : "持续推进"}
                      </button>
                    </div>
                    {s.reason ? <p>{s.reason}</p> : null}
                    {running ? <output>正在计算与核对…</output> : null}
                    {latest?.error ? <p role="alert">{latest.error}</p> : null}
                    {result ? (
                      <p>
                        {changes.length
                          ? `${changes.length} 个日期存在差异或缺少基准`
                          : `本批 ${result.differences.length} 根日线六阶段全部一致`}
                      </p>
                    ) : null}
                    {changes.slice(0, 10).map((d) => (
                      <p key={d.date}>
                        {d.date.slice(0, 10)} ·{" "}
                        {d.status === "no_reference"
                          ? "引用回测无此日期"
                          : `首次差异：${stageNames[d.firstDifference ?? ""] ?? d.firstDifference}`}
                      </p>
                    ))}
                  </div>
                );
              })
            )}
          </section>
          <details>
            <summary>状态与计划历史（{detail.events.length} 条）</summary>
            {detail.events.map((e) => (
              <p key={e.id}>
                {new Date(e.createdAt).toLocaleString()} · {e.kind} ·{" "}
                {String(e.payloadJson.reason ?? e.payloadJson.status ?? e.id.slice(0, 8))}
              </p>
            ))}
          </details>
        </>
      ) : null}
    </section>
  );
}
