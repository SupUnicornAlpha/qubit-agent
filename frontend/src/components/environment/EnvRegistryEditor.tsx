/**
 * EnvRegistryEditor —— Tab 2「期望清单」编辑器。
 *
 * 业务规则（与后端 registry-service 一致）：
 *   - is_builtin=true 行：仅可改 status / userVersionSpec；displayName /
 *     description / capability 后端会忽略（防止用户改坏 system 项再 seed
 *     回写）—— UI 上对应的输入框灰显。
 *   - 用户自建项：CRUD 完全开放。
 *   - 删除按钮仅对 is_builtin=false 显示。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EnvKind,
  type ExpectedPackage,
  createEnvRegistryItem,
  deleteEnvRegistryItem,
  listEnvRegistry,
  patchEnvRegistryItem,
} from "../../api/backend";
import {
  baseTable,
  card,
  code,
  row,
  STATUS_COLOR,
  tableHeaderRow,
  tableTd,
  tableTh,
  tableTrBordered,
} from "./styles";

interface EditDraft {
  status?: "enabled" | "disabled";
  userVersionSpec?: string | null;
  displayName?: string;
  description?: string;
  optional?: boolean;
  capability?: string;
}

interface CreateDraft {
  kind: EnvKind;
  packageName: string;
  displayName: string;
  description: string;
  versionSpec: string;
  optional: boolean;
  capability: string;
}

const EMPTY_CREATE: CreateDraft = {
  kind: "python",
  packageName: "",
  displayName: "",
  description: "",
  versionSpec: "",
  optional: true,
  capability: "user/misc",
};

export function EnvRegistryEditor() {
  const [items, setItems] = useState<ExpectedPackage[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [creating, setCreating] = useState<CreateDraft>(EMPTY_CREATE);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setItems(await listEnvRegistry());
      setDrafts({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pythonItems = useMemo(() => items.filter((it) => it.kind === "python"), [items]);
  const npmItems = useMemo(() => items.filter((it) => it.kind === "npm"), [items]);

  const updateDraft = (id: string, patch: Partial<EditDraft>) =>
    setDrafts((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  const isDirty = (id: string) => Boolean(drafts[id] && Object.keys(drafts[id]).length > 0);

  const onSave = async (id: string) => {
    const patch = drafts[id];
    if (!patch) return;
    try {
      await patchEnvRegistryItem(id, patch);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("确定删除此用户项？此操作无法撤销。")) return;
    try {
      await deleteEnvRegistryItem(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const onCreate = async () => {
    if (!creating.packageName.trim() || !creating.displayName.trim()) {
      setErr("packageName / displayName 必填");
      return;
    }
    try {
      await createEnvRegistryItem({
        kind: creating.kind,
        packageName: creating.packageName.trim(),
        displayName: creating.displayName.trim(),
        description: creating.description.trim(),
        versionSpec: creating.versionSpec.trim() || null,
        optional: creating.optional,
        capability: creating.capability.trim() || "user/misc",
      });
      setCreating(EMPTY_CREATE);
      setCreateOpen(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div>
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>期望清单</strong>
        <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
          系统项可改 status / 版本约束；用户项可全字段编辑或删除。
        </span>
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          onClick={() => void refresh()}
          disabled={busy}
          style={{ marginLeft: "auto" }}
        >
          {busy ? "刷新中…" : "刷新"}
        </button>
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          onClick={() => setCreateOpen((v) => !v)}
        >
          {createOpen ? "取消新增" : "新增用户项"}
        </button>
      </div>

      {err ? (
        <div
          style={{
            ...card,
            background: "rgba(239,68,68,0.08)",
            color: STATUS_COLOR.red,
          }}
        >
          {err}
        </div>
      ) : null}

      {createOpen ? (
        <div style={card}>
          <strong style={{ fontSize: 13 }}>新增用户项</strong>
          <div style={{ ...row, marginTop: 8, gap: 12 }}>
            <label>
              kind:&nbsp;
              <select
                value={creating.kind}
                onChange={(e) =>
                  setCreating((s) => ({ ...s, kind: e.target.value as EnvKind }))
                }
              >
                <option value="python">python</option>
                <option value="npm">npm</option>
              </select>
            </label>
            <input
              placeholder="packageName (如 scipy)"
              value={creating.packageName}
              onChange={(e) =>
                setCreating((s) => ({ ...s, packageName: e.target.value }))
              }
            />
            <input
              placeholder="displayName"
              value={creating.displayName}
              onChange={(e) =>
                setCreating((s) => ({ ...s, displayName: e.target.value }))
              }
            />
            <input
              placeholder=">=1.13"
              value={creating.versionSpec}
              onChange={(e) =>
                setCreating((s) => ({ ...s, versionSpec: e.target.value }))
              }
              style={{ width: 120 }}
            />
            <input
              placeholder="capability"
              value={creating.capability}
              onChange={(e) =>
                setCreating((s) => ({ ...s, capability: e.target.value }))
              }
              style={{ width: 160 }}
            />
            <label style={{ fontSize: 12 }}>
              <input
                type="checkbox"
                checked={creating.optional}
                onChange={(e) =>
                  setCreating((s) => ({ ...s, optional: e.target.checked }))
                }
              />
              &nbsp;optional
            </label>
            <button
              type="button"
              className="qb-btn-ghost qb-btn--compact"
              onClick={() => void onCreate()}
            >
              保存
            </button>
          </div>
          <input
            placeholder="description（可选）"
            value={creating.description}
            onChange={(e) =>
              setCreating((s) => ({ ...s, description: e.target.value }))
            }
            style={{ width: "100%", marginTop: 8 }}
          />
        </div>
      ) : null}

      <RegistryTable
        title="Python (pip)"
        items={pythonItems}
        isDirty={isDirty}
        updateDraft={updateDraft}
        onSave={onSave}
        onDelete={onDelete}
      />
      <RegistryTable
        title="MCP npm"
        items={npmItems}
        isDirty={isDirty}
        updateDraft={updateDraft}
        onSave={onSave}
        onDelete={onDelete}
      />
    </div>
  );
}

function RegistryTable({
  title,
  items,
  isDirty,
  updateDraft,
  onSave,
  onDelete,
}: {
  title: string;
  items: ExpectedPackage[];
  /** drafts 状态在父组件维护；行内通过 isDirty / updateDraft 间接消费即可 */
  isDirty: (id: string) => boolean;
  updateDraft: (id: string, p: Partial<EditDraft>) => void;
  onSave: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (items.length === 0)
    return (
      <div style={card}>
        <strong style={{ fontSize: 13 }}>{title}</strong>
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--qb-main-meta)" }}>
          暂无任何期望项。
        </p>
      </div>
    );
  return (
    <div style={card}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <table style={{ ...baseTable, marginTop: 8 }}>
        <thead>
          <tr style={tableHeaderRow}>
            <th style={tableTh}>包名</th>
            <th style={tableTh}>展示名</th>
            <th style={tableTh}>系统版本</th>
            <th style={tableTh}>用户覆写</th>
            <th style={tableTh}>必需</th>
            <th style={tableTh}>启用</th>
            <th style={tableTh}>来源</th>
            <th style={tableTh}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            // drafts[it.id] 通过 isDirty(it.id) / updateDraft 间接消费，不需要在
            // row 级别显式 destructure；defaultValue 方式让 input 不受控。
            const builtin = it.isBuiltin;
            return (
              <tr key={it.id} style={tableTrBordered}>
                <td style={{ ...tableTd, fontFamily: "ui-monospace, monospace" }}>
                  {it.name}
                  {builtin ? (
                    <span
                      style={{
                        marginLeft: 4,
                        fontSize: 10,
                        color: "var(--qb-main-meta)",
                      }}
                    >
                      [系统]
                    </span>
                  ) : null}
                </td>
                <td style={tableTd}>
                  {builtin ? (
                    <span style={{ color: "var(--qb-main-meta)" }}>{it.displayName}</span>
                  ) : (
                    <input
                      defaultValue={it.displayName}
                      onChange={(e) => updateDraft(it.id, { displayName: e.target.value })}
                      style={{ width: 140 }}
                    />
                  )}
                </td>
                <td style={tableTd}>
                  <span style={code}>{it.versionSpec ?? "—"}</span>
                </td>
                <td style={tableTd}>
                  <input
                    defaultValue={it.userVersionSpec ?? ""}
                    placeholder=">= 等"
                    onChange={(e) =>
                      updateDraft(it.id, { userVersionSpec: e.target.value || null })
                    }
                    style={{ width: 100 }}
                  />
                </td>
                <td style={tableTd}>
                  {builtin ? (
                    <span style={{ color: "var(--qb-main-meta)" }}>
                      {it.optional ? "否" : "是"}
                    </span>
                  ) : (
                    <input
                      type="checkbox"
                      defaultChecked={!it.optional}
                      onChange={(e) =>
                        updateDraft(it.id, { optional: !e.target.checked })
                      }
                    />
                  )}
                </td>
                <td style={tableTd}>
                  <input
                    type="checkbox"
                    defaultChecked={it.status === "enabled"}
                    onChange={(e) =>
                      updateDraft(it.id, {
                        status: e.target.checked ? "enabled" : "disabled",
                      })
                    }
                  />
                </td>
                <td style={{ ...tableTd, color: "var(--qb-main-meta)", fontSize: 11 }}>
                  {it.source}
                </td>
                <td style={{ ...tableTd, whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="qb-btn-ghost qb-btn--compact"
                    disabled={!isDirty(it.id)}
                    onClick={() => void onSave(it.id)}
                  >
                    保存
                  </button>
                  {!builtin ? (
                    <button
                      type="button"
                      className="qb-btn-ghost qb-btn--compact"
                      onClick={() => void onDelete(it.id)}
                      style={{ marginLeft: 6 }}
                    >
                      删除
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
