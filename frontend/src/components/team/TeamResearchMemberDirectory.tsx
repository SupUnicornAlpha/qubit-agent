import type { CSSProperties, Dispatch, FC, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAgentGroup, listAgentGroups, patchAgentGroup } from "../../api/backend";
import type { AgentDefinitionBundle, AgentGroupDetail, AgentGroupRecord } from "../../api/types";

const ANALYST_ROLES = [
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
] as const;

const BUCKET: Record<string, { label: string; color: string }> = {
  analyst: { label: "分析师（MSA）", color: "#3b82f6" },
  researcher: { label: "研究员", color: "#8b5cf6" },
  risk: { label: "风控", color: "#ef4444" },
  portfolio: { label: "组合", color: "#f59e0b" },
  execution: { label: "执行", color: "#10b981" },
  ops: { label: "运营 / 其他", color: "#6b7280" },
};

function bucketKey(role: string): keyof typeof BUCKET {
  if (role.startsWith("analyst_")) return "analyst";
  if (role.includes("researcher")) return "researcher";
  if (role.includes("risk")) return "risk";
  if (role.includes("portfolio")) return "portfolio";
  if (role.includes("execution") || role === "simulation") return "execution";
  return "ops";
}

function parseRelations(raw: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ from: string; to: string }> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.from === "string" && typeof r.to === "string" && r.from !== r.to) {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}

const card: CSSProperties = {
  background: "var(--qb-main-card-bg, #18181b)",
  border: "1px solid var(--qb-main-card-border, #27272a)",
  borderRadius: 8,
  padding: 10,
  minWidth: 0,
};
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" };

