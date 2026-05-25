/**
 * LlmProvidersList — M10.B3
 *
 * 配置中心 / LLM 模型页的多 provider CRUD 列表。
 *
 * 设计：
 * - 顶部"默认/降级模型"卡片复用现有 saveModelConfig（写 .qubit/model.json）
 * - 下面是 provider 列表（来自 /api/v1/llm-providers）
 * - 每行支持：内联「编辑」表单（modelName/baseUrl/providerType/apiKey/contextWindow/...）
 * - 删除走 2 步内联确认；Tauri Webview 屏蔽 prompt()/confirm()，因此一律不依赖原生弹窗
 * - apiKey 输入框默认 password 类型，提交后立即清空（前端不缓存）
 */

import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { httpGet, httpPost, httpPatch, httpDelete } from "../../api/client";

type ProviderType = "openai" | "anthropic" | "ollama" | "custom";

interface ProviderRow {
  id: string;
  providerId: string;
  providerType: ProviderType;
  modelName: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  apiKeyConfigured: boolean;
  contextWindow: number;
  supportsFunctionCalling: boolean;
  enabled: boolean;
  createdAt: string;
}

interface EditForm {
  providerType: ProviderType;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  supportsFunctionCalling: boolean;
}

interface DefaultInfo {
  source: "agent_db" | "agent_inline" | "default" | "mock";
  provider: string;
  model: string;
  apiKeyConfigured: boolean;
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "8px 0",
  },
  card: {
    border: "1px solid var(--qb-border)",
    borderRadius: 10,
    padding: 16,
    background: "var(--qb-card-bg, transparent)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
    color: "var(--qb-body-fg)",
  },
  cardHint: {
    fontSize: 12,
    margin: 0,
    color: "var(--qb-muted-fg)",
    lineHeight: 1.6,
  },
  formRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
  },
  input: {
    minWidth: 160,
    padding: "6px 10px",
    fontSize: 13,
    border: "1px solid var(--qb-border)",
    borderRadius: 6,
    background: "var(--qb-input-bg, transparent)",
    color: "var(--qb-body-fg)",
  },
  select: {
    padding: "6px 10px",
    fontSize: 13,
    border: "1px solid var(--qb-border)",
    borderRadius: 6,
    background: "var(--qb-input-bg, transparent)",
    color: "var(--qb-body-fg)",
  },
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    fontSize: 11,
    borderRadius: 4,
    fontWeight: 500,
  },
  badgeOk: {
    background: "rgba(54, 211, 153, 0.18)",
    color: "rgb(54, 211, 153)",
    border: "1px solid rgba(54, 211, 153, 0.35)",
  },
  badgeWarn: {
    background: "rgba(255, 184, 28, 0.18)",
    color: "rgb(255, 184, 28)",
    border: "1px solid rgba(255, 184, 28, 0.35)",
  },
  badgeDisabled: {
    background: "rgba(180, 180, 180, 0.15)",
    color: "var(--qb-muted-fg)",
    border: "1px solid var(--qb-border)",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 110px 120px 240px",
    gap: 8,
    padding: "8px",
    fontSize: 13,
    alignItems: "center",
    borderBottom: "1px solid var(--qb-border-subtle, rgba(255,255,255,0.04))",
  },
  tableHead: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 110px 120px 240px",
    gap: 8,
    padding: "6px 8px",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--qb-muted-fg)",
    borderBottom: "1px solid var(--qb-border)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  editPanel: {
    padding: "12px",
    background: "var(--qb-tint, rgba(99,102,241,0.06))",
    border: "1px solid var(--qb-border)",
    borderRadius: 8,
    margin: "4px 0 12px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  editGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  editLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 11,
    color: "var(--qb-muted-fg)",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 600,
  },
  editFooter: {
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  },
  btnDanger: {
    fontSize: 11,
    padding: "4px 8px",
    background: "rgba(220, 38, 38, 0.08)",
    color: "rgb(220, 38, 38)",
    border: "1px solid rgba(220, 38, 38, 0.4)",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 500,
  },
  btnDangerSolid: {
    fontSize: 11,
    padding: "4px 8px",
    background: "rgb(220, 38, 38)",
    color: "#fff",
    border: "1px solid rgb(185, 28, 28)",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 600,
  },
  errorBox: {
    color: "rgb(255, 99, 71)",
    fontSize: 12,
    padding: 6,
    background: "rgba(255, 99, 71, 0.08)",
    borderRadius: 4,
  },
};

function badgeStatus(row: ProviderRow): CSSProperties {
  if (!row.enabled) return { ...styles.badge, ...styles.badgeDisabled };
  if (row.apiKeyConfigured || row.providerType === "ollama") {
    return { ...styles.badge, ...styles.badgeOk };
  }
  return { ...styles.badge, ...styles.badgeWarn };
}

