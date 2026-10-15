import { useEffect, useRef, useState } from "react";
import type { ResearchEvaluatorInfo, ResearchProtocolSpec } from "../../api/research-program";
import {
  getResearchDataImports,
  importResearchData,
  type ResearchDataImport,
} from "../../api/research-program";

const importError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("research_development_overlaps_sealed_data"))
    return "该日期范围与封存数据重叠，请选择独立的开发区间。";
  if (message.includes("public_data_http_429"))
    return "公开数据源暂时限流；失败记录已保留，请稍后重试。";
  if (message.includes("sealed_evaluator_unavailable"))
    return "评估服务暂时不可用，无法检查封存区间，导入已停止。";
  if (message.includes("public_data_import_busy")) return "已有两个导入任务运行，请等待完成。";
  if (message.includes("import_interrupted")) return "导入进程中断；请重新提交，原记录会保留。";
  return message;
};
export function ResearchDataPanel({
  projectId,
  evaluator,
  onUse,
}: {
  projectId: string;
  evaluator: ResearchEvaluatorInfo | null;
  onUse: (data: ResearchProtocolSpec["development"]) => void;
}) {
  const [rows, setRows] = useState<ResearchDataImport[]>([]);
  const [symbols, setSymbols] = useState("XLB XLE XLF XLI XLK XLP XLU XLV XLY");
  const [start, setStart] = useState("2020-01-01");
  const [end, setEnd] = useState("2023-12-31");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const key = useRef<{ body: string; id: string } | null>(null);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revisions explicitly refresh import tasks.
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const jobs = await getResearchDataImports(projectId, abort.signal);
        if (abort.signal.aborted) return;
        setRows(jobs);
        setError("");
        setLoading(false);
        if (jobs.some((j) => j.status === "running")) timer = setTimeout(() => void load(), 2000);
      } catch (e) {
        if (!abort.signal.aborted) {
          setError(importError(e));
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [projectId, revision]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mutation.current) return;
    const abort = new AbortController();
    mutation.current = abort;
    setBusy(true);
    setError("");
    setNotice("");
    const input = {
      provider: "yahoo_chart" as const,
      symbols: symbols
        .toUpperCase()
        .split(/[\s,，]+/)
        .filter(Boolean),
      startDate: start,
      endDate: end,
    };
    const body = JSON.stringify(input);
    if (key.current?.body !== body) key.current = { body, id: crypto.randomUUID() };
    try {
      await importResearchData(
        projectId,
        { ...input, idempotencyKey: key.current.id },
        abort.signal
      );
      if (!abort.signal.aborted) {
        setRevision((v) => v + 1);
        key.current = null;
        setNotice("导入已登记，完成后可用于新协议。失败任务也会保留。");
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(importError(e));
    } finally {
      if (!abort.signal.aborted) setBusy(false);
      mutation.current = null;
    }
  }
  const ready = rows.filter((r) => r.status === "completed");
  return (
    <section className="qb-research-section" aria-label="数据接入与独立评估">
      <div className="qb-research-section-title">
        <h3>数据接入与独立评估</h3>
        <span className="qb-research-muted">{ready.length} 个开发快照 · US 日频</span>
      </div>
      <div className="qb-research-note">
        <strong>
          {evaluator?.configured
            ? "评估服务已连接"
            : evaluator
              ? "评估服务未就绪"
              : "正在检查评估服务…"}
        </strong>
        <p>
          {evaluator?.deployment === "local_process"
            ? "本机独立进程 · 认证接口与独立数据库；同一系统用户仍可访问文件，不构成主机级隔离。"
            : evaluator?.configured
              ? "由管理员部署；连接可用不代表隔离或数据证据已验证。"
              : "配置独立服务后，协议可绑定封存数据版本与评估额度。"}
        </p>
        {evaluator?.datasets.map((d) => (
          <p key={d.id}>
            {d.label} · {d.startDate} — {d.endDate} · 共享上限 {d.maxEvaluations} 次<br />
            <strong>
              {d.evidenceStatus === "attested"
                ? "含来源方时点声明，仍需执行验证"
                : "时点证据未验证，不能晋级为验证通过"}
            </strong>
          </p>
        ))}
      </div>
      {error ? (
        <p role="alert" className="qb-research-alert">
          {error}{" "}
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--ghost"
            onClick={() => setRevision((v) => v + 1)}
          >
            重试读取
          </button>
        </p>
      ) : null}
      {notice ? <output>{notice}</output> : null}
      {loading ? (
        <p>正在读取导入记录…</p>
      ) : rows.length === 0 ? (
        <p className="qb-research-muted">
          尚无真实数据快照。导入只覆盖开发区间；封存数据由评估服务单独保管。
        </p>
      ) : null}
      <div className="qb-research-history">
        {rows.map((row) => (
          <details key={row.id}>
            <summary>
              <strong>{row.request.symbols.join(" · ")}</strong>
              <span>
                {row.request.startDate} — {row.request.endDate}
              </span>
              <span>
                {row.status === "completed"
                  ? "已导入 · 仅研究"
                  : row.status === "running"
                    ? "下载与校验中"
                    : "导入失败"}
              </span>
            </summary>
            {row.error ? (
              <p role="alert" className="qb-research-alert">
                {row.error}
              </p>
            ) : null}
            {row.snapshotId ? (
              <>
                <code>{row.snapshotId}</code>
                <p>
                  <button
                    type="button"
                    className="qb-quant-btn qb-quant-btn--ghost"
                    onClick={() =>
                      onUse({
                        datasetSnapshotId: row.snapshotId ?? "",
                        symbols: row.request.symbols,
                        startDate: row.request.startDate,
                        endDate: row.request.endDate,
                      })
                    }
                  >
                    用于协议草稿
                  </button>
                </p>
              </>
            ) : null}
            <ul>
              {row.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="qb-research-muted">
              逐标的抓取证据（SHA-256 标识原始响应，不证明数据真实性）
            </p>
            {row.provenance.map((p) => (
              <div key={p.symbol} className="qb-research-data-source">
                <strong>
                  {p.symbol} · {p.rows} 根日线
                </strong>
                <span>{new Date(p.retrievedAt).toLocaleString("zh-CN")}</span>
                <a href={p.url} target="_blank" rel="noreferrer">
                  供应商请求
                </a>
                <code>{p.sha256}</code>
              </div>
            ))}
          </details>
        ))}
      </div>
      <button
        type="button"
        className="qb-quant-btn qb-quant-btn--ghost"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "收起导入" : "导入公开 US 日线"}
      </button>
      {expanded ? (
        <form onSubmit={(e) => void submit(e)} className="qb-research-form">
          <p className="qb-research-muted qb-research-wide">
            Yahoo 公开行情 · 最多 12 个标的、五年已结束历史。保留供应商
            OHLC，不混用复权收盘价；仅研究使用。与已登记封存区间重叠的请求会被拒绝。
          </p>
          <label className="qb-research-field qb-research-wide">
            <span>US 标的（空格分隔）</span>
            <input
              required
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              disabled={busy}
            />
          </label>
          <>
            <label className="qb-research-field">
              <span>开发开始日期</span>
              <input
                type="date"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="qb-research-field">
              <span>开发结束日期</span>
              <input
                type="date"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                disabled={busy}
              />
            </label>
          </>
          <button className="qb-quant-btn qb-quant-btn--primary" type="submit" disabled={busy}>
            {busy ? "正在登记…" : "登记并导入"}
          </button>
        </form>
      ) : null}
    </section>
  );
}
