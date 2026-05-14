import type { CSSProperties, Dispatch, FC, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addAgentGroupMember,
  getAgentGroup,
  listAgentGroups,
  patchAgentGroup,
  removeAgentGroupMember,
} from "../../api/backend";
import type { AgentDefinitionBundle, AgentGroupDetail, AgentGroupRecord } from "../../api/types";
import { RESEARCH_TEAM_GROUP_POOL_ROLE_SET, RESEARCH_TEAM_SLOT_ROLE_SET } from "../../lib/researchTeamRoles";
import {
  mergeLayoutWithRoles,
  parseRelationsFull,
  pruneLayoutForRoles,
  pruneTopologyForRoles,
  serializeRelationsPayload,
  type TeamTopologyEdge,
  type TopologyCanvasMeta,
} from "../../lib/researchTeamTopology";
import { ResearchTopologyCanvas, type TopologyDrawMode } from "./ResearchTopologyCanvas";

const BUCKET: Record<string, { label: string; color: string }> = {
  analyst: { label: "分析师（MSA）", color: "#3b82f6" },
  researcher: { label: "研究员 / 策略 / 回测", color: "#8b5cf6" },
  risk: { label: "风控", color: "#ef4444" },
  portfolio: { label: "组合", color: "#f59e0b" },
  execution: { label: "执行", color: "#10b981" },
  orchestration: { label: "编排", color: "#14b8a6" },
  ops: { label: "运营 / 其他", color: "#6b7280" },
};

function bucketKey(role: string): keyof typeof BUCKET {
  if (role.startsWith("analyst_")) return "analyst";
  if (role.includes("researcher")) return "researcher";
  if (role === "research" || role === "backtest" || role === "backtest_engineer") return "researcher";
  if (role.includes("risk")) return "risk";
  if (role.includes("portfolio")) return "portfolio";
  if (role === "orchestrator") return "orchestration";
  if (role.includes("execution") || role === "simulation") return "execution";
  return "ops";
}

