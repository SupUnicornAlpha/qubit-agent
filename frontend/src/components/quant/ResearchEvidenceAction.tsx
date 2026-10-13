import { useEffect, useRef, useState } from "react";
import { type ResearchEvidenceBundle, getResearchEvidence } from "../../api/research-program";

const labels = {
  requires_repair: "需要修复或复核",
  ready_for_review: "可交接复核",
  retain_for_research: "保留研究记录",
};
export function ResearchEvidenceAction({
  projectId,
  attemptId,
}: { projectId: string; attemptId: string }) {
  const [bundle, setBundle] = useState<ResearchEvidenceBundle | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function inspect() {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      const next = await getResearchEvidence(projectId, attemptId, abort.signal);
      if (!abort.signal.aborted) setBundle(next);
    } catch (e) {
      if (!abort.signal.aborted) {
        setBundle(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!abort.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    }
  }
  function download() {
    if (!bundle) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `qubit-evidence-${attemptId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="qb-evidence-action">
      <button
        type="button"
        className="qb-quant-btn qb-quant-btn--ghost"
        disabled={busy}
        onClick={() => void inspect()}
      >
        {busy ? "核对证据…" : "检查交接证据"}
      </button>
      {error ? (
        <p role="alert" className="qb-research-alert">
          {error}
        </p>
      ) : null}
      {bundle ? (
        <div className="qb-research-note">
          <strong>{labels[bundle.evidence.handoff.status]}</strong>
          <p>{bundle.evidence.handoff.nextStep}</p>
          <p>
            快照：
            {bundle.evidence.currentSources.snapshotStatus === "available"
              ? "可读取，内容校验通过"
              : "缺失或内容异常"}
            ；因子定义变化/缺失{" "}
            {bundle.evidence.currentSources.factors.filter((f) => f.status !== "unchanged").length}{" "}
            项。
          </p>
          <p>
            截至导出：{bundle.evidence.searchHistory.usedAttempts} 次尝试，
            {bundle.evidence.searchHistory.usedEvaluations}{" "}
            次封存评估。当前增量结论尚未建立独立验证，不具备交易资格。
          </p>
          <button
            type="button"
            className="qb-quant-btn qb-quant-btn--ghost"
            disabled={busy}
            onClick={download}
          >
            下载证据 JSON
          </button>
          <small>保留冻结输入和历史结果；不包含原始行情。校验和不等于来源签名。</small>
        </div>
      ) : null}
    </div>
  );
}
