/**
 * Memory V2 P3 — 监控 · Memory inspector tab。
 *
 * 设计：
 *   - 左列：指标卡片（实时 in-process counter）+ 筛选表单 + experience 列表
 *   - 右列：点击行 → 详情（contentJson + metadataJson + link 邻居 + op_log timeline）
 *
 * 关注点：
 *   - 一切只读：本 tab 不调任何写 API；后端 Memory V2 是 5 个 pipe 唯一入口
 *   - 列表 payload 不含 body —— 选中后单独走 detail 端点拉 body（减重）
 *   - link mini 图：列表 + outgoing/incoming 标记 + 点击跳转，不画真正的力导向图
 *     （Recharts 不含 graph；额外引 d3-force 增加包体；列表已经足够审计用）
 *   - 自动刷新：跟随父组件 autoRefresh，每 12s 重拉指标和列表头条
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMemoryExperienceDetail,
  getMemoryExperienceLinks,
  getMemoryExperienceOpLog,
  getMemoryMetrics,
  listMemoryExperiences,
  type ListMemoryExperiencesParams,
  type MemoryArchivalMode,
  type MemoryExperienceDetail,
  type MemoryExperienceKind,
  type MemoryExperienceLinksResponse,
  type MemoryExperienceListItem,
  type MemoryMetricsSnapshot,
  type MemoryOpLogRow,
  type MemoryOrderBy,
} from "../../api/backend";
import { Kpi, monitorAxisTick, monitorGridStroke, monitorTooltipStyle, styles } from "./monitor-shared";
import { SkillPromotionsPanel } from "./SkillPromotionsPanel";

type MemorySubTab = "experiences" | "skill_promotions";

const KIND_OPTIONS: { id: MemoryExperienceKind; label: string }[] = [
  { id: "semantic", label: "semantic" },
  { id: "procedural", label: "procedural" },
  { id: "reflective", label: "reflective" },
  { id: "episodic", label: "episodic" },
  { id: "identity", label: "identity" },
];

const ORDER_OPTIONS: { id: MemoryOrderBy; label: string }[] = [
  { id: "valid_from_desc", label: "最近创建" },
  { id: "quality_desc", label: "质量分↓" },
  { id: "created_desc", label: "DB 写入↓" },
];

const ARCHIVAL_OPTIONS: { id: MemoryArchivalMode; label: string }[] = [
  { id: "exclude_archived", label: "仅活跃" },
  { id: "all", label: "全部" },
  { id: "only_archived", label: "仅已归档" },
];

const PAGE_SIZE = 20;

/** 给指标快照分组：recall / janitor / reflector / embedder / execute */
function groupSnapshot(snap: Record<string, number>): {
  recall: Record<string, number>;
  janitor: Record<string, number>;
  reflector: Record<string, number>;
  embedder: Record<string, number>;
  execute: Record<string, number>;
  other: Record<string, number>;
} {
  const out = {
    recall: {} as Record<string, number>,
    janitor: {} as Record<string, number>,
    reflector: {} as Record<string, number>,
    embedder: {} as Record<string, number>,
    execute: {} as Record<string, number>,
    other: {} as Record<string, number>,
  };
  for (const [k, v] of Object.entries(snap)) {
    if (k.startsWith("memory.recall.")) out.recall[k.replace("memory.recall.", "")] = v;
    else if (k.startsWith("memory.janitor.")) out.janitor[k.replace("memory.janitor.", "")] = v;
    else if (k.startsWith("memory.reflector.")) out.reflector[k.replace("memory.reflector.", "")] = v;
    else if (k.startsWith("memory.embedder.")) out.embedder[k.replace("memory.embedder.", "")] = v;
    else if (k.startsWith("memory.execute.")) out.execute[k.replace("memory.execute.", "")] = v;
    else out.other[k] = v;
  }
  return out;
}

