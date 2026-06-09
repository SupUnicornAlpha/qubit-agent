/**
 * ComposerTab — 因子+规则 → strategy_composition 编辑器
 *
 * 三栏：
 *   左：选 strategyVersion → 显示该 version 已有 compositions 列表
 *   中：当前编辑中的 composition（已选因子/规则、权重设置、再平衡频率、universe）
 *   右：因子/规则候选池（多选加入），底部 "提交并新建 composition"
 *
 * 工作流：
 *   1. 选 strategyVersion → reload compositions
 *   2. 中间面板：填 kind / 多选 factorIds / 多选 ruleIds / 权重 / freq
 *   3. 提交 → POST /api/v1/strategy-compositions → 刷新左侧
 *   4. 用户切到 BacktestStudio 即可看到这个新 composition 并发起回测
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  cloneStrategyComposition,
  createStrategyComposition,
  listFactors,
  listRules,
  listStrategyCompositions,
  listStrategyVersions,
  type FactorRecord,
  type RuleRecord,
  type StrategyCompositionRecord,
  type StrategyKind,
  type StrategyVersionFlatRecord,
  type WeightMethod,
} from "../../api/backend";
import { useDefaultProject } from "./useDefaultProject";
import { LineageBadge, LineageTrail } from "./LineageBadge";
import { useAppStore } from "../../store";

const KIND_OPTIONS: { id: StrategyKind; label: string; desc: string }[] = [
  { id: "factor_only", label: "Factor Only", desc: "仅因子分数选股" },
  { id: "factor_with_rule", label: "Factor + Rule", desc: "因子打分 + 规则过滤" },
  { id: "rule_only", label: "Rule Only", desc: "纯规则信号" },
  { id: "ensemble", label: "Ensemble", desc: "多策略集成" },
  { id: "ml_model", label: "ML Model", desc: "机器学习模型" },
];

const WEIGHT_OPTIONS: { id: WeightMethod; label: string }[] = [
  { id: "equal", label: "等权" },
  { id: "fixed", label: "自定义固定权重" },
  { id: "ic_weighted", label: "IC 加权" },
  { id: "ml_optimized", label: "ML 优化" },
];

const FREQ_OPTIONS = ["daily", "weekly", "monthly"] as const;

export const ComposerTab: FC = () => {
  const { projectId, loading: projectLoading, error: projectError } = useDefaultProject();

  const [versions, setVersions] = useState<StrategyVersionFlatRecord[]>([]);
  const [versionId, setVersionId] = useState<string>("");
  const [compositions, setCompositions] = useState<StrategyCompositionRecord[]>([]);
  const [factors, setFactors] = useState<FactorRecord[]>([]);
  const [rules, setRules] = useState<RuleRecord[]>([]);

  // editor state
  const [kind, setKind] = useState<StrategyKind>("factor_only");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedFactorIds, setSelectedFactorIds] = useState<Set<string>>(new Set());
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [weightMethod, setWeightMethod] = useState<WeightMethod>("equal");
  const [factorWeights, setFactorWeights] = useState<Record<string, number>>({});
  const [rebalanceFreq, setRebalanceFreq] = useState<string>("daily");
  const [universe, setUniverse] = useState("default");

  /** 选中已有 composition 进入「详情面板」（克隆 / 一键回测 / lineage chain） */
  const [selectedCompId, setSelectedCompId] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const setQuantHandoff = useAppStore((s) => s.setQuantHandoff);
  const setQuantTab = useAppStore((s) => s.setQuantTab);

  const selectedComp = useMemo(
    () => compositions.find((c) => c.id === selectedCompId) ?? null,
    [compositions, selectedCompId]
  );

  const reloadVersions = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const [vs, fs, rs] = await Promise.all([
        listStrategyVersions(projectId),
        listFactors({ projectId }),
        listRules({ projectId }),
      ]);
      setVersions(vs);
      setFactors(fs);
      setRules(rs);
      if (!versionId && vs.length > 0) setVersionId(vs[0]!.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [projectId, versionId]);

  useEffect(() => {
    void reloadVersions();
  }, [reloadVersions]);

  const reloadCompositions = useCallback(async () => {
    if (!versionId) {
      setCompositions([]);
      return;
    }
    try {
      const rows = await listStrategyCompositions(versionId);
      setCompositions(rows);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [versionId]);

  useEffect(() => {
    void reloadCompositions();
  }, [reloadCompositions]);

  const toggleFactor = useCallback((id: string) => {
    setSelectedFactorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleRule = useCallback((id: string) => {
    setSelectedRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedFactors = useMemo(
    () => factors.filter((f) => selectedFactorIds.has(f.id)),
    [factors, selectedFactorIds]
  );
  const selectedRules = useMemo(
    () => rules.filter((r) => selectedRuleIds.has(r.id)),
    [rules, selectedRuleIds]
  );

  const reset = useCallback(() => {
    setSelectedFactorIds(new Set());
    setSelectedRuleIds(new Set());
    setKind("factor_only");
    setName("");
    setDescription("");
    setWeightMethod("equal");
    setFactorWeights({});
    setRebalanceFreq("daily");
    setUniverse("default");
  }, []);

  /**
   * 克隆 — 复用 backend POST :id/clone：lineage 自动写 createdBy='clone' + parentCompositionId。
   * 克隆后切到该新 composition 详情，便于用户立刻继续编辑或回测。
   */
  const onClone = useCallback(
    async (c: StrategyCompositionRecord) => {
      setBusy(true);
      setError(null);
      try {
        const next = await cloneStrategyComposition(c.id, {
          name: c.name ? `${c.name} (copy)` : undefined,
        });
        setInfo(`已克隆 composition ${next.id.slice(0, 8)}…`);
        await reloadCompositions();
        setSelectedCompId(next.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [reloadCompositions]
  );

  /**
   * 一键回测 — 把 composition.id 写入 quantHandoff，并切到 BacktestStudio。
   * BacktestStudio 在挂载时会消费该 payload 自动填表。
   */
  const onRunBacktest = useCallback(
    (c: StrategyCompositionRecord) => {
      setQuantHandoff({
        kind: "composition",
        compositionId: c.id,
        note: c.name ? `Composition · ${c.name}` : `Composition ${c.id.slice(0, 8)}`,
      });
      setQuantTab("backtest");
    },
    [setQuantHandoff, setQuantTab]
  );

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!versionId) {
        setError("先选择 strategy version");
        return;
      }
      const factorIds = Array.from(selectedFactorIds);
      const ruleIds = Array.from(selectedRuleIds);
      if (kind === "factor_only" && factorIds.length === 0) {
        setError("factor_only 至少需要一个因子");
        return;
      }
      if (kind === "rule_only" && ruleIds.length === 0) {
        setError("rule_only 至少需要一条规则");
        return;
      }
      if (kind === "factor_with_rule" && (factorIds.length === 0 || ruleIds.length === 0)) {
        setError("factor_with_rule 需要至少一个因子和一条规则");
        return;
      }

      setBusy(true);
      setError(null);
      setInfo(null);
      try {
        const rec = await createStrategyComposition({
          strategyVersionId: versionId,
          kind,
          factorIds,
          ruleIds,
          weightMethod,
          ...(weightMethod === "fixed" ? { factorWeights } : {}),
          rebalanceFreq,
          universe,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        setInfo(`已创建 composition ${rec.id.slice(0, 8)}…（${rec.kind}）`);
        reset();
        await reloadCompositions();
        setSelectedCompId(rec.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [
      versionId,
      kind,
      name,
      description,
      selectedFactorIds,
      selectedRuleIds,
      weightMethod,
      factorWeights,
      rebalanceFreq,
      universe,
      reset,
      reloadCompositions,
    ]
  );

  if (projectLoading) {
    return <div style={styles.empty}>加载默认 project…</div>;
  }
  if (projectError) {
    return <div style={styles.errorPanel}>项目加载失败：{projectError}</div>;
  }
  if (!projectId) {
    return <div style={styles.empty}>未找到默认 project，请先初始化。</div>;
  }

  return (
    <div className="qb-quant-tab-root qb-quant-tab-root--composer" data-qb-quant-tab="composer" style={styles.root}>
      <aside className="qb-quant-col qb-quant-col--left" style={styles.colLeft}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>Strategy Version</strong>
        </div>
        <div className="qb-quant-panel-pad" style={styles.panelPad}>
          <select
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            style={styles.select}
          >
            {versions.length === 0 ? <option value="">暂无 strategy_version</option> : null}
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.strategyName} · {v.versionTag}
              </option>
            ))}
          </select>
        </div>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>已有 Composition</strong>
          <span className="qb-quant-muted" style={styles.muted}>{compositions.length}</span>
        </div>
        <div className="qb-quant-list" style={styles.list}>
          {compositions.length === 0 ? <div className="qb-quant-empty" style={styles.empty}>暂无</div> : null}
          {compositions.map((c) => {
            const isActive = c.id === selectedCompId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedCompId(c.id)}
                className={`qb-quant-comp-row${isActive ? " qb-quant-comp-row--active" : ""}`}
                style={{
                  ...styles.compRow,
                  textAlign: "left",
                  background: isActive ? "var(--qb-bg-elevated)" : "transparent",
                  color: "inherit",
                  cursor: "pointer",
                  width: "100%",
                  border: "none",
                  borderBottom: "1px solid var(--qb-border-subtle)",
                }}
              >
                <div className="qb-quant-comp-row-top" style={styles.compRowTop}>
                  <span className="qb-quant-comp-kind" style={styles.compKind}>
                    {c.name?.trim() || c.kind}
                  </span>
                  <LineageBadge createdBy={c.createdBy ?? "user"} size="small" />
                </div>
                <div className="qb-quant-muted" style={styles.muted}>
                  {c.factorIds.length} factors · {c.ruleIds.length} rules · {c.weightMethod} · {c.rebalanceFreq}
                </div>
                <div className="qb-quant-comp-row-meta" style={styles.compRowMeta}>
                  {new Date(c.createdAt).toLocaleString()}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="qb-quant-col qb-quant-col--mid" style={styles.colMid}>
        {selectedComp ? (
          <div className="qb-quant-comp-detail qb-quant-hero-card" style={styles.detailPanel}>
            <div style={styles.detailHeader}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: 14 }}>
                    {selectedComp.name?.trim() || `${selectedComp.kind}#${selectedComp.id.slice(0, 8)}`}
                  </strong>
                  <LineageBadge createdBy={selectedComp.createdBy ?? "user"} size="normal" />
                </div>
                <span style={styles.muted}>
                  {selectedComp.kind} · {selectedComp.weightMethod} · {selectedComp.rebalanceFreq} · universe={selectedComp.universe}
                </span>
                {selectedComp.description ? (
                  <span style={{ fontSize: 11 }}>{selectedComp.description}</span>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => onRunBacktest(selectedComp)}
                  className="qb-quant-btn qb-quant-btn--primary"
                  style={styles.btnPrimary}
                  title="跳到回测工坊，自动用该 composition 发起回测"
                >
                  一键回测
                </button>
                <button
                  type="button"
                  onClick={() => onClone(selectedComp)}
                  disabled={busy}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                  title="复制为新的草稿 composition（lineage 自动标 clone）"
                >
                  克隆
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedCompId(null)}
                  className="qb-quant-btn qb-quant-btn--ghost"
                  style={styles.btnGhost}
                >
                  关闭
                </button>
              </div>
            </div>
            <LineageTrail kind="composition" id={selectedComp.id} />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
              <span style={styles.muted}>因子 ({selectedComp.factorIds.length})</span>
              <div style={styles.chipList}>
                {selectedComp.factorIds.length === 0 ? (
                  <span style={styles.muted}>无</span>
                ) : (
                  selectedComp.factorIds.map((fid) => {
                    const f = factors.find((x) => x.id === fid);
                    return (
                      <span key={fid} style={styles.chip}>
                        {f?.name ?? fid.slice(0, 8)}
                        {f ? <LineageBadge createdBy={f.createdBy ?? "user"} size="small" /> : null}
                      </span>
                    );
                  })
                )}
              </div>
              <span style={styles.muted}>规则 ({selectedComp.ruleIds.length})</span>
              <div style={styles.chipList}>
                {selectedComp.ruleIds.length === 0 ? (
                  <span style={styles.muted}>无</span>
                ) : (
                  selectedComp.ruleIds.map((rid) => {
                    const r = rules.find((x) => x.id === rid);
                    return (
                      <span key={rid} style={styles.chip}>
                        {r?.name ?? rid.slice(0, 8)}
                        {r ? <LineageBadge createdBy={r.createdBy ?? "user"} size="small" /> : null}
                      </span>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="qb-quant-editor" style={styles.editor}>
          <div className="qb-quant-editor-header" style={styles.editorHeader}>
            <strong>新建 Composition</strong>
            <button
              type="button"
              onClick={reset}
              className="qb-quant-btn qb-quant-btn--ghost"
              style={styles.btnGhost}
            >
              清空
            </button>
          </div>
          <div style={styles.formRow}>
            <label style={{ ...styles.formLabel, flex: 2 }}>
              名称（可选）
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：momentum_v2 / 沪深300_动量轮动"
                style={styles.input}
              />
            </label>
          </div>
          <label style={styles.formLabel}>
            描述（可选）
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="主要因子组合 / 回测期望 / 与上游产物的关系"
              style={{ ...styles.input, fontFamily: "inherit", resize: "vertical" }}
            />
          </label>
          <label style={styles.formLabel}>
            Kind
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as StrategyKind)}
              style={styles.select}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.id} value={k.id} title={k.desc}>
                  {k.label} — {k.desc}
                </option>
              ))}
            </select>
          </label>
          <div style={styles.formRow}>
            <label style={styles.formLabel}>
              权重方法
              <select
                value={weightMethod}
                onChange={(e) => setWeightMethod(e.target.value as WeightMethod)}
                style={styles.select}
              >
                {WEIGHT_OPTIONS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.formLabel}>
              再平衡频率
              <select
                value={rebalanceFreq}
                onChange={(e) => setRebalanceFreq(e.target.value)}
                style={styles.select}
              >
                {FREQ_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.formLabel}>
              Universe
              <input
                type="text"
                value={universe}
                onChange={(e) => setUniverse(e.target.value)}
                style={styles.input}
              />
            </label>
          </div>

          <div className="qb-quant-bucket" data-qb-quant-bucket="factor" style={styles.bucket}>
            <div className="qb-quant-bucket-header" style={styles.bucketHeader}>
              <strong>已选因子（{selectedFactors.length}）</strong>
            </div>
            {selectedFactors.length === 0 ? (
              <div className="qb-quant-empty" style={styles.empty}>从右侧候选池勾选</div>
            ) : (
              <div className="qb-quant-chip-list" style={styles.chipList}>
                {selectedFactors.map((f) => (
                  <div key={f.id} className="qb-quant-chip" style={styles.chip}>
                    <span>{f.name}</span>
                    {weightMethod === "fixed" ? (
                      <input
                        type="number"
                        step="0.1"
                        value={factorWeights[f.id] ?? 1}
                        onChange={(e) =>
                          setFactorWeights((prev) => ({
                            ...prev,
                            [f.id]: Number.parseFloat(e.target.value) || 0,
                          }))
                        }
                        className="qb-quant-chip-input"
                        style={styles.chipInput}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => toggleFactor(f.id)}
                      className="qb-quant-chip-rm"
                      style={styles.chipRm}
                      aria-label="移除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="qb-quant-bucket" data-qb-quant-bucket="rule" style={styles.bucket}>
            <div className="qb-quant-bucket-header" style={styles.bucketHeader}>
              <strong>已选规则（{selectedRules.length}）</strong>
            </div>
            {selectedRules.length === 0 ? (
              <div className="qb-quant-empty" style={styles.empty}>从右侧候选池勾选</div>
            ) : (
              <div className="qb-quant-chip-list" style={styles.chipList}>
                {selectedRules.map((r) => (
                  <div key={r.id} className="qb-quant-chip" style={styles.chip}>
                    <span>
                      {r.name} <span className="qb-quant-muted" style={styles.muted}>· {r.appliesTo}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => toggleRule(r.id)}
                      className="qb-quant-chip-rm"
                      style={styles.chipRm}
                      aria-label="移除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={busy || !versionId}
            className="qb-quant-btn qb-quant-btn--primary qb-quant-btn--submit"
            style={{ ...styles.btnPrimary, alignSelf: "flex-start", padding: "8px 18px" }}
          >
            {busy ? "提交中…" : "提交并创建 Composition"}
          </button>
        </form>
      </section>

      <aside className="qb-quant-col qb-quant-col--right" style={styles.colRight}>
        <div className="qb-quant-col-header" style={styles.colHeader}>
          <strong>候选池</strong>
        </div>
        <details open className="qb-quant-pool-panel" style={styles.poolPanel}>
          <summary className="qb-quant-pool-summary" style={styles.poolSummary}>因子（{factors.length}）</summary>
          <div className="qb-quant-pool-list" style={styles.poolList}>
            {factors.length === 0 ? <div className="qb-quant-empty" style={styles.empty}>暂无</div> : null}
            {factors.map((f) => (
              <label key={f.id} className="qb-quant-pool-row" style={styles.poolRow}>
                <input
                  type="checkbox"
                  checked={selectedFactorIds.has(f.id)}
                  onChange={() => toggleFactor(f.id)}
                />
                <span className="qb-quant-pool-name" style={styles.poolName}>{f.name}</span>
                <LineageBadge createdBy={f.createdBy ?? "user"} size="small" />
                <span className="qb-quant-muted" style={styles.muted}>{f.category}</span>
              </label>
            ))}
          </div>
        </details>
        <details className="qb-quant-pool-panel" style={styles.poolPanel}>
          <summary className="qb-quant-pool-summary" style={styles.poolSummary}>规则（{rules.length}）</summary>
          <div className="qb-quant-pool-list" style={styles.poolList}>
            {rules.length === 0 ? <div className="qb-quant-empty" style={styles.empty}>暂无</div> : null}
            {rules.map((r) => (
              <label key={r.id} className="qb-quant-pool-row" style={styles.poolRow}>
                <input
                  type="checkbox"
                  checked={selectedRuleIds.has(r.id)}
                  onChange={() => toggleRule(r.id)}
                />
                <span className="qb-quant-pool-name" style={styles.poolName}>{r.name}</span>
                <LineageBadge createdBy={r.createdBy ?? "user"} size="small" />
                <span className="qb-quant-muted" style={styles.muted}>{r.appliesTo}</span>
              </label>
            ))}
          </div>
        </details>
      </aside>

      {error ? <div className="qb-quant-toast qb-quant-toast--err" style={styles.toastErr}>{error}</div> : null}
      {info ? <div className="qb-quant-toast qb-quant-toast--info" style={styles.toastInfo}>{info}</div> : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "grid",
    gridTemplateColumns: "minmax(240px, 300px) 1fr minmax(260px, 320px)",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
  },
  colLeft: {
    borderRight: "1px solid var(--qb-border-subtle)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  colMid: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "auto",
    position: "relative",
    padding: "12px 16px 20px",
  },
  colRight: {
    borderLeft: "1px solid var(--qb-border-subtle)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  colHeader: {
    flex: "0 0 auto",
    padding: "10px 12px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 12,
  },
  panelPad: { padding: "8px 12px" },
  list: { flex: 1, minHeight: 0, overflow: "auto" },
  compRow: {
    padding: "8px 12px",
    borderBottom: "1px solid var(--qb-border-subtle)",
    fontSize: 11,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  compRowTop: { display: "flex", justifyContent: "space-between" },
  compRowMeta: { fontSize: 10, color: "var(--qb-text-muted)" },
  compKind: { fontWeight: 600 },
  editor: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 10,
    padding: "14px 18px",
    background: "var(--qb-bg-elevated)",
    boxShadow: "0 1px 0 rgba(255,255,255,0.04) inset, 0 1px 6px rgba(0,0,0,0.18)",
  },
  editorHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  formRow: { display: "flex", gap: 8 },
  formLabel: {
    display: "flex",
    flexDirection: "column",
    fontSize: 11,
    color: "var(--qb-text-muted)",
    gap: 2,
    flex: 1,
  },
  input: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  select: {
    fontSize: 12,
    padding: "4px 6px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    color: "inherit",
  },
  bucket: {
    border: "1px dashed var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "8px 10px",
  },
  bucketHeader: { fontSize: 11, marginBottom: 6 },
  chipList: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 6px 2px 8px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 14,
    background: "var(--qb-bg-surface)",
    fontSize: 11,
  },
  chipInput: {
    width: 56,
    fontSize: 11,
    padding: "1px 4px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 3,
    background: "var(--qb-bg-elevated)",
    color: "inherit",
  },
  chipRm: {
    background: "transparent",
    border: "none",
    color: "var(--qb-text-muted)",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 4px",
  },
  poolPanel: {
    borderBottom: "1px solid var(--qb-border-subtle)",
    padding: "6px 0",
  },
  poolSummary: {
    cursor: "pointer",
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    userSelect: "none",
  },
  poolList: { maxHeight: 320, overflow: "auto", padding: "4px 12px 8px" },
  poolRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 0",
    fontSize: 11,
    cursor: "pointer",
  },
  poolName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  detailPanel: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginBottom: 12,
  },
  detailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    flexWrap: "wrap",
  },
  btnPrimary: {
    padding: "6px 12px",
    fontSize: 12,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "var(--qb-bg-surface)",
    cursor: "pointer",
    color: "inherit",
    alignSelf: "flex-start",
  },
  btnGhost: {
    padding: "4px 10px",
    fontSize: 11,
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    background: "transparent",
    cursor: "pointer",
    color: "var(--qb-text-muted)",
  },
  muted: { color: "var(--qb-text-muted)", fontSize: 11 },
  empty: {
    padding: "12px 8px",
    color: "var(--qb-text-muted)",
    fontSize: 12,
    textAlign: "center",
  },
  errorPanel: {
    padding: "8px 12px",
    color: "#c54040",
    fontSize: 12,
    border: "1px solid #c54040",
    borderRadius: 6,
  },
  toastErr: {
    position: "absolute",
    bottom: 8,
    left: 16,
    right: 16,
    padding: "6px 10px",
    border: "1px solid #c54040",
    borderRadius: 4,
    color: "#c54040",
    fontSize: 11,
    background: "var(--qb-bg-surface)",
  },
  toastInfo: {
    position: "absolute",
    bottom: 8,
    left: 16,
    right: 16,
    padding: "6px 10px",
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 4,
    fontSize: 11,
    background: "var(--qb-bg-elevated)",
  },
};
