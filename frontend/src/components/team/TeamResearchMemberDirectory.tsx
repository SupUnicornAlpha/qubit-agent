import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addAgentGroupMember,
  createAgentGroup,
  deleteAgentGroup,
  getAgentGroup,
  listAgentGroups,
  patchAgentGroup,
  removeAgentGroupMember,
} from "../../api/backend";
import type { AgentDefinitionBundle, AgentGroupDetail, AgentGroupRecord } from "../../api/types";
import { useTranslation } from "../../i18n";
import { RESEARCH_TEAM_GROUP_POOL_ROLE_SET } from "../../lib/researchTeamRoles";
import {
  type TeamTopologyEdge,
  type TopologyCanvasMeta,
  mergeLayoutWithRoles,
  parseRelationsFull,
  pruneLayoutForRoles,
  pruneTopologyForRoles,
  serializeRelationsPayload,
} from "../../lib/researchTeamTopology";
import { ResearchTopologyCanvas, type TopologyDrawMode } from "./ResearchTopologyCanvas";

const BUCKET: Record<string, { i18nKey: string; color: string }> = {
  analyst: { i18nKey: "team.members.bucket.analyst", color: "#3b82f6" },
  researcher: { i18nKey: "team.members.bucket.researcher", color: "#8b5cf6" },
  risk: { i18nKey: "team.members.bucket.risk", color: "#ef4444" },
  portfolio: { i18nKey: "team.members.bucket.portfolio", color: "#f59e0b" },
  execution: { i18nKey: "team.members.bucket.execution", color: "#10b981" },
  orchestration: { i18nKey: "team.members.bucket.orchestration", color: "#14b8a6" },
  ops: { i18nKey: "team.members.bucket.ops", color: "#6b7280" },
};

