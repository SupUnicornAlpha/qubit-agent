import { useEffect, useRef, useState } from "react";
import {
  type FactorDataIntegrityDto,
  checkFactorDataIntegrity,
  createMarketSnapshot,
} from "../../api/backend";

const statusText = {
  passed: "数据检查通过",
  research_only: "仅供研究 · 证据未齐",
  failed: "检查失败 · 已阻止计算",
};

export function FactorDataIntegrityResult({ report }: { report: FactorDataIntegrityDto }) {
  return (
    <div aria-live="polite" style={{ fontSize: 12, lineHeight: 1.7, overflowWrap: "anywhere" }}>
      <strong
        style={{
          color: report.status === "failed" ? "var(--qb-error, #e76767)" : "var(--qb-text-primary)",
        }}
      >
        {statusText[report.status]}
      </strong>
      <div>
        时点证据：{report.qualification.pointInTime === "verified" ? "已验证" : "未验证"} · 检查{" "}
        {report.pit.totalBarsAudited} 条行情
      </div>
      <div>
        截断一致性：
        {report.truncation
          ? {
              passed: "通过",
              failed: "检查失败",
              insufficient_data: "样本不足",
              unsupported: "暂不支持",
            }[report.truncation.status]
          : "此执行器暂未接入"}
        {report.truncation
          ? ` · 对比 ${report.truncation.comparedValues} 个信号，差异 ${report.truncation.mismatchCount} 个`
          : ""}
      </div>
      <details>
        <summary style={{ cursor: "pointer" }}>查看证据与适用范围</summary>
        <div>快照：{report.datasetSnapshotId}</div>
        <div>
          区间：{report.startDate} — {report.endDate} · 截至 {report.asOf}
        </div>
        <div>来源：{report.sourceIds.join("、")}</div>
        <div>表达式指纹：{report.expressionHash}</div>
        {report.truncation?.cutoffs.length ? (
          <div>截断日期：{report.truncation.cutoffs.join("、")}</div>
        ) : null}
        {[
          ...new Set([
            ...report.qualification.limitations,
            ...report.pit.violations.slice(0, 5).map((item) => `${item.symbol}: ${item.detail}`),
            ...(report.truncation?.issues.map((item) => item.message) ?? []),
            ...report.limitations,
          ]),
        ].map((item) => (
          <div key={item} style={{ color: "var(--qb-text-muted)" }}>
            {item}
          </div>
        ))}
      </details>
    </div>
  );
}

export function FactorDataContext(props: {
  factorId: string;
  symbols: string[];
  startDate: string;
  endDate: string;
  horizon: number;
  snapshotId: string;
  onSnapshotChange: (id: string) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const scope = `${props.factorId}:${props.snapshotId}:${props.startDate}:${props.endDate}:${props.symbols.join(",")}`;
  const [outcome, setOutcome] = useState<{
    scope: string;
    report?: FactorDataIntegrityDto;
    error?: string;
  } | null>(null);
  const report = outcome?.scope === scope ? outcome.report : null;
  const error = outcome?.scope === scope ? outcome.error : null;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = "";
    };
  }, [scope]);

  const freeze = async () => {
    props.onBusyChange(true);
    setOutcome(null);
    try {
      const start = Date.parse(`${props.startDate}T00:00:00Z`);
      const end = Date.parse(`${props.endDate}T00:00:00Z`);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start > end ||
        !props.symbols.length
      ) {
        throw new Error("请填写有效的日期区间和标的。");
      }
      // Include label look-forward data; factor computation is still bound to the requested end date.
      const extended = end + (Math.max(20, props.horizon) + 5) * 86_400_000;
      if (extended > Date.now())
        throw new Error("评估截止日后还需预留收益标签数据，请将截止日提前。");
      const snapshot = await createMarketSnapshot({
        symbols: props.symbols,
        timeframe: "1d",
        purpose: "research",
        asOf: `${new Date(extended).toISOString().slice(0, 10)}T23:59:59.999Z`,
        limit: Math.min(500, Math.ceil((extended - start) / 86_400_000) + 5),
      });
      if (currentScope.current === scope) props.onSnapshotChange(snapshot.snapshotId);
    } catch (err) {
      setOutcome({ scope, error: (err as Error).message });
    } finally {
      props.onBusyChange(false);
    }
  };

  const inspect = async () => {
    props.onBusyChange(true);
    setOutcome(null);
    try {
      const result = await checkFactorDataIntegrity(props.factorId, {
        datasetSnapshotId: props.snapshotId,
        symbols: props.symbols,
        startDate: props.startDate,
        endDate: props.endDate,
      });
      setOutcome({ scope, report: result });
    } catch (err) {
      setOutcome({ scope, error: (err as Error).message });
    } finally {
      props.onBusyChange(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
      <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
        研究数据快照（日线）
        <input
          aria-label="研究数据快照"
          value={props.snapshotId}
          disabled={props.busy}
          onChange={(event) => props.onSnapshotChange(event.target.value.trim())}
          placeholder="先冻结数据，或粘贴已有快照 ID"
          style={{
            width: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            padding: "7px 9px",
            color: "var(--qb-text-primary)",
            background: "var(--qb-surface-2)",
            border: "1px solid var(--qb-border)",
            borderRadius: 4,
          }}
        />
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          className="qb-quant-btn qb-quant-btn--ghost"
          disabled={props.busy || !props.symbols.length}
          onClick={() => void freeze()}
        >
          冻结所选数据
        </button>
        <button
          type="button"
          className="qb-quant-btn qb-quant-btn--ghost"
          disabled={props.busy || !props.snapshotId}
          onClick={() => void inspect()}
        >
          检查时点与前视依赖
        </button>
      </div>
      <div style={{ fontSize: 11, color: "var(--qb-text-muted)" }}>
        {props.snapshotId
          ? "计算、评估和数值预览均使用此快照。"
          : "未绑定快照的调用属于自由探索，不能用于验证。"}
        冻结最多 500 根日线，包含收益标签所需日期；冻结数据不等于证明时点正确。
      </div>
      {error ? (
        <div
          role="alert"
          style={{ fontSize: 12, color: "var(--qb-error, #e76767)", overflowWrap: "anywhere" }}
        >
          {error}
        </div>
      ) : null}
      {report ? <FactorDataIntegrityResult report={report} /> : null}
    </div>
  );
}
