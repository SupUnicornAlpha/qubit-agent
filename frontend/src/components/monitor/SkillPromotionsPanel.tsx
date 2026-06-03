/**
 * Self-Evolving Agent P5 — MemoryTab > Skill Promotions sub-tab。
 *
 * 设计：
 *   左列：跑批 summary 卡片 + 候选列表（按 promotion_score 倒序，state 切换）
 *   右列：选中候选详情 + 评分 ruleHits + approve/reject 按钮
 *
 * 所有写操作（approve/reject）都走后端 routes；本组件只 dispatch。
 * 列表 polling 跟随父 autoRefresh，每 12s 刷一次。
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveSkillPromotion,
  listSkillPromotionRuns,
  listSkillPromotions,
  rejectSkillPromotion,
  type SkillPromotionListItem,
  type SkillPromotionRunSummary,
  type SkillPromotionState,
} from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";

const btnGhost = {
  background: "var(--qb-main-input-bg, #18181b)",
  border: "1px solid var(--qb-main-input-border, #27272a)",
  color: "var(--qb-main-input-fg, #e4e4e7)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
} as const;

const STATE_OPTIONS: { id: SkillPromotionState | "all"; label: string }[] = [
  { id: "pending_review", label: "待审" },
  { id: "active", label: "已通过" },
  { id: "archived", label: "已驳回" },
  { id: "stale", label: "陈旧" },
  { id: "all", label: "全部" },
];

interface SkillPromotionsPanelProps {
  projectId: string;
  autoRefresh: boolean;
}

function fmtTs(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function parsePnlRollup(json: string): {
  pnlSum: number;
  winCount: number;
  loseCount: number;
  windowDays: number;
} | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (typeof o.pnlSum !== "number") return null;
    return {
      pnlSum: o.pnlSum,
      winCount: Number(o.winCount ?? 0),
      loseCount: Number(o.loseCount ?? 0),
      windowDays: Number(o.windowDays ?? 30),
    };
  } catch {
    return null;
  }
}

export const SkillPromotionsPanel: FC<SkillPromotionsPanelProps> = ({ projectId, autoRefresh }) => {
  const [stateFilter, setStateFilter] = useState<SkillPromotionState | "all">("pending_review");
  const [items, setItems] = useState<SkillPromotionListItem[]>([]);
  const [runs, setRuns] = useState<SkillPromotionRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const reload = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const [list, runHistory] = await Promise.all([
        listSkillPromotions({ projectId, state: stateFilter, limit: 100 }),
        listSkillPromotionRuns({ projectId, limit: 10 }),
      ]);
      setItems(list.items);
      setRuns(runHistory);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
      setItems([]);
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, stateFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!autoRefresh || !projectId) return;
    const t = window.setInterval(() => {
      void reload();
    }, 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, reload]);

  const selected = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  );

  const onApprove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await approveSkillPromotion(id);
        await reload();
      } catch (e) {
        alert(e instanceof Error ? e.message : "approve 失败");
      } finally {
        setBusyId(null);
      }
    },
    [reload]
  );

  const onReject = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await rejectSkillPromotion(id, { reason: rejectReason.trim() || undefined });
        setRejectReason("");
        await reload();
      } catch (e) {
        alert(e instanceof Error ? e.message : "reject 失败");
      } finally {
        setBusyId(null);
      }
    },
    [reload, rejectReason]
  );

  return (
    <div style={{ minWidth: 0 }}>
      <RunsBar runs={runs} onRefresh={() => void reload()} loading={loading} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
        {STATE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => {
              setStateFilter(o.id);
              setSelectedId(null);
            }}
            style={{
              ...btnGhost,
              borderColor: stateFilter === o.id ? "#3b82f6" : undefined,
              color: stateFilter === o.id ? "#3b82f6" : undefined,
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div style={styles.split}>
        <div style={styles.col}>
          {err && <div style={{ color: "#f87171", margin: "8px 0" }}>{err}</div>}
          {!loading && items.length === 0 && (
            <div style={{ color: "#a1a1aa", padding: 24, textAlign: "center" }}>
              当前 state 下无 promotion 候选。
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {items.map((it) => {
              const pnl = parsePnlRollup(it.pnlAttributionJson);
              return (
                <button
                  type="button"
                  key={it.id}
                  onClick={() => setSelectedId(it.id)}
                  style={{
                    ...btnGhost,
                    textAlign: "left",
                    padding: 10,
                    borderColor: selectedId === it.id ? "#3b82f6" : undefined,
                    background: selectedId === it.id ? "rgba(59,130,246,0.06)" : undefined,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <strong style={{ color: "#e4e4e7" }}>{it.name}</strong>
                    <span
                      style={{
                        color:
                          it.state === "pending_review"
                            ? "#f59e0b"
                            : it.state === "active"
                              ? "#22c55e"
                              : "#71717a",
                        fontSize: 12,
                      }}
                    >
                      {it.state}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#a1a1aa", marginTop: 4 }}>
                    {it.description || "—"}
                  </div>
                  <div style={{ fontSize: 11, color: "#71717a", marginTop: 4, display: "flex", gap: 12 }}>
                    <span>score: {it.promotionScore?.toFixed(3) ?? "—"}</span>
                    <span>recall: {it.useCount}</span>
                    <span>
                      ok/fail: {it.successCount}/{it.failCount}
                    </span>
                    {pnl && <span>30dPnL: {pnl.pnlSum.toFixed(2)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.col}>
          {selected ? (
            <DetailPanel
              item={selected}
              onApprove={() => void onApprove(selected.id)}
              onReject={() => void onReject(selected.id)}
              rejectReason={rejectReason}
              setRejectReason={setRejectReason}
              busy={busyId === selected.id}
            />
          ) : (
            <div style={{ color: "#a1a1aa", padding: 24, textAlign: "center" }}>
              点左侧候选查看详情。
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const RunsBar: FC<{
  runs: SkillPromotionRunSummary[];
  onRefresh: () => void;
  loading: boolean;
}> = ({ runs, onRefresh, loading }) => {
  const latest = runs[0];
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "stretch", marginBottom: 4 }}>
      <Kpi label="最近一次跑批" value={latest ? `${latest.mode}` : "—"} accent="#3b82f6" />
      <Kpi label="scanned" value={latest ? String(latest.totalScanned) : "—"} accent="#a1a1aa" />
      <Kpi label="qualified" value={latest ? String(latest.totalQualified) : "—"} accent="#a78bfa" />
      <Kpi label="promoted" value={latest ? String(latest.totalPromoted) : "—"} accent="#22c55e" />
      <Kpi
        label="status"
        value={latest?.status ?? "—"}
        accent={latest?.status === "failed" ? "#f87171" : "#22c55e"}
      />
      <button
        type="button"
        onClick={onRefresh}
        style={{ ...btnGhost, marginLeft: "auto" }}
        disabled={loading}
      >
        {loading ? "刷新中…" : "刷新"}
      </button>
    </div>
  );
};

const DetailPanel: FC<{
  item: SkillPromotionListItem;
  onApprove: () => void;
  onReject: () => void;
  rejectReason: string;
  setRejectReason: (s: string) => void;
  busy: boolean;
}> = ({ item, onApprove, onReject, rejectReason, setRejectReason, busy }) => {
  const pnl = parsePnlRollup(item.pnlAttributionJson);
  const canDecide = item.state === "pending_review";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <h3 style={{ color: "#e4e4e7", margin: 0 }}>{item.name}</h3>
        <span style={{ color: "#71717a", fontSize: 12 }}>
          {fmtTs(item.lastPromotedAt)}
        </span>
      </div>
      <p style={{ color: "#d4d4d8", margin: "8px 0" }}>{item.description || "—"}</p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 8,
          fontSize: 12,
          color: "#a1a1aa",
          margin: "12px 0",
        }}
      >
        <div>state: <span style={{ color: "#e4e4e7" }}>{item.state}</span></div>
        <div>category: {item.category}</div>
        <div>useCount: {item.useCount}</div>
        <div>success/fail: {item.successCount}/{item.failCount}</div>
        <div>promotion score: {item.promotionScore?.toFixed(3) ?? "—"}</div>
        <div>review at: {fmtTs(item.promotionReviewAt)}</div>
        {pnl && (
          <>
            <div>30d pnl sum: {pnl.pnlSum.toFixed(2)}</div>
            <div>
              win/lose: {pnl.winCount}/{pnl.loseCount}
            </div>
          </>
        )}
      </div>

      {canDecide && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            border: "1px solid #27272a",
            borderRadius: 6,
            padding: 10,
            marginTop: 8,
          }}
        >
          <textarea
            placeholder="可选：驳回理由（→ reflective experience；下次同 signature 不再 promote）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            style={{
              background: "#0a0a0a",
              color: "#e4e4e7",
              border: "1px solid #27272a",
              borderRadius: 4,
              padding: 6,
              fontSize: 12,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              style={{
                ...btnGhost,
                color: "#22c55e",
                borderColor: "#22c55e",
                cursor: busy ? "wait" : "pointer",
                flex: 1,
              }}
            >
              {busy ? "处理中…" : "✓ 通过"}
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              style={{
                ...btnGhost,
                color: "#f87171",
                borderColor: "#f87171",
                cursor: busy ? "wait" : "pointer",
                flex: 1,
              }}
            >
              {busy ? "处理中…" : "✗ 驳回"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