function uniqueRolesInOrder(members: Array<{ role: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of members) {
    if (seen.has(m.role)) continue;
    seen.add(m.role);
    out.push(m.role);
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
  const [topologyEdges, setTopologyEdges] = useState<TeamTopologyEdge[]>([]);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [drawMode, setDrawMode] = useState<TopologyDrawMode>("select");
  const [topologyMsg, setTopologyMsg] = useState<string | null>(null);
  const [savingTopo, setSavingTopo] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);

  const refreshGroups = useCallback(() => {
    void listAgentGroups().then(setAnalystAgentGroupOptions).catch(() => setAnalystAgentGroupOptions([]));
  }, [setAnalystAgentGroupOptions]);

  const applyGroupDetail = useCallback((d: AgentGroupDetail) => {
    setDetail(d);
    const parsed = parseRelationsFull(d.group.relationsJson);
    setTopologyEdges(parsed.edges);
    const roles = uniqueRolesInOrder(d.members);
    setNodePositions(mergeLayoutWithRoles(roles, parsed.meta));
  }, []);

  useEffect(() => {
    if (!analystAgentGroupId.trim()) {
      setDetail(null);
      setTopologyEdges([]);
      setNodePositions({});
      return;
    }
    void getAgentGroup(analystAgentGroupId.trim())
      .then((d) => {
        applyGroupDetail(d);
      })
      .catch(() => {
        setDetail(null);
        setTopologyEdges([]);
        setNodePositions({});
      });
  }, [analystAgentGroupId, applyGroupDetail]);

  const memberRolesOrdered = useMemo(
    () => (detail ? uniqueRolesInOrder(detail.members) : []),
    [detail]
  );

  const duplicateRoleInGroup = useMemo(() => {
    if (!detail?.members.length) return false;
    return uniqueRolesInOrder(detail.members).length !== detail.members.length;
  }, [detail]);

  const analystDefsSelectable = useMemo(() => {
    if (!agentDefBundles) return [];
    return agentDefBundles.filter(
      (b) => b.definition.enabled !== false && RESEARCH_TEAM_SLOT_ROLE_SET.has(b.definition.role)
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

  const saveTopology = async () => {
    if (!analystAgentGroupId.trim() || !detail) return;
    setTopologyMsg(null);
    setSavingTopo(true);
    try {
      const roles = uniqueRolesInOrder(detail.members);
      const roleSet = new Set(roles);
      const prunedEdges = pruneTopologyForRoles(topologyEdges, roleSet);
      const prunedPos = pruneLayoutForRoles(nodePositions, roleSet);
      const layoutMeta = mergeLayoutWithRoles(roles, { type: "topology_canvas", nodePositions: prunedPos });
      const meta: TopologyCanvasMeta = { type: "topology_canvas", nodePositions: layoutMeta };
      await patchAgentGroup(analystAgentGroupId.trim(), {
        relationsJson: serializeRelationsPayload(meta, prunedEdges) as never,
      });
      setTopologyEdges(prunedEdges);
      setNodePositions(mergeLayoutWithRoles(roles, meta));
      setTopologyMsg("已保存研究组拓扑（relations_json：画布布局 + 单向 / 广播边）。");
      refreshGroups();
      const d = await getAgentGroup(analystAgentGroupId.trim());
      applyGroupDetail(d);
    } catch (e) {
      setTopologyMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setSavingTopo(false);
    }
  };

  const handleAddToGroup = async (definitionId: string, role: string) => {
    if (!analystAgentGroupId.trim() || !detail) return;
    if (detail.members.some((m) => m.role === role)) {
      setTopologyMsg(
        `编组内已有角色「${role}」。调度与画布以角色为节点，同一编组内每个角色仅保留一条定义；请先移除现有成员或换用其他角色。`
      );
      return;
    }
    setTopologyMsg(null);
    setMemberBusy(true);
    try {
      const nextOrder =
        detail.members.length === 0 ? 0 : Math.max(...detail.members.map((m) => m.sortOrder), 0) + 1;
      await addAgentGroupMember(analystAgentGroupId.trim(), { definitionId, sortOrder: nextOrder });
      const d = await getAgentGroup(analystAgentGroupId.trim());
      applyGroupDetail(d);
      refreshGroups();
      setTopologyMsg("已从 Agent 池加入编组。");
    } catch (e) {
      setTopologyMsg(`加入失败：${(e as Error).message}`);
    } finally {
      setMemberBusy(false);
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!analystAgentGroupId.trim() || !detail) return;
    const membersAfter = detail.members.filter((m) => m.id !== memberId);
    const rolesAfter = uniqueRolesInOrder(membersAfter);
    const roleSet = new Set(rolesAfter);
    const nextEdges = pruneTopologyForRoles(topologyEdges, roleSet);
    const nextPos = pruneLayoutForRoles(nodePositions, roleSet);
    const layoutMeta = mergeLayoutWithRoles(rolesAfter, { type: "topology_canvas", nodePositions: nextPos });
    setTopologyMsg(null);
    setMemberBusy(true);
    try {
      await removeAgentGroupMember(analystAgentGroupId.trim(), memberId);
      await patchAgentGroup(analystAgentGroupId.trim(), {
        relationsJson: serializeRelationsPayload(
          { type: "topology_canvas", nodePositions: layoutMeta },
          nextEdges
        ) as never,
      });
      const d = await getAgentGroup(analystAgentGroupId.trim());
      applyGroupDetail(d);
      refreshGroups();
      setTopologyMsg("已移除成员并同步裁剪拓扑。");
    } catch (e) {
      setTopologyMsg(`移除失败：${(e as Error).message}`);
    } finally {
      setMemberBusy(false);
    }
  };

  const defInGroup = useCallback(
    (definitionId: string) => detail?.members.some((m) => m.definitionId === definitionId) ?? false,
    [detail]
  );

  return (
    <div style={{ padding: "4px 0 24px", maxWidth: 1100 }}>
      <p style={{ fontSize: 13, color: "var(--qb-team-meta, #a1a1aa)", marginBottom: 16, lineHeight: 1.55 }}>
        成员与编组来自<strong>配置中心已发布的 Agent 定义</strong>及 <code style={{ fontSize: 12 }}>agent_group</code>。
        在下方 <strong>Agent 池</strong>卡片上可「加入当前编组」；拓扑在 <strong>画布</strong>中编辑：<strong>单向</strong>为一条依赖边；
        <strong>广播</strong>为同一源并行指向多个接收方（运行期等价多条 from→to 边）。保存后写入{" "}
        <code style={{ fontSize: 12 }}>relations_json</code>。
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
            <button type="button" className="qb-btn-secondary" style={{ fontSize: 12 }} onClick={() => void saveTopology()} disabled={savingTopo || memberBusy}>
              {savingTopo ? "保存中…" : "保存研究组拓扑"}
            </button>
          </div>
          {topologyMsg ? (
            <div style={{ fontSize: 12, color: "var(--qb-agent-draft-accent, #93c5fd)", marginBottom: 8 }}>{topologyMsg}</div>
          ) : null}
          {duplicateRoleInGroup ? (
            <div className="qb-callout qb-callout--warning" role="status" style={{ marginBottom: 10, fontSize: 12 }}>
              编组内存在<strong>相同角色</strong>的多条定义，画布与调度仅以「角色」为节点，可能无法区分二者。建议每个角色只保留一条成员。
            </div>
          ) : null}
          <div style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>{detail.group.description || "无描述"}</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-section-fg, #cbd5e1)", marginBottom: 6 }}>编组成员（可移除）</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {detail.members.map((m) => (
              <div key={m.id} style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>{m.definitionName}</div>
                <div style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginTop: 4 }}>{m.role}</div>
                <div style={{ fontSize: 10, color: "var(--qb-team-meta, #52525b)", marginTop: 4 }}>definition: {m.definitionId.slice(0, 8)}…</div>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 11, marginTop: 8, padding: "4px 8px" }}
                  disabled={memberBusy}
                  onClick={() => void handleRemoveMember(m.id)}
                >
                  移出编组
                </button>
              </div>
            ))}
          </div>

          {memberRolesOrdered.length > 0 ? (
            <div style={{ marginTop: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--qb-team-section-fg, #cbd5e1)", marginBottom: 8 }}>
                研究组通信拓扑（画布）
              </div>
              <div style={{ ...row, marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginRight: 6 }}>工具：</span>
                {(
                  [
                    ["select", "调整布局"],
                    ["unicast", "单向边"],
                    ["broadcast", "广播边"],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={drawMode === k ? "qb-btn-primary-brand" : "qb-btn-secondary"}
                    style={{ fontSize: 11, padding: "4px 10px" }}
                    onClick={() => setDrawMode(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <ResearchTopologyCanvas
                roles={memberRolesOrdered}
                positions={nodePositions}
                onPositionsChange={setNodePositions}
                edges={topologyEdges}
                onEdgesChange={setTopologyEdges}
                drawMode={drawMode}
              />
              <p style={{ fontSize: 11, color: "var(--qb-team-meta, #52525b)", marginTop: 8 }}>
                留空边集表示全员同波并行。单向边与广播边均参与分层调度；编辑后请点击「保存研究组拓扑」写入服务端。
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginTop: 12 }}>当前编组暂无成员，请从下方 Agent 池加入。</p>
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
                {list.map((b) => {
                  const inGroup = defInGroup(b.definition.id);
                  const slot = RESEARCH_TEAM_GROUP_POOL_ROLE_SET.has(b.definition.role);
                  return (
                    <div key={b.definition.id} style={card}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>{b.definition.name}</div>
                      <div style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginTop: 4 }}>{b.definition.role}</div>
                      <div style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginTop: 6, lineHeight: 1.4 }}>
                        {b.profile?.description?.trim() || "（无 profile 描述）"}
                      </div>
                      {slot && analystAgentGroupId.trim() && detail ? (
                        <button
                          type="button"
                          className={inGroup ? "qb-btn-secondary" : "qb-btn-primary-brand"}
                          style={{ fontSize: 11, marginTop: 10, width: "100%", padding: "6px 8px" }}
                          disabled={memberBusy || inGroup || !detail}
                          onClick={() => void handleAddToGroup(b.definition.id, b.definition.role)}
                          title={inGroup ? "已在当前编组" : "加入当前编组"}
                        >
                          {inGroup ? "已在编组" : "加入当前编组"}
                        </button>
                      ) : slot ? (
                        <p style={{ fontSize: 10, color: "var(--qb-team-meta, #71717a)", marginTop: 8 }}>请先选择上方编组</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      <h4 style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-team-section-fg, #e4e4e7)", margin: "20px 0 8px" }}>本次分析参与的研究团队槽位（按 Agent 定义勾选）</h4>
      <p style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>
        与左侧「团队成员」联动；可选 analyst_*（MSA）、research / backtest / risk* 等（辅助章节）。与上方编组取交集。
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {analystDefsSelectable.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>暂无已启用的研究团队槽位定义</span>
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
