import { useEffect, useRef, useState } from "react";
import {
  type ResearchAttempt,
  type ResearchStrategyExecution,
  type ResearchStrategyVersion,
  createResearchStrategy,
  getResearchStrategyArtifact,
  listResearchStrategies,
  runResearchStrategy,
} from "../../api/research-program";

const defaults: ResearchStrategyExecution = {
  capital: 100000,
  topN: 3,
  rebalance: "daily",
  commissionBps: 5,
  slippageBps: 5,
  minCommission: 1,
  maxVolumeParticipation: 0.05,
};
const fields = [
  { key: "capital", label: "初始资金（USD）", min: 1000, max: 1e9, step: 1000 },
  { key: "topN", label: "持有前 N 名", min: 1, max: 100, step: 1 },
  { key: "commissionBps", label: "每笔手续费（bps）", min: 0, max: 100, step: 0.1 },
  { key: "slippageBps", label: "每笔滑点（bps）", min: 0, max: 100, step: 0.1 },
  { key: "minCommission", label: "最低每笔手续费（USD）", min: 0, max: 1000, step: 0.1 },
  {
    key: "maxVolumeParticipation",
    label: "最大成交量参与率（0–1）",
    min: 0.001,
    max: 0.1,
    step: 0.001,
  },
] as const;
const pct = (n?: number) =>
  typeof n === "number" && Number.isFinite(n) ? `${(100 * n).toFixed(2)}%` : "—";