function bucketKey(role: string): keyof typeof BUCKET {
  if (role.startsWith("analyst_")) return "analyst";
  if (role.includes("researcher")) return "researcher";
  if (role === "research" || role === "backtest" || role === "backtest_engineer")
    return "researcher";
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
}> = ({
  analystAgentGroupId,
  setAnalystAgentGroupId,
  analystAgentGroupOptions,
  setAnalystAgentGroupOptions,
  agentDefBundles,
}) => {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<AgentGroupDetail | null>(null);
  const [topologyEdges, setTopologyEdges] = useState<TeamTopologyEdge[]>([]);
  const [nodePositions, setNodePositions] = useState<Record<string, { x: number; y: number }>>({});
  const [drawMode, setDrawMode] = useState<TopologyDrawMode>("select");
  const [topologyMsg, setTopologyMsg] = useState<string | null>(null);
  const [savingTopo, setSavingTopo] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [groupOpBusy, setGroupOpBusy] = useState(false);
  /** 二次确认的目标编组 id；为空表示无待确认。4s 内未确认自动取消。 */
  const [pendingDeleteGroupId, setPendingDeleteGroupId] = useState<string | null>(null);
  /** 新建编组的内联输入框（null 表示折叠） */
  const [creatingGroupName, setCreatingGroupName] = useState<string | null>(null);

  // pendingDelete 4 秒自动撤销，避免按钮"卡红"
  useEffect(() => {
    if (!pendingDeleteGroupId) return;
    const timer = window.setTimeout(() => setPendingDeleteGroupId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [pendingDeleteGroupId]);

  const refreshGroups = useCallback(() => {
    void listAgentGroups()
      .then(setAnalystAgentGroupOptions)
      .catch(() => setAnalystAgentGroupOptions([]));
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
      const layoutMeta = mergeLayoutWithRoles(roles, {
        type: "topology_canvas",
        nodePositions: prunedPos,
      });
      const meta: TopologyCanvasMeta = { type: "topology_canvas", nodePositions: layoutMeta };
      await patchAgentGroup(analystAgentGroupId.trim(), {
        relationsJson: serializeRelationsPayload(meta, prunedEdges) as never,
      });
      setTopologyEdges(prunedEdges);
      setNodePositions(mergeLayoutWithRoles(roles, meta));
      setTopologyMsg(t("team.members.msgs.saveSuccess"));
      refreshGroups();
      const d = await getAgentGroup(analystAgentGroupId.trim());
      applyGroupDetail(d);
    } catch (e) {
      setTopologyMsg(t("team.members.msgs.saveFailed", { err: (e as Error).message }));
    } finally {
      setSavingTopo(false);
    }
  };

  const handleAddToGroup = async (definitionId: string, role: string) => {
    if (!analystAgentGroupId.trim() || !detail) return;
    if (detail.members.some((m) => m.role === role)) {
      setTopologyMsg(t("team.members.msgs.duplicateRole", { role }));
      return;
    }
    setTopologyMsg(null);
    setMemberBusy(true);
    try {
      const nextOrder =
        detail.members.length === 0
          ? 0
          : Math.max(...detail.members.map((m) => m.sortOrder), 0) + 1;
      await addAgentGroupMember(analystAgentGroupId.trim(), { definitionId, sortOrder: nextOrder });
      const d = await getAgentGroup(analystAgentGroupId.trim());
      applyGroupDetail(d);
      refreshGroups();
      setTopologyMsg(t("team.members.msgs.joined"));
    } catch (e) {
      setTopologyMsg(t("team.members.msgs.joinFailed", { err: (e as Error).message }));
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
    const layoutMeta = mergeLayoutWithRoles(rolesAfter, {
      type: "topology_canvas",
      nodePositions: nextPos,
    });
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
      setTopologyMsg(t("team.members.msgs.removed"));
    } catch (e) {
      setTopologyMsg(t("team.members.msgs.removeFailed", { err: (e as Error).message }));
    } finally {
      setMemberBusy(false);
    }
  };

  const defInGroup = useCallback(
    (definitionId: string) => detail?.members.some((m) => m.definitionId === definitionId) ?? false,
    [detail]
  );

  const submitCreateGroup = async () => {
    const name = (creatingGroupName ?? "").trim();
    if (!name) {
      setTopologyMsg(t("team.members.msgs.groupNameRequired"));
      return;
    }
    setTopologyMsg(null);
    setGroupOpBusy(true);
    try {
      const created = await createAgentGroup({ name });
      const rows = await listAgentGroups();
      setAnalystAgentGroupOptions(rows);
      setAnalystAgentGroupId(created.id);
      setCreatingGroupName(null);
      setTopologyMsg(t("team.members.msgs.groupCreated", { name: created.name }));
    } catch (e) {
      setTopologyMsg(t("team.members.msgs.createFailed", { err: (e as Error).message }));
    } finally {
      setGroupOpBusy(false);
    }
  };

  const performDeleteGroup = async (groupId: string, groupName: string) => {
    setPendingDeleteGroupId(null);
    setTopologyMsg(null);
    setGroupOpBusy(true);
    try {
      await deleteAgentGroup(groupId);
      const rows = await listAgentGroups();
      setAnalystAgentGroupOptions(rows);
      if (groupId === analystAgentGroupId) {
        setAnalystAgentGroupId("");
        setDetail(null);
        setTopologyEdges([]);
        setNodePositions({});
      }
      setTopologyMsg(t("team.members.msgs.groupDeleted", { name: groupName }));
    } catch (e) {
      setTopologyMsg(t("team.members.msgs.deleteFailed", { err: (e as Error).message }));
    } finally {
      setGroupOpBusy(false);
    }
  };

  const handleClickDelete = (groupId: string, groupName: string) => {
    if (pendingDeleteGroupId === groupId) {
      void performDeleteGroup(groupId, groupName);
    } else {
      setPendingDeleteGroupId(groupId);
      setTopologyMsg(t("team.members.msgs.pendingDelete", { name: groupName }));
    }
  };

  return (
    <div style={{ padding: "4px 0 24px", maxWidth: 1100 }}>
      <p
        style={{
          fontSize: 13,
          color: "var(--qb-team-meta, #a1a1aa)",
          marginBottom: 16,
          lineHeight: 1.55,
        }}
      >
        {t("team.members.intro.beforeSourceStrong")}
        <strong>{t("team.members.intro.sourceStrong")}</strong>
        {t("team.members.intro.beforeSourceCode")}
        <code style={{ fontSize: 12 }}>{t("team.members.intro.sourceCode")}</code>
        {t("team.members.intro.edgeSemantics")}
        <strong>{t("team.members.intro.edgeSemanticsStrong")}</strong>
        {t("team.members.intro.beforeRecommendStrong")}
        <strong>{t("team.members.intro.recommendStrong")}</strong>
        {t("team.members.intro.recommendBody")}
        <code>{t("team.members.intro.recommendCode")}</code>
        {t("team.members.intro.recommendTail")}
        <code style={{ fontSize: 12 }}>{t("team.members.intro.recommendTailCode")}</code>
        {t("team.members.intro.recommendDone")}
      </p>

      <h4
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--qb-team-section-fg, #e4e4e7)",
          margin: "0 0 8px",
        }}
      >
        {t("team.members.sectionGroups")}
      </h4>
      <div style={{ ...row, marginBottom: 16 }}>
        {analystAgentGroupOptions.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>
            {t("team.members.emptyGroups")}
          </span>
        ) : (
          analystAgentGroupOptions.map((g) => {
            const active = g.id === analystAgentGroupId;
            const pendingDelete = pendingDeleteGroupId === g.id;
            return (
              <span
                key={g.id}
                style={{
                  display: "inline-flex",
                  alignItems: "stretch",
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <button
                  type="button"
                  className={active ? "qb-btn-primary-brand" : "qb-btn-secondary"}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                  }}
                  disabled={groupOpBusy}
                  onClick={() => {
                    setPendingDeleteGroupId(null);
                    setAnalystAgentGroupId(g.id);
                  }}
                >
                  {g.name}
                  {typeof g.memberCount === "number"
                    ? t("team.members.memberCountSuffix", { n: g.memberCount })
                    : ""}
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  title={
                    pendingDelete
                      ? t("team.members.deletePendingTitle", { name: g.name })
                      : t("team.members.deleteTitle", { name: g.name })
                  }
                  aria-label={t("team.members.deleteAriaLabel", { name: g.name })}
                  style={{
                    fontSize: 12,
                    padding: "6px 8px",
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    borderLeft: "1px solid var(--qb-main-card-border, #27272a)",
                    color: pendingDelete ? "#fff" : "var(--qb-danger-fg, #f87171)",
                    background: pendingDelete
                      ? "var(--qb-danger-bg, #b91c1c)"
                      : undefined,
                    fontWeight: pendingDelete ? 700 : undefined,
                  }}
                  disabled={groupOpBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClickDelete(g.id, g.name);
                  }}
                >
                  {pendingDelete ? t("team.members.deleteConfirmAgain") : "×"}
                </button>
              </span>
            );
          })
        )}
        {creatingGroupName === null ? (
          <button
            type="button"
            className="qb-btn-primary-brand"
            style={{ fontSize: 12, padding: "6px 12px" }}
            disabled={groupOpBusy}
            onClick={() => {
              setPendingDeleteGroupId(null);
              setTopologyMsg(null);
              setCreatingGroupName("");
            }}
          >
            {t("team.members.newGroup")}
          </button>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "stretch",
              borderRadius: 6,
              overflow: "hidden",
              border: "1px solid var(--qb-main-card-border, #27272a)",
            }}
          >
            <input
              type="text"
              value={creatingGroupName}
              autoFocus
              disabled={groupOpBusy}
              placeholder={t("team.members.newGroupNamePlaceholder")}
              onChange={(e) => setCreatingGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitCreateGroup();
                } else if (e.key === "Escape") {
                  setCreatingGroupName(null);
                }
              }}
              style={{
                fontSize: 12,
                padding: "6px 10px",
                background: "var(--qb-main-card-bg, #18181b)",
                color: "var(--qb-body-fg, #e4e4e7)",
                border: "none",
                outline: "none",
                minWidth: 160,
              }}
            />
            <button
              type="button"
              className="qb-btn-primary-brand"
              style={{ fontSize: 12, padding: "6px 12px", borderRadius: 0 }}
              disabled={groupOpBusy || !creatingGroupName.trim()}
              onClick={() => void submitCreateGroup()}
            >
              {t("team.members.saveBtn")}
            </button>
            <button
              type="button"
              className="qb-btn-secondary"
              style={{ fontSize: 12, padding: "6px 10px", borderRadius: 0 }}
              disabled={groupOpBusy}
              onClick={() => setCreatingGroupName(null)}
            >
              {t("team.members.cancelBtn")}
            </button>
          </span>
        )}
      </div>

      {detail ? (
        <div style={{ marginBottom: 20 }}>
          <div style={{ ...row, marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #fafafa)" }}>
              {detail.group.name}
            </span>
            <button
              type="button"
              className="qb-btn-secondary"
              style={{ fontSize: 12 }}
              onClick={() => void saveTopology()}
              disabled={savingTopo || memberBusy}
            >
              {savingTopo ? t("team.members.savingTopology") : t("team.members.saveTopology")}
            </button>
          </div>
          {topologyMsg ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--qb-agent-draft-accent, #93c5fd)",
                marginBottom: 8,
              }}
            >
              {topologyMsg}
            </div>
          ) : null}
          {duplicateRoleInGroup ? (
            <output
              className="qb-callout qb-callout--warning"
              style={{ marginBottom: 10, fontSize: 12 }}
            >
              {t("team.members.duplicateRolePrefix")}
              <strong>{t("team.members.duplicateRoleStrong")}</strong>
              {t("team.members.duplicateRoleSuffix")}
            </output>
          ) : null}
          <div style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginBottom: 8 }}>
            {detail.group.description || t("team.members.emptyDescription")}
          </div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--qb-team-section-fg, #cbd5e1)",
              marginBottom: 6,
            }}
          >
            {t("team.members.sectionMembers")}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
            }}
          >
            {detail.members.map((m) => (
              <div key={m.id} style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--qb-body-fg, #e4e4e7)" }}>
                  {m.definitionName}
                </div>
                <div style={{ fontSize: 11, color: "var(--qb-team-meta, #71717a)", marginTop: 4 }}>
                  {m.role}
                </div>
                <div style={{ fontSize: 10, color: "var(--qb-team-meta, #52525b)", marginTop: 4 }}>
                  {t("team.members.definitionPrefix", { id: m.definitionId.slice(0, 8) })}
                </div>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  style={{ fontSize: 11, marginTop: 8, padding: "4px 8px" }}
                  disabled={memberBusy}
                  onClick={() => void handleRemoveMember(m.id)}
                >
                  {t("team.members.removeMember")}
                </button>
              </div>
            ))}
          </div>

          {memberRolesOrdered.length > 0 ? (
            <div style={{ marginTop: 22 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--qb-team-section-fg, #cbd5e1)",
                  marginBottom: 8,
                }}
              >
                {t("team.members.sectionTopology")}
              </div>
              <div style={{ ...row, marginBottom: 10 }}>
                <span
                  style={{ fontSize: 11, color: "var(--qb-team-meta, #a1a1aa)", marginRight: 6 }}
                >
                  {t("team.members.toolsLabel")}
                </span>
                {(
                  [
                    ["select", t("team.members.toolSelect")],
                    ["unicast", t("team.members.toolUnicast")],
                    ["broadcast", t("team.members.toolBroadcast")],
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
                {t("team.members.topologyHint")}
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginTop: 12 }}>
              {t("team.members.emptyMembers")}
            </p>
          )}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)", marginBottom: 16 }}>
          {t("team.members.selectGroupHint")}
        </p>
      )}

      <h4
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--qb-team-section-fg, #e4e4e7)",
          margin: "20px 0 8px",
        }}
      >
        {t("team.members.sectionPool")}
      </h4>
      {agentDefBundles === null ? (
        <div style={{ fontSize: 12, color: "var(--qb-team-meta, #71717a)" }}>
          {t("team.members.loadingDefs")}
        </div>
      ) : (
        (Object.keys(BUCKET) as Array<keyof typeof BUCKET>).map((bk) => {
          const list = poolByBucket.get(bk) ?? [];
          if (list.length === 0) return null;
          const meta = BUCKET[bk];
          return (
            <div key={bk} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: meta.color, marginBottom: 6 }}>
                {t("team.members.bucketCount", { label: t(meta.i18nKey), n: list.length })}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: 8,
                }}
              >
                {list.map((b) => {
                  const inGroup = defInGroup(b.definition.id);
                  const slot = RESEARCH_TEAM_GROUP_POOL_ROLE_SET.has(b.definition.role);
                  return (
                    <div key={b.definition.id} style={card}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: "var(--qb-body-fg, #e4e4e7)",
                        }}
                      >
                        {b.definition.name}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--qb-team-meta, #71717a)",
                          marginTop: 4,
                        }}
                      >
                        {b.definition.role}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--qb-team-meta, #a1a1aa)",
                          marginTop: 6,
                          lineHeight: 1.4,
                        }}
                      >
                        {b.profile?.description?.trim() || t("team.members.emptyProfileDescription")}
                      </div>
                      {slot && analystAgentGroupId.trim() && detail ? (
                        <button
                          type="button"
                          className={inGroup ? "qb-btn-secondary" : "qb-btn-primary-brand"}
                          style={{ fontSize: 11, marginTop: 10, width: "100%", padding: "6px 8px" }}
                          disabled={memberBusy || inGroup || !detail}
                          onClick={() => void handleAddToGroup(b.definition.id, b.definition.role)}
                          title={inGroup ? t("team.members.alreadyInGroupTitle") : t("team.members.joinTitle")}
                        >
                          {inGroup ? t("team.members.alreadyInGroup") : t("team.members.addToGroup")}
                        </button>
                      ) : slot ? (
                        <p
                          style={{
                            fontSize: 10,
                            color: "var(--qb-team-meta, #71717a)",
                            marginTop: 8,
                          }}
                        >
                          {t("team.members.selectGroupFirst")}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {/**
       * 注：原「本次分析参与的研究团队槽位（按 Agent 定义勾选）」已删除。
       * 画布上的 Agent 节点直接由上方编组（analystAgentGroupId）决定，
       * `participatingAnalystDefinitionIds` 不再有 UI 入口（始终为 []）。
       * 后端在 analystDefinitionIds=undefined 时按 agentGroupId 解析槽位 →
       * 默认 fallback 为全部启用的研究团队槽位定义。
       */}
    </div>
  );
};
