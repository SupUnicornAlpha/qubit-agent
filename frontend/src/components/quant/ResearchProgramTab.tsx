import { type FormEvent, useEffect, useRef, useState } from "react";
import { type FactorRecord, listFactors } from "../../api/backend";
import {
  type ResearchAttempt,
  type ResearchAttemptKind,
  type ResearchEvaluatorInfo,
  type ResearchFactorAttemptKind,
  type ResearchProgramSnapshot,
  type ResearchProtocol,
  type ResearchProtocolSpec,
  cancelResearchAttempt,
  createResearchProtocol,
  getResearchEvaluator,
  getResearchProgram,
  setResearchProgramStatus,
  submitResearchAttempt,
} from "../../api/research-program";
import { useDefaultProject } from "./useDefaultProject";
import "../../theme/research-program.css";

const kindLabels: Record<ResearchAttemptKind, string> = {
  factor_compute: "开发数据 · 因子计算",
  factor_evaluate: "开发数据 · 因子评估",
  sealed_factor: "封存数据 · 正式评估",
  backtest: "策略回测",
};
const statusLabels = {
  pending: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "已超时",
  active: "进行中",
  paused: "已暂停",
};
const isActive = (attempt: ResearchAttempt) =>
  attempt.status === "pending" || attempt.status === "running";