function sourceName(a: ResearchAttempt) {
  return (a.candidateJson as { name?: string })?.name ?? a.candidateId;
}
export function ResearchStrategyPanel({
  projectId,
  attempts,
  disabled,
  onSubmitted,
}: { projectId: string; attempts: ResearchAttempt[]; disabled: boolean; onSubmitted: () => void }) {
  const [versions, setVersions] = useState<ResearchStrategyVersion[]>([]);
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState("");
  const [execution, setExecution] = useState(defaults);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const control = useRef<AbortController | null>(null);
  const keys = useRef(new Map<string, string>());
  useEffect(() => () => control.current?.abort(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision reloads persisted versions after creation.
  useEffect(() => {
    const abort = new AbortController();
    void listResearchStrategies(projectId, abort.signal)
      .then((rows) => {
        if (!abort.signal.aborted) setVersions(rows);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [projectId, revision]);
  const sources = attempts.filter(
    (a) =>
      a.status === "completed" &&
      (a.requestJson as { operation?: string })?.operation === "incremental_compare" &&
      (a.resultJson as { verdict?: string })?.verdict === "worth_validation" &&
      (a.candidateJson as { universe?: string })?.universe === "US"
  );
  const version = versions.find((v) => v.id === selected) ?? versions[0];
  const runs = attempts.filter((a) => a.kind === "backtest" && a.candidateId === version?.id);
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (control.current) return;
    const abort = new AbortController();
    control.current = abort;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!abort.signal.aborted) {
        control.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className="qb-research-section" aria-label="策略构建与回测">
      <div className="qb-research-section-title">
        <h3>策略构建与回测</h3>
        <span className="qb-research-muted">冻结因子 → 执行条件 → 策略版本 → 回测</span>
      </div>
      <p className="qb-research-note">
        首版支持 US 日频股票、只做多 Top-N
        等权；收盘信号在下一根开盘撮合。与增量筛选的多空收益代理不同，必须重新检验。当前只用于开发研究，不自动晋级。
      </p>
      <form
        className="qb-research-strategy-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action(async (signal) => {
            const next = await createResearchStrategy(projectId, source, execution, signal);
            if (signal.aborted) return;
            setSelected(next.id);
            setRevision((v) => v + 1);
            setNotice("策略版本已冻结；相同内容复用版本，修改条件会产生新版本。");
          });
        }}
      >
        <label className="qb-research-field">
          <span>来源比较（已显示开发增量）</span>
          <select
            aria-label="策略来源比较"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy || disabled}
            required
          >
            <option value="">选择已完成的 US 因子比较</option>
            {sources.map((a) => (
              <option key={a.id} value={a.id}>
                {sourceName(a)} · {new Date(a.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        </label>
        <div className="qb-research-form">
          {fields.map((f) => (
            <label className="qb-research-field" key={f.key}>
              <span>{f.label}</span>
              <input
                type="number"
                required
                min={f.min}
                max={f.max}
                step={f.step}
                disabled={busy || disabled}
                value={execution[f.key]}
                onChange={(e) => setExecution((x) => ({ ...x, [f.key]: e.target.valueAsNumber }))}
              />
            </label>
          ))}
          <label className="qb-research-field">
            <span>调仓频率</span>
            <select
              disabled={busy || disabled}
              value={execution.rebalance}
              onChange={(e) =>
                setExecution((x) => ({
                  ...x,
                  rebalance: e.target.value as ResearchStrategyExecution["rebalance"],
                }))
              }
            >
              <option value="daily">每日</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          className="qb-quant-btn qb-quant-btn--primary"
          disabled={busy || disabled || !source}
        >
          冻结策略版本
        </button>
        {!sources.length ? (
          <p className="qb-research-muted">
            先完成 US 因子增量比较；失败、重复或证据不足的比较不能用于此入口。
          </p>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="qb-research-alert">
          {error}
        </p>
      ) : null}
      {notice ? <output className="qb-research-note">{notice}</output> : null}
      {version ? (
        <>
          <label className="qb-research-field">
            <span>已冻结的策略版本</span>
            <select
              aria-label="已冻结的策略版本"
              value={version.id}
              onChange={(e) => setSelected(e.target.value)}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.recipe.factor.name} · Top {v.recipe.execution.topN} · 滑点{" "}
                  {v.recipe.execution.slippageBps} bps · {v.id.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <p>
            {version.recipe.factor.expr} · {version.recipe.factor.direction === 1 ? "正向" : "反向"}{" "}
            · Top {version.recipe.execution.topN} ·{" "}
            {version.recipe.execution.capital.toLocaleString()} USD
          </p>
          <p className="qb-research-muted">
            执行只读取本版本的冻结表达式和快照。上方修改表单不会修改该版本。回测每次消耗 1
            次总尝试，封存额度不变；重新计算同样计入搜索历史。
          </p>
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--primary"
            disabled={busy || disabled}
            onClick={() =>
              void action(async (signal) => {
                const key = keys.current.get(version.id) ?? crypto.randomUUID();
                keys.current.set(version.id, key);
                await runResearchStrategy(projectId, version.id, key, signal);
                if (signal.aborted) return;
                keys.current.delete(version.id);
                onSubmitted();
                setNotice("回测已登记，结果和失败原因会保留在实验台账。");
              })
            }
          >
            {busy ? "正在登记…" : "按冻结版本提交回测"}
          </button>
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--ghost"
            disabled={busy}
            onClick={() =>
              void action(async (signal) => {
                const artifact = await getResearchStrategyArtifact(projectId, version.id, signal);
                if (signal.aborted) return;
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(artifact, null, 2)], { type: "application/json" })
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `${version.id}.json`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            下载策略与回测产物
          </button>
          <details>
            <summary>查看冻结定义与输入</summary>
            <pre>{JSON.stringify(version, null, 2)}</pre>
          </details>
          {runs.map((a) => {
            const job = a.resultJson as {
              id?: string;
              result?: {
                metrics?: { totalReturn: number; maxDrawdown: number; tradeCount: number };
                error?: string;
              };
            } | null;
            const m = job?.result?.metrics;
            return (
              <div className="qb-research-note" key={a.id}>
                <strong>
                  {a.status === "completed"
                    ? "回测完成"
                    : a.status === "failed"
                      ? "回测失败"
                      : a.status === "pending" || a.status === "running"
                        ? "回测进行中"
                        : "回测已停止"}
                </strong>{" "}
                · {new Date(a.createdAt).toLocaleString("zh-CN")}
                {m ? (
                  <p>
                    总收益 {pct(m.totalReturn)} · 最大回撤 {pct(m.maxDrawdown)} · 成交{" "}
                    {m.tradeCount} 笔
                  </p>
                ) : null}
                {a.error ? <p>{a.error}</p> : null}
                <small>尝试 {a.id} · 尚未独立验证</small>
              </div>
            );
          })}
          <p className="qb-research-muted">
            成本与成交量限制为研究假设，未验证实际券商执行、盘口和容量；末日持仓按引擎规则估值，不承诺全部变现。
          </p>
        </>
      ) : (
        <p className="qb-research-muted">暂无研究策略版本。先冻结执行条件，再提交计算。</p>
      )}
    </section>
  );
}