function badgeLabel(row: ProviderRow): string {
  if (!row.enabled) return "已禁用";
  if (row.apiKeyConfigured) return "已配置";
  if (row.providerType === "ollama") return "本地";
  return "缺 apiKey";
}

const EMPTY_EDIT_FORM: EditForm = {
  providerType: "openai",
  modelName: "",
  baseUrl: "",
  apiKey: "",
  contextWindow: "",
  supportsFunctionCalling: true,
};

export const LlmProvidersList: FC = () => {
  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [defaultInfo, setDefaultInfo] = useState<DefaultInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 新建表单
  const [newProviderId, setNewProviderId] = useState("openai:gpt-4o-mini");
  const [newProviderType, setNewProviderType] = useState<ProviderRow["providerType"]>("openai");
  const [newModelName, setNewModelName] = useState("gpt-4o-mini");
  const [newBaseUrl, setNewBaseUrl] = useState("");
  const [newApiKey, setNewApiKey] = useState("");

  // 内联编辑 / 删除确认（Tauri Webview 屏蔽了 prompt/confirm）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_EDIT_FORM);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [focusApiKey, setFocusApiKey] = useState(false);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [listRes, defRes] = await Promise.all([
        httpGet<{ ok: boolean; data: ProviderRow[] }>("/api/v1/llm-providers"),
        httpGet<{ ok: boolean; data: DefaultInfo }>("/api/v1/llm-providers/_default/info"),
      ]);
      setRows(listRes.data || []);
      setDefaultInfo(defRes.data || null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async () => {
    if (!newProviderId.trim() || !newModelName.trim()) {
      setError("providerId 和 modelName 必填");
      return;
    }
    try {
      await httpPost("/api/v1/llm-providers", {
        providerId: newProviderId.trim(),
        providerType: newProviderType,
        modelName: newModelName.trim(),
        baseUrl: newBaseUrl.trim() || null,
        apiKey: newApiKey.trim() || null,
        enabled: true,
      });
      setNewApiKey("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleToggle = async (row: ProviderRow) => {
    try {
      await httpPatch(`/api/v1/llm-providers/${row.id}`, { enabled: !row.enabled });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDeleteConfirm = async (row: ProviderRow) => {
    try {
      await httpDelete(`/api/v1/llm-providers/${row.id}`);
      setPendingDeleteId(null);
      if (editingId === row.id) setEditingId(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleStartEdit = (row: ProviderRow, focusKey = false) => {
    setEditingId(row.id);
    setFocusApiKey(focusKey);
    setEditForm({
      providerType: row.providerType,
      modelName: row.modelName,
      baseUrl: row.baseUrl ?? "",
      apiKey: "",
      contextWindow: String(row.contextWindow ?? ""),
      supportsFunctionCalling: row.supportsFunctionCalling,
    });
    setPendingDeleteId(null);
    setError(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditForm(EMPTY_EDIT_FORM);
    setFocusApiKey(false);
  };

  const handleSaveEdit = async (row: ProviderRow) => {
    if (!editForm.modelName.trim()) {
      setError("modelName 不能为空");
      return;
    }
    const ctxNum = editForm.contextWindow.trim() ? Number(editForm.contextWindow.trim()) : NaN;
    if (editForm.contextWindow.trim() && (!Number.isFinite(ctxNum) || ctxNum <= 0)) {
      setError("contextWindow 必须是正整数");
      return;
    }

    const payload: Record<string, unknown> = {
      providerType: editForm.providerType,
      modelName: editForm.modelName.trim(),
      baseUrl: editForm.baseUrl.trim() || null,
      supportsFunctionCalling: editForm.supportsFunctionCalling,
    };
    if (editForm.contextWindow.trim()) payload.contextWindow = ctxNum;
    if (editForm.apiKey.trim()) payload.apiKey = editForm.apiKey.trim();

    try {
      setEditSaving(true);
      setError(null);
      await httpPatch(`/api/v1/llm-providers/${row.id}`, payload);
      setEditingId(null);
      setEditForm(EMPTY_EDIT_FORM);
      setFocusApiKey(false);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleTest = async (row: ProviderRow) => {
    try {
      const res = await httpPost<{ ok: boolean; data?: unknown; error?: string; hint?: string }>(
        `/api/v1/llm-providers/${row.id}/test`,
        {}
      );
      if (res.ok) {
        alert(`✓ ${row.providerId} 配置就绪\n${JSON.stringify(res.data, null, 2)}`);
      } else {
        alert(`✗ ${row.providerId}: ${res.error}\n${res.hint ?? ""}`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => a.providerId.localeCompare(b.providerId));
  }, [rows]);

  return (
    <div style={styles.panel}>
      {/* 默认 / 降级模型 摘要卡片 */}
      <div style={styles.card}>
        <h4 style={styles.cardTitle}>默认 / 降级模型</h4>
        <p style={styles.cardHint}>
          当 Agent 未指定 <code>llmProvider</code> 或指定的 provider 不可用时，
          会自动降级到此模型。默认模型的具体配置通过下方"默认 LLM 配置"区编辑（写入{" "}
          <code>.qubit/model.json</code>）。
        </p>
        {defaultInfo ? (
          <div style={{ ...styles.formRow, fontSize: 13, color: "var(--qb-body-fg)" }}>
            <span>
              <strong>当前生效</strong>：
              {defaultInfo.provider}:{defaultInfo.model}
            </span>
            <span style={defaultInfo.apiKeyConfigured ? styles.badgeOk : styles.badgeWarn}>
              {defaultInfo.apiKeyConfigured ? "已配 apiKey" : "未配 apiKey"}
            </span>
            <span style={styles.badgeDisabled}>来源：{defaultInfo.source}</span>
          </div>
        ) : (
          <div style={styles.cardHint}>加载中...</div>
        )}
      </div>

      {/* 新建 provider */}
      <div style={styles.card}>
        <h4 style={styles.cardTitle}>新增 LLM Provider</h4>
        <p style={styles.cardHint}>
          providerId 是路由唯一键，建议格式 <code>&lt;provider&gt;:&lt;model&gt;</code>，
          如 <code>openai:gpt-4o</code> / <code>anthropic:claude-sonnet-4</code> /{" "}
          <code>deepseek:deepseek-chat</code>。Agent 编辑页通过这个 ID 选模型。
        </p>
        <div style={styles.formRow}>
          <input
            style={{ ...styles.input, minWidth: 220 }}
            placeholder="providerId（如 openai:gpt-4o）"
            value={newProviderId}
            onChange={(e) => setNewProviderId(e.target.value)}
          />
          <select
            style={styles.select}
            value={newProviderType}
            onChange={(e) => setNewProviderType(e.target.value as ProviderRow["providerType"])}
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
            <option value="ollama">ollama</option>
            <option value="custom">custom（DeepSeek/Qwen/Zhipu）</option>
          </select>
          <input
            style={styles.input}
            placeholder="modelName（如 gpt-4o）"
            value={newModelName}
            onChange={(e) => setNewModelName(e.target.value)}
          />
          <input
            style={styles.input}
            placeholder="baseUrl（可选）"
            value={newBaseUrl}
            onChange={(e) => setNewBaseUrl(e.target.value)}
          />
          <input
            style={{ ...styles.input, minWidth: 180 }}
            type="password"
            autoComplete="off"
            placeholder="apiKey（明文；保存后清空）"
            value={newApiKey}
            onChange={(e) => setNewApiKey(e.target.value)}
          />
          <button className="qb-btn-primary-brand" onClick={() => void handleCreate()}>
            新建
          </button>
        </div>
      </div>

      {/* provider 列表 */}
      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4 style={styles.cardTitle}>
            已配置的 Provider（{sortedRows.length}）
          </h4>
          <button className="qb-btn-secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? "刷新中..." : "刷新"}
          </button>
        </div>
        {error ? <div style={styles.errorBox}>{error}</div> : null}
        <div>
          <div style={styles.tableHead}>
            <span>providerId / 模型</span>
            <span>类型 / baseUrl</span>
            <span>apiKeyRef</span>
            <span>状态</span>
            <span>启用</span>
            <span>操作</span>
          </div>
          {sortedRows.length === 0 ? (
            <div style={{ ...styles.cardHint, padding: 12, textAlign: "center" }}>
              暂无配置；新建一个 provider 后，可在 Agent 编辑页让指定 Agent 使用此模型。
            </div>
          ) : null}
          {sortedRows.map((row) => {
            const isEditing = editingId === row.id;
            const isPendingDelete = pendingDeleteId === row.id;
            return (
              <div key={row.id}>
                <div style={styles.row}>
                  <span>
                    <strong>{row.providerId}</strong>
                    <br />
                    <small style={{ color: "var(--qb-muted-fg)" }}>{row.modelName}</small>
                  </span>
                  <span>
                    <code style={{ fontSize: 12 }}>{row.providerType}</code>
                    <br />
                    <small style={{ color: "var(--qb-muted-fg)" }}>{row.baseUrl ?? "—"}</small>
                  </span>
                  <span>
                    <code style={{ fontSize: 11 }}>{row.apiKeyRef ?? "—"}</code>
                  </span>
                  <span style={badgeStatus(row)}>{badgeLabel(row)}</span>
                  <span>
                    <label style={{ fontSize: 12, color: "var(--qb-muted-fg)" }}>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={() => void handleToggle(row)}
                      />{" "}
                      {row.enabled ? "启用" : "禁用"}
                    </label>
                  </span>
                  <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    <button
                      className="qb-btn-secondary"
                      style={{ fontSize: 11, padding: "4px 8px" }}
                      onClick={() => (isEditing ? handleCancelEdit() : handleStartEdit(row))}
                    >
                      {isEditing ? "收起" : "编辑"}
                    </button>
                    <button
                      className="qb-btn-secondary"
                      style={{ fontSize: 11, padding: "4px 8px" }}
                      onClick={() => handleStartEdit(row, true)}
                      title="展开编辑面板并定位到 apiKey"
                    >
                      重设 apiKey
                    </button>
                    <button
                      className="qb-btn-secondary"
                      style={{ fontSize: 11, padding: "4px 8px" }}
                      onClick={() => void handleTest(row)}
                    >
                      测试
                    </button>
                    {isPendingDelete ? (
                      <>
                        <button
                          style={styles.btnDangerSolid}
                          onClick={() => void handleDeleteConfirm(row)}
                        >
                          确认删除
                        </button>
                        <button
                          className="qb-btn-secondary"
                          style={{ fontSize: 11, padding: "4px 8px" }}
                          onClick={() => setPendingDeleteId(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        style={styles.btnDanger}
                        onClick={() => {
                          setPendingDeleteId(row.id);
                          if (editingId === row.id) handleCancelEdit();
                        }}
                      >
                        删除
                      </button>
                    )}
                  </span>
                </div>
                {isEditing ? (
                  <div style={styles.editPanel}>
                    <p style={{ ...styles.cardHint, margin: 0 }}>
                      编辑 <strong>{row.providerId}</strong> · 仅 apiKey 留空时表示「保持不变」；其它字段会覆盖。
                    </p>
                    <div style={styles.editGrid}>
                      <label style={styles.editLabel}>
                        类型
                        <select
                          style={styles.select}
                          value={editForm.providerType}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, providerType: e.target.value as ProviderType }))
                          }
                        >
                          <option value="openai">openai</option>
                          <option value="anthropic">anthropic</option>
                          <option value="ollama">ollama</option>
                          <option value="custom">custom（DeepSeek/Qwen/Zhipu）</option>
                        </select>
                      </label>
                      <label style={styles.editLabel}>
                        modelName
                        <input
                          style={styles.input}
                          placeholder="如 gpt-4o"
                          value={editForm.modelName}
                          onChange={(e) => setEditForm((f) => ({ ...f, modelName: e.target.value }))}
                        />
                      </label>
                      <label style={styles.editLabel}>
                        baseUrl
                        <input
                          style={styles.input}
                          placeholder="留空使用 provider 默认值"
                          value={editForm.baseUrl}
                          onChange={(e) => setEditForm((f) => ({ ...f, baseUrl: e.target.value }))}
                        />
                      </label>
                      <label style={styles.editLabel}>
                        apiKey（留空保持不变）
                        <input
                          style={styles.input}
                          type="password"
                          autoComplete="off"
                          autoFocus={focusApiKey}
                          placeholder={row.apiKeyConfigured ? "已配置，输入新值覆盖" : "未配置，输入明文"}
                          value={editForm.apiKey}
                          onChange={(e) => setEditForm((f) => ({ ...f, apiKey: e.target.value }))}
                        />
                      </label>
                      <label style={styles.editLabel}>
                        contextWindow
                        <input
                          style={styles.input}
                          inputMode="numeric"
                          placeholder="如 128000"
                          value={editForm.contextWindow}
                          onChange={(e) => setEditForm((f) => ({ ...f, contextWindow: e.target.value }))}
                        />
                      </label>
                      <label style={{ ...styles.editLabel, flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={editForm.supportsFunctionCalling}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, supportsFunctionCalling: e.target.checked }))
                          }
                        />
                        supportsFunctionCalling
                      </label>
                    </div>
                    <div style={styles.editFooter}>
                      <button
                        className="qb-btn-primary-brand"
                        onClick={() => void handleSaveEdit(row)}
                        disabled={editSaving}
                      >
                        {editSaving ? "保存中..." : "保存"}
                      </button>
                      <button
                        className="qb-btn-secondary"
                        onClick={handleCancelEdit}
                        disabled={editSaving}
                      >
                        取消
                      </button>
                      <span style={{ ...styles.cardHint, marginLeft: "auto" }}>
                        修改 providerId 需要新建一条 provider 后删除旧的（providerId 是唯一键）
                      </span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