export const TeamResearchMemberDirectory: FC<{
  analystAgentGroupId: string;
  setAnalystAgentGroupId: (id: string) => void;
  analystAgentGroupOptions: AgentGroupRecord[];
  setAnalystAgentGroupOptions: (rows: AgentGroupRecord[]) => void;
  agentDefBundles: AgentDefinitionBundle[] | null;
  participatingAnalystDefinitionIds: string[];
  setParticipatingAnalystDefinitionIds: Dispatch<SetStateAction<string[]>>;
}> = ({
  analystAgentGroupId,
  setAnalystAgentGroupId,
  analystAgentGroupOptions,
  setAnalystAgentGroupOptions,
  agentDefBundles,
  participatingAnalystDefinitionIds,
  setParticipatingAnalystDefinitionIds,
}) => {
  const [detail, setDetail] = useState<AgentGroupDetail | null>(null);
  const [edges, setEdges] = useState<Array<{ from: string; to: string }>>([]);
  const [topologyMsg, setTopologyMsg] = useState<string | null>(null);
  const [savingTopo, setSavingTopo] = useState(false);

  const refreshGroups = useCallback(() => {
    void listAgentGroups().then(setAnalystAgentGroupOptions).catch(() => setAnalystAgentGroupOptions([]));
  }, [setAnalystAgentGroupOptions]);

  useEffect(() => {
    if (!analystAgentGroupId.trim()) {
      setDetail(null);
      setEdges([]);
      return;
    }
    void getAgentGroup(analystAgentGroupId.trim())
      .then((d) => {
        setDetail(d);
        setEdges(parseRelations(d.group.relationsJson));
      })
      .catch(() => {
        setDetail(null);
        setEdges([]);
      });
  }, [analystAgentGroupId]);

  const analystRolesInGroup = useMemo(() => {
    const m = detail?.members ?? [];
    const set = new Set<string>();
    for (const x of m) {
      if (ANALYST_ROLES.includes(x.role as (typeof ANALYST_ROLES)[number])) set.add(x.role);
    }
    return [...set].sort();
  }, [detail]);

  const analystDefsSelectable = useMemo(() => {
    if (!agentDefBundles) return [];
    return agentDefBundles.filter(
      (b) =>
        b.definition.enabled !== false &&
        ANALYST_ROLES.includes(b.definition.role as (typeof ANALYST_ROLES)[number])
    );
  }, [agentDefBundles]);

  const poolByBucket = useMemo(() => {
    const map = new Map<string, AgentDefinitionBundle[]>();
    if (!agentDefBundles) return map;
    for (const b of agentDefBundles) {
      if (b.definition.enabled === false) continue;
      const k = bucketKey(b.definition.role);
      const arr = map.get(k) ?? [];
      arr.push(b);
      map.set(k, arr);
    }
    return map;
  }, [agentDefBundles]);

  const toggleEdge = (from: string, to: string) => {
    const i = edges.findIndex((e) => e.from === from && e.to === to);
    if (i >= 0) setEdges((prev) => prev.filter((_, j) => j !== i));
    else setEdges((prev) => [...prev, { from, to }]);
  };

  const saveTopology = async () => {
    if (!analystAgentGroupId.trim()) return;
    setTopologyMsg(null);
    setSavingTopo(true);
    try {
      await patchAgentGroup(analystAgentGroupId.trim(), { relationsJson: edges });
      setTopologyMsg("已保存通信拓扑（写入编组 relations_json）。");
      refreshGroups();
      const d = await getAgentGroup(analystAgentGroupId.trim());
      setDetail(d);
    } catch (e) {
      setTopologyMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setSavingTopo(false);
    }
  };

  return (
    <div style={{ padding: "4px 0 24px", maxWidth: 1100 }}>
      <p style={{ fontSize: 13, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 16, lineHeight: 1.55 }}>
        成员与编组数据来自<strong>配置中心已发布的 Agent 定义</strong>及 <code style={{ fontSize: 12 }}>agent_group</code>。
        左侧「分析师编组」与下方「设为当前编组」共用同一选择；<strong>通信拓扑</strong>保存在编组的{" "}
        <code style={{ fontSize: 12 }}>relations_json</code>，启动分析时按拓扑分层并行：有向边 from→to 表示 to 在推理前会收到
        from 的结论文本摘要。
      </p>

      <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", margin: "0 0 8px" }}>Agent 编组</h4>
      <div style={{ ...row, marginBottom: 16 }}>
        {analystAgentGroupOptions.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>暂无编组（可在配置中心或通过种子创建）</span>
        ) : (
          analystAgentGroupOptions.map((g) => (
            <button
              key={g.id}
              type="button"
              className={g.id === analystAgentGroupId ? "qb-btn-primary-brand" : "qb-btn-secondary"}
              style={{ fontSize: 12, padding: "6px 12px" }}
              onClick={() => setAnalystAgentGroupId(g.id)}
            >
              {g.name}
              {typeof g.memberCount === "number" ? ` · ${g.memberCount} 人` : ""}
            </button>
          ))
        )}
      </div>

      {detail ? (
        <div style={{ marginBottom: 20 }}>
          <div style={{ ...row, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #fafafa)" }}>{detail.group.name}</span>
            <button type="button" className="qb-btn-secondary" style={{ fontSize: 12 }} onClick={() => void saveTopology()} disabled={savingTopo}>
              {savingTopo ? "保存拓扑中…" : "保存通信拓扑"}
            </button>
          </div>
          {topologyMsg ? (
            <div style={{ fontSize: 12, color: "var(--qb-agent-draft-accent, #93c5fd)", marginBottom: 8 }}>{topologyMsg}</div>
          ) : null}
          <div style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>{detail.group.description || "无描述"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {detail.members.map((m) => (
              <div key={m.id} style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>{m.definitionName}</div>
                <div style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginTop: 4 }}>{m.role}</div>
                <div style={{ fontSize: 10, color: "var(--qb-team-meta, #52525b)", marginTop: 4 }}>definition: {m.definitionId.slice(0, 8)}…</div>
              </div>
            ))}
          </div>

          {analystRolesInGroup.length > 0 ? (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-section-fg, #cbd5e1)", marginBottom: 6 }}>
                分析师通信拓扑（行 → 列：行先于列执行，并向列传递上下文）
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ padding: 6, border: "1px solid var(--qb-team-table-row-border, #3f3f46)", color: "var(--qb-team-table-header-fg, #a1a1aa)" }}>
                        from \ to
                      </th>
                      {analystRolesInGroup.map((c) => (
                        <th
                          key={c}
                          style={{
                            padding: 6,
                            border: "1px solid var(--qb-team-table-row-border, #3f3f46)",
                            color: "var(--qb-team-table-header-fg, #a1a1aa)",
                            maxWidth: 120,
                          }}
                        >
                          {c.replace("analyst_", "")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {analystRolesInGroup.map((from) => (
                      <tr key={from}>
                        <td style={{ padding: 6, border: "1px solid var(--qb-team-table-row-border, #3f3f46)", color: "var(--qb-team-table-cell-fg, #d4d4d8)", fontWeight: 600 }}>
                          {from.replace("analyst_", "")}
                        </td>
                        {analystRolesInGroup.map((to) => {
                          const on = edges.some((e) => e.from === from && e.to === to);
                          const disabled = from === to;
                          return (
                            <td key={`${from}-${to}`} style={{ padding: 4, border: "1px solid var(--qb-team-table-row-border, #27272a)", textAlign: "center" }}>
                              <input
                                type="checkbox"
                                disabled={disabled}
                                checked={on}
                                onChange={() => !disabled && toggleEdge(from, to)}
                                title={disabled ? "" : `边 ${from} → ${to}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ fontSize: 11, color: "var(--qb-team-meta, #52525b)", marginTop: 8 }}>
                留空矩阵表示四分析师并行（与旧行为一致）。勾选 A→B 后，运行「启动团队分析」时 B 的 prompt 会附带 A 的输出摘要。
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginTop: 12 }}>当前编组无 analyst_* 成员，拓扑矩阵不可用。</p>
          )}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginBottom: 16 }}>请在上方选择一个编组，或回到左侧「发起分析」选择分析师编组。</p>
      )}

      <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", margin: "20px 0 8px" }}>已启用 Agent 池（按职能分组）</h4>
      {agentDefBundles === null ? (
        <div style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>正在加载 Agent 定义…</div>
      ) : (
        (Object.keys(BUCKET) as Array<keyof typeof BUCKET>).map((bk) => {
          const list = poolByBucket.get(bk) ?? [];
          if (list.length === 0) return null;
          const meta = BUCKET[bk];
          return (
            <div key={bk} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: meta.color, marginBottom: 6 }}>
                {meta.label}（{list.length}）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                {list.map((b) => (
                  <div key={b.definition.id} style={card}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>{b.definition.name}</div>
                    <div style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginTop: 4 }}>{b.definition.role}</div>
                    <div style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginTop: 6, lineHeight: 1.4 }}>
                      {b.profile?.description?.trim() || "（无 profile 描述）"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })
      )}

      <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", margin: "20px 0 8px" }}>本次分析参与的分析师（按 Agent 定义勾选）</h4>
      <p style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>
        与左侧「团队成员」联动；每条对应配置中心一条<strong>已启用</strong>的 analyst_* 定义（同一角色若有多条定义，可分别勾选）。
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {analystDefsSelectable.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>暂无已启用的 analyst_* 定义</span>
        ) : (
          analystDefsSelectable.map((b) => {
            const id = b.definition.id;
            const on = participatingAnalystDefinitionIds.includes(id);
            return (
              <label
                key={id}
                style={{
                  ...card,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    setParticipatingAnalystDefinitionIds((prev) =>
                      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                    );
                  }}
                  style={{ marginTop: 3 }}
                />
                <span style={{ fontSize: 12, color: "var(--qb-body-fg, #e4e4e7)", lineHeight: 1.45 }}>
                  <strong>{b.definition.name}</strong>
                  <span style={{ color: "var(--qb-team-meta, #71717a)" }}> · {b.definition.role}</span>
                  <div style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginTop: 4 }}>
                    id {id.slice(0, 8)}…
                  </div>
                </span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
};