const displayTime = (value: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "无";
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function ResearchProgramTab() {
  const { scopeProjectId, scopeAllProjects, projectNameById, loading, error } = useDefaultProject();
  if (loading) return <output className="qb-research">正在读取项目…</output>;
  if (error)
    return (
      <div className="qb-research">
        <p role="alert" className="qb-research-alert">
          {error}
        </p>
      </div>
    );
  if (scopeAllProjects || !scopeProjectId)
    return (
      <div className="qb-research">
        <div className="qb-research-empty">
          <h2>先选择一个研究项目</h2>
          <p className="qb-research-muted">在上方“数据范围”选择具体项目，再登记协议和提交实验。</p>
          <p className="qb-research-muted">
            预算和尝试记录绑定项目，跨会话保留；“全部项目”不会自动写入默认项目。
          </p>
        </div>
      </div>
    );
  // A scope change unmounts this workspace, aborting reads and discarding pending UI state.
  return (
    <ResearchProgramWorkspace
      key={scopeProjectId}
      projectId={scopeProjectId}
      projectName={projectNameById[scopeProjectId] ?? scopeProjectId}
    />
  );
}

function ResearchProgramWorkspace({
  projectId,
  projectName,
}: { projectId: string; projectName: string }) {
  const [snapshot, setSnapshot] = useState<ResearchProgramSnapshot | null>(null);
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [evaluator, setEvaluator] = useState<ResearchEvaluatorInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [factorError, setFactorError] = useState<string | null>(null);
  const [evaluatorError, setEvaluatorError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [factorId, setFactorId] = useState("");
  const [kind, setKind] = useState<ResearchFactorAttemptKind>("factor_compute");
  const [visibleAttempts, setVisibleAttempts] = useState(30);
  const mutation = useRef<AbortController | null>(null);
  const attemptKeys = useRef(new Map<string, string>());

  useEffect(() => () => mutation.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly restarts polling after user mutations and retries.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeAttempts = false;
    const load = async () => {
      try {
        const data = await getResearchProgram(projectId, controller.signal);
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setLoadError(null);
        activeAttempts = data.attempts.some(isActive);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (activeAttempts) timer = setTimeout(() => void load(), 2_000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh explicitly reloads external factor and evaluator metadata.
  useEffect(() => {
    const controller = new AbortController();
    void listFactors({ projectId })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setFactors(
            rows.filter((row) => row.projectId === projectId && row.status !== "archived")
          );
          setFactorError(null);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFactorError(errorMessage(error));
      });
    void getResearchEvaluator(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setEvaluator(data);
          setEvaluatorError(null);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setEvaluatorError(errorMessage(error));
      });
    return () => controller.abort();
  }, [projectId, refresh]);

  const program = snapshot?.program;
  const protocol = snapshot?.protocols.find((item) => item.id === program?.activeProtocolId);
  const attempts = [...(snapshot?.attempts ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
  const factorById = new Map(factors.map((factor) => [factor.id, factor]));
  const selectedSealed = evaluator?.datasets.find(
    (dataset) => dataset.id === protocol?.spec.evaluation.sealedDatasetId
  );
  const sealedReason = evaluatorError
    ? `评估服务状态读取失败：${evaluatorError}`
    : !evaluator
      ? "正在读取封存评估服务状态。"
      : !evaluator.configured
        ? evaluator.reason === "sealed_evaluator_unavailable"
          ? "封存评估服务暂时不可用，请检查连接后重试。"
          : "封存评估服务未配置，请由管理员连接独立评估服务后再提交正式评估。"
        : !protocol?.spec.evaluation.sealedDatasetId
          ? "当前协议未指定封存数据集；修订协议后才能提交正式评估。"
          : !selectedSealed
            ? "协议指定的封存数据集当前不可用，请检查评估服务配置。"
            : selectedSealed.datasetFingerprint !==
                protocol.spec.evaluation.sealedDatasetFingerprint
              ? "封存数据版本已变化，请修订研究协议后再提交正式评估。"
              : null;
  const attemptBudgetExhausted = Boolean(program && program.usedAttempts >= program.maxAttempts);
  const evaluationBudgetExhausted = Boolean(
    program && kind === "sealed_factor" && program.usedEvaluations >= program.maxEvaluations
  );
  const runDisabled =
    busy ||
    Boolean(loadError) ||
    Boolean(factorError) ||
    !protocol ||
    program?.status !== "active" ||
    !factorId ||
    !factorById.has(factorId) ||
    attemptBudgetExhausted ||
    evaluationBudgetExhausted ||
    (kind === "sealed_factor" && Boolean(sealedReason));

  const runAction = async (
    request: (signal: AbortSignal) => Promise<unknown>,
    success: string,
    after?: () => void
  ) => {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await request(controller.signal);
      if (controller.signal.aborted) return;
      setNotice(success);
      after?.();
      setRefresh((value) => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        mutation.current = null;
      }
    }
  };

  const submitAttempt = () => {
    if (runDisabled || !protocol) return;
    const key = `${protocol.id}:${factorId}:${kind}`;
    const idempotencyKey = attemptKeys.current.get(key) ?? crypto.randomUUID();
    attemptKeys.current.set(key, idempotencyKey);
    void runAction(
      (signal) => submitResearchAttempt(projectId, { factorId, kind, idempotencyKey }, signal),
      "尝试已登记。运行结果会自动更新，完成不等于通过验证。",
      () => attemptKeys.current.delete(key)
    );
  };

  return (
    <div className="qb-research" aria-busy={busy}>
      <header className="qb-research-header">
        <div>
          <h2>研究管理</h2>
          <p className="qb-research-muted">{projectName} · 协议、预算与全部实验记录</p>
        </div>
        <div className="qb-research-actions">
          {program ? (
            <span className="qb-research-status" data-status={program.status}>
              {statusLabels[program.status]}
            </span>
          ) : null}
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--ghost"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            刷新
          </button>
          {program ? (
            <button
              type="button"
              className="qb-quant-btn qb-quant-btn--ghost"
              disabled={busy || Boolean(loadError)}
              onClick={() =>
                void runAction(
                  () =>
                    setResearchProgramStatus(
                      projectId,
                      program.status === "active" ? "paused" : "active"
                    ),
                  program.status === "active"
                    ? "项目已暂停接收新尝试；已登记尝试仍保留。"
                    : "项目已恢复接收尝试。"
                )
              }
            >
              {program.status === "active" ? "暂停项目" : "恢复项目"}
            </button>
          ) : null}
        </div>
      </header>
      {loadError ? (
        <p className="qb-research-note qb-research-alert" role="alert">
          研究记录读取失败：{loadError}。请刷新重试。
        </p>
      ) : null}
      {actionError ? (
        <p className="qb-research-note qb-research-alert" role="alert">
          {actionError}
          <br />
          若提交结果不确定，再次提交同一候选会复用请求标识，请先核查下方记录。
        </p>
      ) : null}
      {notice ? <output className="qb-research-note">{notice}</output> : null}
      {loading && !snapshot ? <output>正在读取协议与实验台账…</output> : null}
      {snapshot ? (
        <>
          {program ? (
            <>
              <div className="qb-research-budget" aria-label="项目累计预算">
                <Budget
                  label="尝试额度"
                  used={program.usedAttempts}
                  maximum={program.maxAttempts}
                />
                <Budget
                  label="正式评估额度"
                  used={program.usedEvaluations}
                  maximum={program.maxEvaluations}
                />
                <div>
                  <span>活动协议</span>
                  <strong>{protocol ? `v${protocol.version}` : "待同步"}</strong>
                  <small>跨会话共享累计用量</small>
                </div>
              </div>
              <p className="qb-research-muted">
                失败、取消和超时均保留记录。修订协议和更换候选不会重置预算。
              </p>
            </>
          ) : (
            <p className="qb-research-note">
              登记首版研究协议后再提交实验。首次设置的项目预算会跨协议版本持续累计。
            </p>
          )}

          <section className="qb-research-section" aria-label="研究协议">
            <div className="qb-research-section-title">
              <h3>{program ? "当前研究协议" : "登记研究协议"}</h3>
              {program && !editing ? (
                <button
                  type="button"
                  className="qb-quant-btn qb-quant-btn--ghost"
                  disabled={busy || Boolean(loadError) || !protocol}
                  onClick={() => setEditing(true)}
                >
                  修订协议
                </button>
              ) : null}
            </div>
            {editing || !program ? (
              <ProtocolEditor
                key={protocol?.id ?? "new"}
                protocol={protocol}
                budget={
                  program
                    ? { maxAttempts: program.maxAttempts, maxEvaluations: program.maxEvaluations }
                    : undefined
                }
                evaluator={evaluator}
                busy={busy || Boolean(loadError)}
                onCancel={program ? () => setEditing(false) : undefined}
                onSave={(spec) =>
                  void runAction(
                    (signal) => createResearchProtocol(projectId, spec, signal),
                    "研究协议已登记；历史协议与累计预算保持可追溯。",
                    () => setEditing(false)
                  )
                }
              />
            ) : protocol ? (
              <ProtocolSummary protocol={protocol} />
            ) : (
              <p className="qb-research-alert" role="alert">
                找不到活动协议，请刷新后重试。
              </p>
            )}
          </section>

          {program ? (
            <section className="qb-research-section" aria-label="提交研究尝试">
              <h3>提交研究尝试</h3>
              <div className="qb-research-run">
                <label className="qb-research-field">
                  <span>已注册因子</span>
                  <select
                    value={factorId}
                    disabled={busy || !factors.length}
                    onChange={(event) => setFactorId(event.target.value)}
                  >
                    <option value="">选择当前项目的因子</option>
                    {factors.map((factor) => (
                      <option key={factor.id} value={factor.id}>
                        {factor.name} · {factor.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="qb-research-field">
                  <span>执行阶段</span>
                  <select
                    value={kind}
                    disabled={busy}
                    onChange={(event) => setKind(event.target.value as ResearchFactorAttemptKind)}
                  >
                    {Object.entries(kindLabels)
                      .filter(([value]) => value !== "backtest")
                      .map(([value, label]) => (
                        <option
                          key={value}
                          value={value}
                          disabled={value === "sealed_factor" && Boolean(sealedReason)}
                        >
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="qb-quant-btn qb-quant-btn--primary"
                  disabled={runDisabled}
                  onClick={submitAttempt}
                >
                  {busy ? "正在提交…" : "登记并执行"}
                </button>
              </div>
              {factorId && factorById.has(factorId) ? (
                <code>{factorById.get(factorId)?.expr}</code>
              ) : null}
              {factorError ? (
                <p role="alert" className="qb-research-alert">
                  因子列表读取失败：{factorError}
                </p>
              ) : !factors.length ? (
                <p className="qb-research-muted">
                  当前项目没有可用因子。请先在“因子工坊”注册候选，再回到此页刷新。
                </p>
              ) : null}
              {program.status === "paused" ? (
                <p className="qb-research-note">项目已暂停，恢复后才能提交新尝试。</p>
              ) : null}
              {attemptBudgetExhausted || evaluationBudgetExhausted ? (
                <p className="qb-research-note">
                  项目累计预算已用尽，不能通过修订协议或更换候选重新获取额度。
                </p>
              ) : null}
              <p className="qb-research-muted">
                开发计算和开发评估仅消耗总尝试额度。封存数据正式评估还会消耗正式评估额度。开发数据评估不构成独立验证。
              </p>
              <p className="qb-research-note">
                {sealedReason
                  ? `正式评估不可用：${sealedReason}`
                  : `封存评估已配置：${selectedSealed?.label} · ${selectedSealed?.startDate} — ${selectedSealed?.endDate}。仅提交候选，不开放封存原始数据。`}
              </p>
            </section>
          ) : null}

          <section className="qb-research-section" aria-label="实验台账">
            <div className="qb-research-section-title">
              <h3>
                实验台账 <span className="qb-research-muted">{attempts.length} 次</span>
              </h3>
              {attempts.some(isActive) ? (
                <output className="qb-research-muted">有活动尝试 · 每 2 秒更新</output>
              ) : null}
            </div>
            {!attempts.length ? (
              <p className="qb-research-muted">
                暂无尝试。提交后，成功、失败、取消和超时都会保留在这里。
              </p>
            ) : (
              <div className="qb-research-table-wrap">
                <table className="qb-research-table">
                  <thead>
                    <tr>
                      <th scope="col">登记时间</th>
                      <th scope="col">候选 / 协议</th>
                      <th scope="col">阶段</th>
                      <th scope="col">状态</th>
                      <th scope="col">记录</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attempts.slice(0, visibleAttempts).map((attempt) => {
                      const attemptProtocol = snapshot.protocols.find(
                        (item) => item.id === attempt.protocolId
                      );
                      return (
                        <tr key={attempt.id}>
                          <td data-label="登记时间">{displayTime(attempt.createdAt)}</td>
                          <td data-label="候选" className="qb-research-candidate">
                            {factorById.get(attempt.candidateId)?.name ?? attempt.candidateId}
                            <small>
                              {attemptProtocol
                                ? `协议 v${attemptProtocol.version}`
                                : attempt.protocolId}
                            </small>
                          </td>
                          <td data-label="阶段">{kindLabels[attempt.kind] ?? attempt.kind}</td>
                          <td data-label="状态">
                            <span className="qb-research-status" data-status={attempt.status}>
                              {statusLabels[attempt.status] ?? attempt.status}
                            </span>
                            {isActive(attempt) ? (
                              <button
                                type="button"
                                className="qb-quant-btn qb-quant-btn--ghost"
                                disabled={busy}
                                onClick={() =>
                                  void runAction(
                                    (signal) =>
                                      cancelResearchAttempt(projectId, attempt.id, signal),
                                    "已请求取消；以台账返回的最终状态为准。"
                                  )
                                }
                              >
                                取消
                              </button>
                            ) : null}
                          </td>
                          <td data-label="记录">
                            <details>
                              <summary>查看请求与结果</summary>
                              {attempt.error ? (
                                <p className="qb-research-alert">{attempt.error}</p>
                              ) : null}
                              <pre>
                                {pretty({
                                  attemptId: attempt.id,
                                  startedAt: attempt.startedAt,
                                  endedAt: attempt.endedAt,
                                  candidate: attempt.candidateJson,
                                  request: attempt.requestJson,
                                  result: attempt.resultJson,
                                })}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {attempts.length > visibleAttempts ? (
              <div>
                <button
                  type="button"
                  className="qb-quant-btn qb-quant-btn--ghost"
                  onClick={() => setVisibleAttempts((value) => value + 30)}
                >
                  显示更多记录（还有 {attempts.length - visibleAttempts} 次）
                </button>
              </div>
            ) : null}
          </section>

          {snapshot.protocols.length ? (
            <section className="qb-research-section" aria-label="协议历史">
              <h3>
                协议版本 <span className="qb-research-muted">{snapshot.protocols.length} 版</span>
              </h3>
              <div className="qb-research-history">
                {[...snapshot.protocols]
                  .sort((a, b) => b.version - a.version)
                  .map((item) => (
                    <details key={item.id}>
                      <summary>
                        <strong>
                          v{item.version}
                          {item.id === program?.activeProtocolId ? " · 当前" : ""}
                        </strong>
                        <span>{displayTime(item.createdAt)}</span>
                        <code>{item.fingerprint}</code>
                      </summary>
                      <pre>{pretty(item.spec)}</pre>
                    </details>
                  ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Budget({ label, used, maximum }: { label: string; used: number; maximum: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>
        {used} <small>/ {maximum}</small>
      </strong>
      <small>{Math.max(0, maximum - used)} 次剩余 · 项目累计</small>
    </div>
  );
}

function ProtocolSummary({ protocol }: { protocol: ResearchProtocol }) {
  const { spec } = protocol;
  return (
    <dl className="qb-research-definition">
      <dt>研究假设</dt>
      <dd>{spec.hypothesis}</dd>
      <dt>比较基准</dt>
      <dd>{spec.benchmark}</dd>
      <dt>停止条件</dt>
      <dd>{spec.stoppingRule}</dd>
      <dt>开发数据</dt>
      <dd>
        <code>{spec.development.datasetSnapshotId}</code>
        <br />
        {spec.development.startDate} — {spec.development.endDate} ·{" "}
        {spec.development.symbols.join("、")}
      </dd>
      <dt>评估方案</dt>
      <dd>
        Rank IC · {spec.evaluation.horizonDays} 日收益 · {spec.evaluation.groupCount} 组
      </dd>
      <dt>封存数据</dt>
      <dd>{spec.evaluation.sealedDatasetId ?? "未指定"}</dd>
      <dt>协议指纹</dt>
      <dd>
        <code>{protocol.fingerprint}</code>
      </dd>
    </dl>
  );
}

function ProtocolEditor(props: {
  protocol?: ResearchProtocol;
  budget?: ResearchProtocolSpec["budget"];
  evaluator: ResearchEvaluatorInfo | null;
  busy: boolean;
  onSave: (spec: ResearchProtocolSpec) => void;
  onCancel?: () => void;
}) {
  const source = props.protocol?.spec;
  const [hypothesis, setHypothesis] = useState(source?.hypothesis ?? "");
  const [benchmark, setBenchmark] = useState(source?.benchmark ?? "");
  const [stoppingRule, setStoppingRule] = useState(source?.stoppingRule ?? "");
  const [snapshotId, setSnapshotId] = useState(source?.development.datasetSnapshotId ?? "");
  const [symbols, setSymbols] = useState(source?.development.symbols.join(", ") ?? "");
  const [startDate, setStartDate] = useState(source?.development.startDate ?? "");
  const [endDate, setEndDate] = useState(source?.development.endDate ?? "");
  const [horizon, setHorizon] = useState(source?.evaluation.horizonDays ?? 5);
  const [groupCount, setGroupCount] = useState(source?.evaluation.groupCount ?? 5);
  const [sealedId, setSealedId] = useState(source?.evaluation.sealedDatasetId ?? "");
  const [maxAttempts, setMaxAttempts] = useState(props.budget?.maxAttempts ?? 100);
  const [maxEvaluations, setMaxEvaluations] = useState(props.budget?.maxEvaluations ?? 20);
  const selectedDataset = props.evaluator?.datasets.find((item) => item.id === sealedId);
  const evaluationHorizon = selectedDataset?.horizonDays ?? horizon;
  const evaluationGroups = selectedDataset?.groupCount ?? groupCount;
  const [error, setError] = useState<string | null>(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (props.busy) return;
    const parsedSymbols = [
      ...new Set(
        symbols
          .split(/[\s,，;；]+/)
          .filter(Boolean)
          .map((symbol) => symbol.toUpperCase())
      ),
    ];
    if (
      !hypothesis.trim() ||
      !benchmark.trim() ||
      !stoppingRule.trim() ||
      !snapshotId.trim() ||
      !parsedSymbols.length
    ) {
      setError("请填写假设、基准、停止条件、快照 ID 和标的。");
      return;
    }
    if (parsedSymbols.length < 3) {
      setError("Rank IC 研究协议至少需要 3 个不同标的。");
      return;
    }
    if (!/^mkt_snapshot_[a-f0-9]{24}$/.test(snapshotId.trim())) {
      setError("请粘贴有效的已冻结日线快照 ID。");
      return;
    }
    if (!startDate || !endDate || startDate > endDate) {
      setError("请填写有效且按先后排列的研究区间。");
      return;
    }
    if (
      ![evaluationHorizon, evaluationGroups, maxAttempts].every(
        (value) => Number.isInteger(value) && value > 0
      ) ||
      evaluationGroups < 2 ||
      evaluationGroups > 100 ||
      evaluationHorizon > 252 ||
      maxAttempts > 100_000 ||
      !Number.isInteger(maxEvaluations) ||
      maxEvaluations < 0 ||
      maxEvaluations > maxAttempts
    ) {
      setError(
        "收益天数和总尝试预算须为正整数，分组数至少为 2；正式评估预算可为 0，且不能超过总尝试预算。"
      );
      return;
    }
    setError(null);
    props.onSave({
      hypothesis: hypothesis.trim(),
      benchmark: benchmark.trim(),
      stoppingRule: stoppingRule.trim(),
      development: {
        datasetSnapshotId: snapshotId.trim(),
        symbols: parsedSymbols,
        startDate,
        endDate,
      },
      evaluation: {
        method: "factor_rank_ic_v1",
        horizonDays: evaluationHorizon,
        groupCount: evaluationGroups,
        ...(sealedId ? { sealedDatasetId: sealedId } : {}),
      },
      budget: props.budget ?? { maxAttempts, maxEvaluations },
    });
  };
  return (
    <form className="qb-research-form" onSubmit={save}>
      <label className="qb-research-field qb-research-wide">
        <span>研究假设</span>
        <textarea
          required
          disabled={props.busy}
          value={hypothesis}
          placeholder="说明预期关系、经济机制及适用条件"
          onChange={(event) => setHypothesis(event.target.value)}
        />
      </label>
      <label className="qb-research-field">
        <span>比较基准</span>
        <input
          required
          disabled={props.busy}
          value={benchmark}
          placeholder="预先约定的基准或对照因子"
          onChange={(event) => setBenchmark(event.target.value)}
        />
      </label>
      <label className="qb-research-field">
        <span>停止条件</span>
        <input
          required
          disabled={props.busy}
          value={stoppingRule}
          placeholder="哪些条件触发停止、否定或重新研究"
          onChange={(event) => setStoppingRule(event.target.value)}
        />
      </label>
      <label className="qb-research-field">
        <span>开发数据快照 ID</span>
        <input
          required
          disabled={props.busy}
          value={snapshotId}
          placeholder="粘贴已冻结的 mkt_snapshot_…"
          onChange={(event) => setSnapshotId(event.target.value)}
        />
        <small>
          使用已冻结日线快照，覆盖研究区间及收益标签、预热所需日期。整份开发快照均不能与任何封存数据集的日期区间重叠。
        </small>
      </label>
      <label className="qb-research-field">
        <span>研究标的</span>
        <input
          required
          disabled={props.busy}
          value={symbols}
          placeholder="输入标的代码，以逗号或空格分隔"
          onChange={(event) => setSymbols(event.target.value)}
        />
        <small>至少 3 个不同标的，用于截面 Rank IC 评估。</small>
      </label>
      <label className="qb-research-field">
        <span>开发开始日期</span>
        <input
          required
          type="date"
          disabled={props.busy}
          value={startDate}
          onChange={(event) => setStartDate(event.target.value)}
        />
      </label>
      <label className="qb-research-field">
        <span>开发结束日期</span>
        <input
          required
          type="date"
          min={startDate || undefined}
          disabled={props.busy}
          value={endDate}
          onChange={(event) => setEndDate(event.target.value)}
        />
      </label>
      <label className="qb-research-field">
        <span>收益周期（天）</span>
        <input
          required
          type="number"
          min={1}
          max={252}
          step={1}
          disabled={props.busy || Boolean(sealedId)}
          value={evaluationHorizon}
          onChange={(event) => setHorizon(Number(event.target.value))}
        />
      </label>
      <label className="qb-research-field">
        <span>因子分组数</span>
        <input
          required
          type="number"
          min={2}
          max={100}
          step={1}
          disabled={props.busy || Boolean(sealedId)}
          value={evaluationGroups}
          onChange={(event) => setGroupCount(Number(event.target.value))}
        />
      </label>
      <label className="qb-research-field qb-research-wide">
        <span>封存评估数据集</span>
        <select
          value={sealedId}
          disabled={props.busy || (!props.evaluator?.configured && !sealedId)}
          onChange={(event) => setSealedId(event.target.value)}
        >
          <option value="">暂不指定 · 仅使用开发数据</option>
          {sealedId && !props.evaluator?.datasets.some((item) => item.id === sealedId) ? (
            <option value={sealedId}>{sealedId}（当前不可用）</option>
          ) : null}
          {props.evaluator?.datasets.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label} · {item.startDate} — {item.endDate} · 上限 {item.maxEvaluations} 次
            </option>
          ))}
        </select>
        <small>
          {props.evaluator?.configured
            ? "选择封存数据集后，收益周期和分组数采用评估服务的固定方案，不能自行修改。原始封存数据不开放给研究端。"
            : "封存评估服务尚不可用，可以先登记开发研究协议。"}
        </small>
      </label>
      <label className="qb-research-field">
        <span>项目总尝试预算</span>
        <input
          required
          type="number"
          min={1}
          step={1}
          readOnly={Boolean(props.budget)}
          disabled={props.busy}
          value={maxAttempts}
          onChange={(event) => setMaxAttempts(Number(event.target.value))}
        />
      </label>
      <label className="qb-research-field">
        <span>项目正式评估预算</span>
        <input
          required
          type="number"
          min={0}
          step={1}
          readOnly={Boolean(props.budget)}
          disabled={props.busy}
          value={maxEvaluations}
          onChange={(event) => setMaxEvaluations(Number(event.target.value))}
        />
      </label>
      <p className="qb-research-muted qb-research-wide">
        {props.budget
          ? "预算在首版协议中确定，本次修订不能增加或重置额度。"
          : "预算首次登记后固定，后续协议版本共用累计额度。"}{" "}
        协议修订会保留旧版本和对应实验。
      </p>
      {error ? (
        <p className="qb-research-alert qb-research-wide" role="alert">
          {error}
        </p>
      ) : null}
      <div className="qb-research-actions qb-research-wide">
        <button type="submit" className="qb-quant-btn qb-quant-btn--primary" disabled={props.busy}>
          {props.busy ? "正在登记…" : props.protocol ? "登记新版本" : "登记首版协议"}
        </button>
        {props.onCancel ? (
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--ghost"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            取消修改
          </button>
        ) : null}
      </div>
    </form>
  );
}