function fmtTs(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function kindAccent(kind: MemoryExperienceKind): string {
  switch (kind) {
    case "semantic":
      return "#3b82f6";
    case "procedural":
      return "#22c55e";
    case "reflective":
      return "#a78bfa";
    case "episodic":
      return "#71717a";
    case "identity":
      return "#eab308";
    default:
      return "#a1a1aa";
  }
}

export type MemoryTabProps = {
  projectId: string;
  autoRefresh: boolean;
};

export const MemoryTab: FC<MemoryTabProps> = ({ projectId, autoRefresh }) => {
  const [subTab, setSubTab] = useState<MemorySubTab>("experiences");

  return (
    <div style={{ minWidth: 0 }}>
      <SubTabBar active={subTab} onChange={setSubTab} />
      {subTab === "experiences" ? (
        <ExperiencesPanel projectId={projectId} autoRefresh={autoRefresh} />
      ) : (
        <SkillPromotionsPanel projectId={projectId} autoRefresh={autoRefresh} />
      )}
    </div>
  );
};

const SubTabBar: FC<{ active: MemorySubTab; onChange: (id: MemorySubTab) => void }> = ({
  active,
  onChange,
}) => {
  const tabs: { id: MemorySubTab; label: string }[] = [
    { id: "experiences", label: "Experiences" },
    { id: "skill_promotions", label: "Skill Promotions" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--qb-main-input-border, #27272a)",
        marginBottom: 12,
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            type="button"
            key={t.id}
            onClick={() => onChange(t.id)}
            style={{
              background: "transparent",
              color: isActive ? "#3b82f6" : "var(--qb-main-meta, #a1a1aa)",
              border: "none",
              borderBottom: `2px solid ${isActive ? "#3b82f6" : "transparent"}`,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
};

const ExperiencesPanel: FC<MemoryTabProps> = ({ projectId, autoRefresh }) => {
  // ── 筛选状态 ──
  const [selectedKinds, setSelectedKinds] = useState<Set<MemoryExperienceKind>>(new Set());
  const [subKind, setSubKind] = useState("");
  const [archivalMode, setArchivalMode] = useState<MemoryArchivalMode>("exclude_archived");
  const [orderBy, setOrderBy] = useState<MemoryOrderBy>("valid_from_desc");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  // ── 数据状态 ──
  const [items, setItems] = useState<MemoryExperienceListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

  const [metrics, setMetrics] = useState<MemoryMetricsSnapshot | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemoryExperienceDetail | null>(null);
  const [links, setLinks] = useState<MemoryExperienceLinksResponse | null>(null);
  const [oplog, setOplog] = useState<MemoryOpLogRow[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // ── load 函数 ──
  const reloadList = useCallback(async () => {
    if (!projectId) return;
    setLoadingList(true);
    setListErr(null);
    try {
      const params: ListMemoryExperiencesParams = {
        projectId,
        archivalMode,
        orderBy,
        limit: PAGE_SIZE,
        offset,
        pinnedOnly,
        ...(selectedKinds.size > 0 ? { kinds: Array.from(selectedKinds) } : {}),
        ...(subKind.trim() ? { subKind: subKind.trim() } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      };
      const data = await listMemoryExperiences(params);
      setItems(data.items);
      setTotal(data.total);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
      setItems([]);
      setTotal(0);
    } finally {
      setLoadingList(false);
    }
  }, [projectId, selectedKinds, subKind, archivalMode, orderBy, pinnedOnly, q, offset]);

  const reloadMetrics = useCallback(async () => {
    try {
      setMetrics(await getMemoryMetrics());
    } catch {
      setMetrics(null);
    }
  }, []);

  const reloadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const [d, l, ops] = await Promise.all([
        getMemoryExperienceDetail(id),
        getMemoryExperienceLinks(id).catch(() => ({
          seed: { id, kind: "semantic" as MemoryExperienceKind, subKind: "", summary: "" },
          links: [],
        })),
        getMemoryExperienceOpLog(id, 100).catch(() => [] as MemoryOpLogRow[]),
      ]);
      setDetail(d);
      setLinks(l);
      setOplog(ops);
    } catch (e) {
      setDetail(null);
      setLinks(null);
      setOplog([]);
      console.error("[memory] load detail failed", e);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // ── effects ──
  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  useEffect(() => {
    void reloadMetrics();
  }, [reloadMetrics]);

  useEffect(() => {
    if (!autoRefresh || !projectId) return;
    const t = window.setInterval(() => {
      void reloadList();
      void reloadMetrics();
    }, 12_000);
    return () => window.clearInterval(t);
  }, [autoRefresh, projectId, reloadList, reloadMetrics]);

  // 切换筛选时复位 offset
  useEffect(() => {
    setOffset(0);
  }, [selectedKinds, subKind, archivalMode, orderBy, pinnedOnly, q]);

  const toggleKind = (k: MemoryExperienceKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const onRowClick = useCallback(
    (id: string) => {
      setSelectedId(id);
      void reloadDetail(id);
    },
    [reloadDetail]
  );

  const groups = useMemo(() => (metrics ? groupSnapshot(metrics.snapshot) : null), [metrics]);

  // ── 渲染 ──
  return (
    <div style={{ minWidth: 0 }}>
      <MetricsCards groups={groups} snapshotTs={metrics?.ts} onRefresh={() => void reloadMetrics()} />

      <div style={styles.split}>
        <div style={styles.col}>
          <FilterBar
            selectedKinds={selectedKinds}
            toggleKind={toggleKind}
            subKind={subKind}
            setSubKind={setSubKind}
            archivalMode={archivalMode}
            setArchivalMode={setArchivalMode}
            orderBy={orderBy}
            setOrderBy={setOrderBy}
            pinnedOnly={pinnedOnly}
            setPinnedOnly={setPinnedOnly}
            q={q}
            setQ={setQ}
            onRefresh={() => void reloadList()}
          />
          <ListTable
            items={items}
            selectedId={selectedId}
            total={total}
            offset={offset}
            onSelect={onRowClick}
            loading={loadingList}
            error={listErr}
          />
          <Pagination
            total={total}
            offset={offset}
            pageSize={PAGE_SIZE}
            onChange={setOffset}
          />
        </div>

        <div style={styles.col}>
          <DetailPanel
            detail={detail}
            links={links}
            oplog={oplog}
            loading={loadingDetail}
            onJumpToOther={onRowClick}
          />
        </div>
      </div>
    </div>
  );
};

// ───────────────────────── 子组件 ─────────────────────────

const MetricsCards: FC<{
  groups: ReturnType<typeof groupSnapshot> | null;
  snapshotTs: string | undefined;
  onRefresh: () => void;
}> = ({ groups, snapshotTs, onRefresh }) => {
  const cards: { label: string; value: string; accent: string }[] = [];
  const has = groups && Object.values(groups).some((g) => Object.keys(g).length > 0);

  if (groups) {
    if (groups.recall["hits.total"] != null) {
      cards.push({
        label: "Recall hits（累计）",
        value: String(groups.recall["hits.total"] ?? 0),
        accent: "#3b82f6",
      });
    }
    if (groups.execute["total"] != null) {
      const succ = groups.execute["by_outcome.success"] ?? 0;
      const fail = groups.execute["by_outcome.fail"] ?? 0;
      const tot = groups.execute["total"] ?? 0;
      const rate = tot > 0 ? `${Math.round((succ / tot) * 100)}%` : "—";
      cards.push({ label: `Execute 成功率 (${succ}/${tot})`, value: rate, accent: "#22c55e" });
      if (fail > 0) {
        cards.push({ label: "Execute 失败", value: String(fail), accent: "#f87171" });
      }
    }
    if (groups.janitor["tick.total"] != null) {
      cards.push({
        label: "Janitor ticks",
        value: String(groups.janitor["tick.total"] ?? 0),
        accent: "#a78bfa",
      });
      if (groups.janitor["archived"] != null) {
        cards.push({
          label: "Janitor archived",
          value: String(groups.janitor["archived"] ?? 0),
          accent: "#71717a",
        });
      }
    }
    if (groups.embedder["tick.total"] != null) {
      cards.push({
        label: "Embedder ticks",
        value: String(groups.embedder["tick.total"] ?? 0),
        accent: "#eab308",
      });
      const succ = groups.embedder["succeeded"] ?? 0;
      const fail = groups.embedder["failed"] ?? 0;
      cards.push({
        label: `Embedder ok/fail`,
        value: `${succ}/${fail}`,
        accent: fail > 0 ? "#f59e0b" : "#22c55e",
      });
    }
    if (groups.reflector["runs.total"] != null) {
      cards.push({
        label: "Reflector runs",
        value: String(groups.reflector["runs.total"] ?? 0),
        accent: "#ec4899",
      });
    }
  }

  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ ...styles.subTitle, margin: 0 }}>Memory V2 · 进程内指标</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {snapshotTs ? (
            <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
              快照 @ {fmtTs(snapshotTs)}
            </span>
          ) : null}
          <button
            type="button"
            className="qb-btn-secondary"
            style={{ fontSize: 11, padding: "3px 10px" }}
            onClick={onRefresh}
          >
            刷新指标
          </button>
        </div>
      </div>
      {!has ? (
        <div style={styles.empty}>
          暂无指标。Memory V2 是事件驱动的：等待 reason 节点召回 / Janitor cron / Embedder cron 触发后才会累计。
        </div>
      ) : (
        <div style={styles.kpiRow}>
          {cards.map((c) => (
            <Kpi key={c.label} label={c.label} value={c.value} accent={c.accent} />
          ))}
        </div>
      )}
      <span style={{ display: "none" }}>
        {/* recharts 在 MetricsCards 不展示，但保留 import 兜底（如未来加 sparkline 用） */}
        {monitorAxisTick.fontSize}
        {monitorGridStroke}
        {monitorTooltipStyle.color}
      </span>
    </section>
  );
};

const FilterBar: FC<{
  selectedKinds: Set<MemoryExperienceKind>;
  toggleKind: (k: MemoryExperienceKind) => void;
  subKind: string;
  setSubKind: (v: string) => void;
  archivalMode: MemoryArchivalMode;
  setArchivalMode: (v: MemoryArchivalMode) => void;
  orderBy: MemoryOrderBy;
  setOrderBy: (v: MemoryOrderBy) => void;
  pinnedOnly: boolean;
  setPinnedOnly: (v: boolean) => void;
  q: string;
  setQ: (v: string) => void;
  onRefresh: () => void;
}> = ({
  selectedKinds,
  toggleKind,
  subKind,
  setSubKind,
  archivalMode,
  setArchivalMode,
  orderBy,
  setOrderBy,
  pinnedOnly,
  setPinnedOnly,
  q,
  setQ,
  onRefresh,
}) => (
  <section style={{ marginBottom: 10 }}>
    <h3 style={{ ...styles.subTitle, margin: "0 0 8px" }}>Experience 列表</h3>
    <div style={styles.form}>
      <input
        type="text"
        placeholder="关键词（summary / body / tags）"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={styles.input}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRefresh();
        }}
      />
      <input
        type="text"
        placeholder="subKind 精确"
        value={subKind}
        onChange={(e) => setSubKind(e.target.value)}
        style={{ ...styles.input, flex: "0 1 160px" }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onRefresh();
        }}
      />
      <select
        value={archivalMode}
        onChange={(e) => setArchivalMode(e.target.value as MemoryArchivalMode)}
        style={styles.select}
      >
        {ARCHIVAL_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        value={orderBy}
        onChange={(e) => setOrderBy(e.target.value as MemoryOrderBy)}
        style={styles.select}
      >
        {ORDER_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <label style={styles.check}>
        <input
          type="checkbox"
          checked={pinnedOnly}
          onChange={(e) => setPinnedOnly(e.target.checked)}
        />
        仅 pinned
      </label>
      <button type="button" className="qb-btn-secondary" style={{ fontSize: 11, padding: "3px 10px" }} onClick={onRefresh}>
        刷新
      </button>
    </div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
      {KIND_OPTIONS.map((k) => {
        const active = selectedKinds.has(k.id);
        return (
          <button
            key={k.id}
            type="button"
            onClick={() => toggleKind(k.id)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 12,
              border: `1px solid ${active ? kindAccent(k.id) : "var(--qb-main-input-border, #3f3f46)"}`,
              background: active ? `${kindAccent(k.id)}22` : "transparent",
              color: active ? kindAccent(k.id) : "var(--qb-main-meta, #a1a1aa)",
              cursor: "pointer",
            }}
          >
            {k.label}
          </button>
        );
      })}
    </div>
  </section>
);

const ListTable: FC<{
  items: MemoryExperienceListItem[];
  selectedId: string | null;
  total: number;
  offset: number;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
}> = ({ items, selectedId, total, offset, onSelect, loading, error }) => {
  if (error) {
    return <div style={styles.empty}>加载失败：{error}</div>;
  }
  if (loading && items.length === 0) {
    return <div style={styles.empty}>加载中…</div>;
  }
  if (items.length === 0) {
    return <div style={styles.empty}>当前条件下没有 experience 记录。</div>;
  }
  return (
    <>
      <div style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)", marginBottom: 4 }}>
        共 {total} 条 · 当前 {offset + 1} – {Math.min(offset + items.length, total)}
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 90 }}>kind</th>
              <th style={styles.th}>summary</th>
              <th style={{ ...styles.th, width: 60, textAlign: "right" }}>quality</th>
              <th style={{ ...styles.th, width: 60, textAlign: "right" }}>use</th>
              <th style={{ ...styles.th, width: 80 }}>embed</th>
              <th style={{ ...styles.th, width: 140 }}>validFrom</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const sel = it.id === selectedId;
              const archived = it.validTo !== null;
              return (
                <tr
                  key={it.id}
                  style={{
                    ...styles.tr,
                    ...(sel ? styles.trSelected : {}),
                    opacity: archived ? 0.55 : 1,
                  }}
                  onClick={() => onSelect(it.id)}
                >
                  <td style={styles.td}>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: 10,
                        fontWeight: 700,
                        color: kindAccent(it.kind),
                        border: `1px solid ${kindAccent(it.kind)}55`,
                      }}
                    >
                      {it.kind}
                      {it.subKind ? `/${it.subKind}` : ""}
                    </span>
                    {it.pinned ? (
                      <span style={{ marginLeft: 4, fontSize: 10, color: "#eab308" }}>📌</span>
                    ) : null}
                  </td>
                  <td style={{ ...styles.td, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.summary || <em style={{ color: "var(--qb-main-meta, #71717a)" }}>（无 summary）</em>}
                  </td>
                  <td style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {it.qualityScore.toFixed(2)}
                  </td>
                  <td style={{ ...styles.td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {it.useCount}
                  </td>
                  <td style={styles.td}>
                    {it.embeddingState ? (
                      <span
                        style={{
                          fontSize: 10,
                          padding: "1px 6px",
                          borderRadius: 4,
                          color:
                            it.embeddingState === "done"
                              ? "#22c55e"
                              : it.embeddingState === "failed"
                                ? "#f87171"
                                : "#71717a",
                          border: `1px solid currentColor`,
                        }}
                      >
                        {it.embeddingState}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, color: "var(--qb-main-meta, #71717a)" }}>—</span>
                    )}
                  </td>
                  <td style={{ ...styles.td, fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" }}>
                    {fmtTs(it.validFrom)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

const Pagination: FC<{
  total: number;
  offset: number;
  pageSize: number;
  onChange: (offset: number) => void;
}> = ({ total, offset, pageSize, onChange }) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.floor(offset / pageSize) + 1;
  if (total <= pageSize) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
      <button
        type="button"
        className="qb-btn-secondary"
        style={{ fontSize: 11, padding: "3px 10px" }}
        disabled={cur === 1}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        上一页
      </button>
      <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
        {cur} / {totalPages}
      </span>
      <button
        type="button"
        className="qb-btn-secondary"
        style={{ fontSize: 11, padding: "3px 10px" }}
        disabled={cur === totalPages}
        onClick={() => onChange(offset + pageSize)}
      >
        下一页
      </button>
    </div>
  );
};

const DetailPanel: FC<{
  detail: MemoryExperienceDetail | null;
  links: MemoryExperienceLinksResponse | null;
  oplog: MemoryOpLogRow[];
  loading: boolean;
  onJumpToOther: (id: string) => void;
}> = ({ detail, links, oplog, loading, onJumpToOther }) => {
  if (!detail && !loading) {
    return (
      <section style={{ ...styles.empty, padding: 24 }}>
        ← 在左侧列表点击任意 experience 行查看详情。
      </section>
    );
  }
  if (loading || !detail) {
    return <section style={styles.empty}>加载详情中…</section>;
  }

  return (
    <section>
      <h3 style={{ ...styles.subTitle, margin: "0 0 8px" }}>详情</h3>
      <div
        style={{
          background: "var(--qb-main-card-bg, #18181b)",
          border: `1px solid ${kindAccent(detail.kind)}55`,
          borderRadius: 10,
          padding: "12px 14px",
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span
            style={{
              padding: "1px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 700,
              color: kindAccent(detail.kind),
              border: `1px solid ${kindAccent(detail.kind)}`,
            }}
          >
            {detail.kind}
            {detail.subKind ? `/${detail.subKind}` : ""}
          </span>
          <span style={{ fontSize: 11, color: "var(--qb-main-meta, #71717a)" }}>
            id={shortId(detail.id)}
          </span>
          {detail.pinned ? <span style={{ color: "#eab308" }}>📌 pinned</span> : null}
          {detail.validTo ? (
            <span style={{ fontSize: 11, color: "#f87171" }}>archived</span>
          ) : null}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--qb-body-fg, #f4f4f5)", marginBottom: 6 }}>
          {detail.contentJson.summary || <em>（无 summary）</em>}
        </div>
        {detail.contentJson.body ? (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--qb-main-input-fg, #d4d4d8)",
              background: "var(--qb-stream-box-bg, #1f1f23)",
              padding: 10,
              borderRadius: 8,
              margin: "8px 0",
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {String(detail.contentJson.body)}
          </pre>
        ) : null}
        <MetaBadges detail={detail} />
      </div>

      {/* Link 邻居 */}
      <h4 style={{ fontSize: 13, fontWeight: 600, margin: "12px 0 6px", color: "var(--qb-monitor-title-fg, inherit)" }}>
        关联 link · {links?.links.length ?? 0} 条
      </h4>
      {links && links.links.length > 0 ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: 90 }}>relation</th>
                <th style={{ ...styles.th, width: 70 }}>方向</th>
                <th style={styles.th}>邻居</th>
              </tr>
            </thead>
            <tbody>
              {links.links.map((l) => (
                <tr
                  key={l.id}
                  style={styles.tr}
                  onClick={() => l.otherId && onJumpToOther(l.otherId)}
                >
                  <td style={styles.td}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "1px 6px",
                        borderRadius: 4,
                        color: relationAccent(l.relation),
                        border: `1px solid ${relationAccent(l.relation)}55`,
                      }}
                    >
                      {l.relation}
                    </span>
                  </td>
                  <td style={{ ...styles.td, fontSize: 11 }}>
                    {l.direction === "outgoing" ? "→" : "←"} {l.direction}
                  </td>
                  <td style={{ ...styles.td, fontSize: 11 }}>
                    {l.other ? (
                      <>
                        <span style={{ color: kindAccent(l.other.kind) }}>{l.other.kind}</span>
                        <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}> · </span>
                        {l.other.summary || <em>（无 summary）</em>}
                        {l.other.validTo ? (
                          <span style={{ marginLeft: 4, color: "#f87171" }}>(archived)</span>
                        ) : null}
                      </>
                    ) : (
                      <em style={{ color: "var(--qb-main-meta, #71717a)" }}>邻居已删（孤儿 link）</em>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={styles.empty}>暂无 link。</div>
      )}

      {/* op log */}
      <h4 style={{ fontSize: 13, fontWeight: 600, margin: "12px 0 6px", color: "var(--qb-monitor-title-fg, inherit)" }}>
        op log · 最近 {oplog.length} 条
      </h4>
      {oplog.length > 0 ? (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={{ ...styles.th, width: 90 }}>op</th>
                <th style={{ ...styles.th, width: 110 }}>actor</th>
                <th style={{ ...styles.th, width: 130 }}>时间</th>
                <th style={styles.th}>reason</th>
              </tr>
            </thead>
            <tbody>
              {oplog.map((o) => (
                <tr key={o.id}>
                  <td style={styles.td}>
                    <span style={{ fontSize: 11, color: opAccent(o.op) }}>{o.op}</span>
                  </td>
                  <td style={{ ...styles.td, fontSize: 11 }}>{o.actor}</td>
                  <td style={{ ...styles.td, fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" }}>
                    {fmtTs(o.ts)}
                  </td>
                  <td style={{ ...styles.td, fontSize: 11 }}>{o.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={styles.empty}>暂无 op log。</div>
      )}
    </section>
  );
};

const MetaBadges: FC<{ detail: MemoryExperienceDetail }> = ({ detail }) => {
  const items: { label: string; value: string }[] = [
    { label: "quality", value: detail.qualityScore.toFixed(3) },
    { label: "use", value: String(detail.useCount) },
    { label: "succ", value: String(detail.successCount) },
    { label: "fail", value: String(detail.failCount) },
    { label: "scope", value: `${detail.scope}/${shortId(detail.scopeId)}` },
    { label: "visibility", value: detail.visibility },
  ];
  if (detail.definitionId) items.push({ label: "agent", value: shortId(detail.definitionId) });
  if (detail.sourceRunId) items.push({ label: "from wf", value: shortId(detail.sourceRunId) });
  if (detail.embeddingState) {
    items.push({ label: "embed", value: `${detail.embeddingState}${detail.embeddingModel ? ` · ${detail.embeddingModel}` : ""}` });
  }
  if (detail.decayAt) items.push({ label: "decay", value: fmtTs(detail.decayAt) });
  if (detail.tags.length > 0) items.push({ label: "tags", value: detail.tags.join(", ") });
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 11 }}>
      {items.map((i) => (
        <span
          key={i.label}
          style={{
            padding: "2px 8px",
            borderRadius: 4,
            background: "var(--qb-stream-box-bg, #1f1f23)",
            color: "var(--qb-main-meta, #a1a1aa)",
          }}
        >
          <span style={{ color: "var(--qb-main-meta, #71717a)" }}>{i.label}=</span>
          <span style={{ color: "var(--qb-main-input-fg, #d4d4d8)" }}>{i.value}</span>
        </span>
      ))}
    </div>
  );
};

function relationAccent(rel: string): string {
  switch (rel) {
    case "evidence_of":
      return "#22c55e";
    case "derive_from":
      return "#3b82f6";
    case "supersedes":
      return "#a78bfa";
    case "contradicts":
      return "#f87171";
    case "related_to":
      return "#a1a1aa";
    default:
      return "#a1a1aa";
  }
}

function opAccent(op: string): string {
  switch (op) {
    case "create":
      return "#22c55e";
    case "update":
      return "#3b82f6";
    case "recall":
      return "#a78bfa";
    case "execute":
      return "#eab308";
    case "supersede":
    case "archive":
      return "#f87171";
    case "promote":
      return "#06b6d4";
    case "pin":
    case "unpin":
      return "#f59e0b";
    default:
      return "#a1a1aa";
  }
}
