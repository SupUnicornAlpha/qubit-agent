/**
 * 配置中心 → SKILLS → agent_skill 库：
 * 来源三分（网络 / 官方·个人编写 / Agent 归纳）、Monaco 编辑、审批、版本管理。
 */
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listSkillLibrary, patchAgentSkill } from "../../api/backend";
import type { AgentSkillRecord } from "../../api/types";
import { OriginBadge } from "../common/OriginBadge";
import { WorkspaceCodeEditor } from "../workspace/WorkspaceCodeEditor";
import {
  classifySkillOrigin,
  skillOriginBadgeKey,
  skillOriginBucket,
  SKILL_ORIGIN_BUCKET_LABEL,
  SKILL_ORIGIN_KIND_LABEL,
  type SkillOriginBucket,
} from "./skillOrigin";

type BucketFilter = "all" | SkillOriginBucket;

export const SkillsLibraryPanel: FC<{
  projectId: string;
}> = ({ projectId }) => {
  const [rows, setRows] = useState<AgentSkillRecord[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [bucket, setBucket] = useState<BucketFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentSkillRecord | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await listSkillLibrary(projectId, { includeArchived });
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [projectId, includeArchived]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((s) => {
        const kind = classifySkillOrigin(s);
        if (bucket !== "all" && skillOriginBucket(kind) !== bucket) return false;
        if (!needle) return true;
        return (
          s.name.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle) ||
          s.category.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (a.state === "pending_review" && b.state !== "pending_review") return -1;
        if (b.state === "pending_review" && a.state !== "pending_review") return 1;
        return a.name.localeCompare(b.name);
      });
  }, [rows, bucket, q]);

  const counts = useMemo(() => {
    const c = { all: rows.length, network: 0, authored: 0, agent: 0 };
    for (const s of rows) {
      c[skillOriginBucket(classifySkillOrigin(s))] += 1;
    }
    return c;
  }, [rows]);

  const applyPatch = async (
    id: string,
    patch: Parameters<typeof patchAgentSkill>[1]
  ) => {
    await patchAgentSkill(id, patch);
    await reload();
  };

  return (
    <section style={styles.shell} aria-labelledby="skills-library-title">
      <header style={styles.header}>
        <div>
          <h4 id="skills-library-title" style={styles.title}>
            Skill 库（来源 · 编辑 · 审批 · 版本）
          </h4>
          <p style={styles.hint}>
            三分来源：网络下载 / 官方与个人编写 / Agent 归纳（含演化）。
            pending_review 须审批后才进入召回；编辑使用 Monaco，保存时可升版。
          </p>
        </div>
        <div style={styles.headerActions}>
          <label style={styles.check}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            显示已归档
          </label>
          <button
            type="button"
            className="qb-btn-ghost qb-btn--compact"
            disabled={busy}
            onClick={() => void reload()}
          >
            {busy ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      <div style={styles.filters}>
        {(
          [
            ["all", `全部 (${counts.all})`],
            ["network", `${SKILL_ORIGIN_BUCKET_LABEL.network} (${counts.network})`],
            ["authored", `${SKILL_ORIGIN_BUCKET_LABEL.authored} (${counts.authored})`],
            ["agent", `${SKILL_ORIGIN_BUCKET_LABEL.agent} (${counts.agent})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={bucket === id ? "qb-btn-secondary qb-btn--compact" : "qb-btn-ghost qb-btn--compact"}
            onClick={() => setBucket(id)}
          >
            {label}
          </button>
        ))}
        <input
          style={styles.search}
          placeholder="搜索 name / 描述…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error ? <p style={styles.error}>{error}</p> : null}

      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr style={{ color: "var(--qb-main-meta)" }}>
              <th style={styles.th}>name</th>
              <th style={styles.th}>描述</th>
              <th style={styles.th}>来源</th>
              <th style={styles.th}>状态</th>
              <th style={styles.th}>version</th>
              <th style={styles.th}>使用 / 成功</th>
              <th style={styles.th}>最近</th>
              <th style={styles.th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                  {busy
                    ? "加载中…"
                    : "暂无匹配记录。等待 curator/evolver，或由官方 quant seed / 市场安装写入。"}
                </td>
              </tr>
            ) : (
              filtered.map((s) => {
                const kind = classifySkillOrigin(s);
                const reviewing = s.state === "pending_review";
                return (
                  <tr
                    key={s.id}
                    style={{
                      borderTop: "1px solid #27272a",
                      opacity: s.state === "archived" ? 0.55 : 1,
                    }}
                  >
                    <td style={{ ...styles.td, fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
                      {s.pinned ? "★ " : ""}
                      {s.name}
                    </td>
                    <td style={{ ...styles.td, maxWidth: 280 }}>
                      {s.description.length > 120 ? `${s.description.slice(0, 120)}…` : s.description}
                    </td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                      <OriginBadge
                        origin={skillOriginBadgeKey(kind)}
                        label={SKILL_ORIGIN_KIND_LABEL[kind]}
                        style={{ marginLeft: 0 }}
                      />
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        whiteSpace: "nowrap",
                        color: reviewing
                          ? "#f87171"
                          : s.state === "archived"
                            ? "var(--qb-main-meta)"
                            : "var(--qb-body-fg)",
                      }}
                    >
                      {s.state}
                    </td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap" }}>{s.version}</td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                      {s.useCount} / {s.successCount}
                      {s.failCount > 0 ? (
                        <span style={{ color: "#fca5a5" }}> · 败 {s.failCount}</span>
                      ) : null}
                    </td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap", color: "var(--qb-main-meta)" }}>
                      {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}
                    </td>
                    <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                      <button
                        type="button"
                        className="qb-btn-ghost qb-btn--compact"
                        onClick={() => setEditing(s)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="qb-btn-ghost qb-btn--compact"
                        onClick={() => void applyPatch(s.id, { pinned: !s.pinned })}
                      >
                        {s.pinned ? "取消置顶" : "置顶"}
                      </button>
                      {reviewing ? (
                        <>
                          <button
                            type="button"
                            className="qb-btn-secondary qb-btn--compact"
                            onClick={() => void applyPatch(s.id, { state: "active" })}
                          >
                            审批通过
                          </button>
                          <button
                            type="button"
                            className="qb-btn-ghost qb-btn--compact"
                            onClick={() => void applyPatch(s.id, { state: "archived" })}
                          >
                            驳回归档
                          </button>
                        </>
                      ) : null}
                      {s.state !== "archived" ? (
                        <button
                          type="button"
                          className="qb-btn-ghost qb-btn--compact"
                          onClick={() => void applyPatch(s.id, { state: "archived" })}
                        >
                          归档
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="qb-btn-ghost qb-btn--compact"
                          onClick={() => void applyPatch(s.id, { state: "active" })}
                        >
                          恢复
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <SkillEditorDialog
          skill={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      ) : null}
    </section>
  );
};

const SkillEditorDialog: FC<{
  skill: AgentSkillRecord;
  onClose: () => void;
  onSaved: () => Promise<void>;
}> = ({ skill, onClose, onSaved }) => {
  const kind = classifySkillOrigin(skill);
  const [description, setDescription] = useState(skill.description);
  const [bodyMd, setBodyMd] = useState(skill.bodyMd || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty =
    description !== skill.description || bodyMd !== (skill.bodyMd || "");

  const save = async (bumpVersion: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      await patchAgentSkill(skill.id, {
        description: description.trim() || skill.description,
        bodyMd,
        bumpVersion,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={styles.modalBackdrop} role="dialog" aria-modal="true" aria-label="编辑 Skill">
      <div style={styles.modal}>
        <header style={styles.modalHeader}>
          <div>
            <div style={styles.modalTitle}>
              {skill.name}{" "}
              <span style={{ color: "var(--qb-main-meta)", fontWeight: 400 }}>· {skill.version}</span>
            </div>
            <div style={styles.modalMeta}>
              <OriginBadge
                origin={skillOriginBadgeKey(kind)}
                label={SKILL_ORIGIN_KIND_LABEL[kind]}
                style={{ marginLeft: 0 }}
              />
              <span style={{ marginLeft: 8, color: "var(--qb-main-meta)" }}>{skill.state}</span>
            </div>
          </div>
          <button type="button" className="qb-btn-ghost qb-btn--compact" onClick={onClose}>
            关闭
          </button>
        </header>

        <label style={styles.fieldLabel}>
          描述
          <input
            style={styles.descInput}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div style={styles.editorWrap}>
          <WorkspaceCodeEditor
            value={bodyMd}
            onChange={setBodyMd}
            path={`${skill.name}.md`}
          />
        </div>

        {err ? <p style={styles.error}>{err}</p> : null}

        <footer style={styles.modalFooter}>
          <span style={{ fontSize: 12, color: "var(--qb-main-meta)" }}>
            {dirty ? "有未保存修改" : "无修改"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              disabled={saving}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className="qb-btn-secondary qb-btn--compact"
              disabled={saving || !dirty}
              onClick={() => void save(false)}
            >
              保存
            </button>
            <button
              type="button"
              className="qb-btn-secondary qb-btn--compact"
              disabled={saving || !dirty}
              onClick={() => void save(true)}
              title="写入正文并 bump semver（minor）"
            >
              保存并升版
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  shell: { marginTop: 20 },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  title: { fontSize: 14, margin: "0 0 4px", color: "var(--qb-body-fg)" },
  hint: { margin: 0, fontSize: 12, color: "var(--qb-main-meta)", maxWidth: 720, lineHeight: 1.45 },
  headerActions: { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  check: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--qb-main-meta)",
  },
  filters: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    marginBottom: 10,
  },
  search: {
    minWidth: 180,
    flex: "1 1 160px",
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "var(--qb-body-fg)",
    fontSize: 12,
  },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { padding: "6px 8px", textAlign: "left", fontWeight: 500 },
  td: { padding: "8px", color: "var(--qb-body-fg)", verticalAlign: "top" },
  error: { color: "#fca5a5", fontSize: 12, margin: "8px 0" },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 80,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modal: {
    width: "min(960px, 96vw)",
    height: "min(820px, 92vh)",
    background: "#0f0f12",
    border: "1px solid #3f3f46",
    borderRadius: 10,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 24px 64px rgba(0,0,0,0.45)",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    padding: "14px 16px",
    borderBottom: "1px solid #27272a",
    flexShrink: 0,
  },
  modalTitle: { fontSize: 15, fontWeight: 600, color: "var(--qb-body-fg)" },
  modalMeta: { marginTop: 6, display: "flex", alignItems: "center", fontSize: 12 },
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 16px 0",
    fontSize: 12,
    color: "var(--qb-main-meta)",
    flexShrink: 0,
  },
  descInput: {
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "var(--qb-body-fg)",
    fontSize: 13,
  },
  editorWrap: {
    flex: 1,
    minHeight: 0,
    padding: "10px 16px",
    display: "flex",
    flexDirection: "column",
  },
  modalFooter: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderTop: "1px solid #27272a",
    flexShrink: 0,
  },
};
