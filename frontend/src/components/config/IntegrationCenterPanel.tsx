import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  deleteIntegrationChannel,
  listIntegrationCatalog,
  listIntegrationChannels,
  listIntegrationLogs,
  sendIntegrationMessage,
  upsertIntegrationChannel,
} from "../../api/backend";
import type {
  CommunicationChannelRecord,
  CommunicationMessageLogRecord,
  IntegrationAdapterDescriptor,
  IntegrationKind,
} from "../../api/types";
import { INTEGRATION_KINDS } from "../../api/types";

interface ProviderConfigField {
  /** 字段 key（写入 metaJson；为 "secretRef" 时写入 communication_channel.secretRef） */
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  /** 是否走 secretRef 列而非 metaJson */
  secret?: boolean;
}

interface ProviderForm {
  kind: IntegrationKind;
  /** "频道/会话 ID" 输入框的标签与占位 */
  chatIdLabel: string;
  chatIdPlaceholder: string;
  /** UI hint 帮助文字 */
  description: string;
  /** 字段顺序：第一个 secret=true 的字段会写入 secretRef；其余写入 metaJson */
  fields: ProviderConfigField[];
}

const PROVIDER_FORMS: Record<IntegrationKind, ProviderForm> = {
  telegram: {
    kind: "telegram",
    chatIdLabel: "Chat ID",
    chatIdPlaceholder: "如 12345678（getUpdates 中获取）",
    description:
      "@BotFather 创建机器人后填入 Bot Token；Webhook 地址：`/api/v1/integrations/telegram/webhook`。",
    fields: [
      { key: "secretRef", label: "Bot Token", placeholder: "123456:ABC-DEF...", secret: true },
    ],
  },
  feishu: {
    kind: "feishu",
    chatIdLabel: "Receive ID / open_chat_id",
    chatIdPlaceholder: "群机器人时可置 default；应用消息时填 chat_id",
    description:
      "群机器人模式：仅需填 Webhook URL，可选签名密钥；应用消息模式：填 tenant_access_token 与 receive_id_type。",
    fields: [
      { key: "webhookUrl", label: "Webhook URL（群机器人）", placeholder: "https://open.feishu.cn/open-apis/bot/v2/hook/..." },
      { key: "secretRef", label: "签名密钥 / tenant_access_token", placeholder: "可选；启用签名校验或应用消息时填", secret: true },
      { key: "receiveIdType", label: "receive_id_type（应用消息）", placeholder: "chat_id / open_id / user_id（默认 chat_id）" },
      { key: "openApiBase", label: "OpenAPI Base", placeholder: "默认 https://open.feishu.cn" },
    ],
  },
  wecom: {
    kind: "wecom",
    chatIdLabel: "ToUser / 群机器人忽略",
    chatIdPlaceholder: "群机器人填 default；应用消息填用户/部门 ID",
    description:
      "群机器人模式：仅需填 Webhook URL；应用消息模式：填 access_token、agentId（+touser）。",
    fields: [
      { key: "webhookUrl", label: "Webhook URL（群机器人）", placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." },
      { key: "secretRef", label: "access_token（应用消息）", placeholder: "经 corp_id+secret 换取的 access_token", secret: true },
      { key: "agentId", label: "Agent ID", placeholder: "如 1000002" },
      { key: "openApiBase", label: "OpenAPI Base", placeholder: "默认 https://qyapi.weixin.qq.com" },
    ],
  },
  whatsapp: {
    kind: "whatsapp",
    chatIdLabel: "收件人手机号（E.164）",
    chatIdPlaceholder: "如 8613800000000",
    description:
      "WhatsApp Cloud API：需在 Meta 业务平台创建 App + WABA，配置 phone_number_id 与 verify_token。",
    fields: [
      { key: "secretRef", label: "Access Token", placeholder: "System User / Long-lived access token", secret: true },
      { key: "phoneNumberId", label: "Phone Number ID", placeholder: "Meta WABA 配置中的 phone_number_id" },
      { key: "verifyToken", label: "Webhook Verify Token", placeholder: "回调订阅时自定义" },
      { key: "graphVersion", label: "Graph API 版本", placeholder: "默认 v20.0" },
    ],
  },
  dingtalk: {
    kind: "dingtalk",
    chatIdLabel: "Userid_list / 群机器人忽略",
    chatIdPlaceholder: "群机器人填 default；应用消息填 userid（逗号分隔）",
    description:
      "群机器人模式：仅需填 Webhook URL（可选签名密钥）；应用消息模式：填 access_token + agentId。",
    fields: [
      { key: "webhookUrl", label: "Webhook URL（群机器人）", placeholder: "https://oapi.dingtalk.com/robot/send?access_token=..." },
      { key: "secretRef", label: "签名密钥 / access_token", placeholder: "群机器人加签时填密钥；应用消息时填 access_token", secret: true },
      { key: "agentId", label: "Agent ID（应用消息）", placeholder: "" },
      { key: "openApiBase", label: "OpenAPI Base", placeholder: "默认 https://oapi.dingtalk.com" },
    ],
  },
  webhook: {
    kind: "webhook",
    chatIdLabel: "目标地址（externalChatId）",
    chatIdPlaceholder: "也可在下方 meta.url 单独填写",
    description:
      "通用 outbound Webhook：将文本作为 JSON {text} 推送到 meta.url。可在 meta.headers 中追加 KV。",
    fields: [
      { key: "url", label: "Webhook URL", placeholder: "https://example.com/hooks/my-bot" },
      { key: "secretRef", label: "Bearer Token", placeholder: "可选；填后作为 Authorization 头", secret: true },
      { key: "method", label: "HTTP Method", placeholder: "默认 POST" },
      { key: "template", label: "Body Template", placeholder: "raw_text 时发送 text/plain，其余发送 {text}" },
    ],
  },
};

const KIND_LABELS: Record<IntegrationKind, string> = {
  telegram: "Telegram",
  feishu: "飞书 / Lark",
  wecom: "企业微信",
  whatsapp: "WhatsApp",
  dingtalk: "钉钉",
  webhook: "通用 Webhook",
};

const KIND_BADGE_COLORS: Record<IntegrationKind, string> = {
  telegram: "#2AABEE",
  feishu: "#3370FF",
  wecom: "#2BC76F",
  whatsapp: "#25D366",
  dingtalk: "#1677FF",
  webhook: "#A1A1AA",
};

interface FormState {
  id?: string;
  name: string;
  externalChatId: string;
  enabled: boolean;
  secret: string;
  meta: Record<string, string>;
}

function blankForm(): FormState {
  return { name: "", externalChatId: "", enabled: true, secret: "", meta: {} };
}

function metaToFormFields(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (v == null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function buildMetaPayload(form: ProviderForm, state: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (field.secret) continue;
    const value = state.meta[field.key];
    if (value != null && value !== "") out[field.key] = value;
  }
  return out;
}

const REFRESH_INTERVAL_MS = 8000;

interface IntegrationCenterPanelProps {
  workspaceId?: string;
  projectId?: string | null;
}

export const IntegrationCenterPanel: FC<IntegrationCenterPanelProps> = ({ workspaceId, projectId }) => {
  const [activeKind, setActiveKind] = useState<IntegrationKind>("telegram");
  const [channels, setChannels] = useState<CommunicationChannelRecord[]>([]);
  const [logs, setLogs] = useState<CommunicationMessageLogRecord[]>([]);
  const [catalog, setCatalog] = useState<IntegrationAdapterDescriptor[]>([]);
  const [form, setForm] = useState<FormState>(blankForm());
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [testText, setTestText] = useState("✅ QUBIT 测试消息");
  const [showRaw, setShowRaw] = useState(false);

  const provider = PROVIDER_FORMS[activeKind];

  const reload = async () => {
    setBusy(true);
    setError(null);
    try {
      const [chList, lgList, cat] = await Promise.all([
        listIntegrationChannels(),
        listIntegrationLogs(undefined, 50),
        listIntegrationCatalog().catch(() => [] as IntegrationAdapterDescriptor[]),
      ]);
      setChannels(chList);
      setLogs(lgList);
      setCatalog(cat);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredChannels = useMemo(
    () => channels.filter((c) => c.kind === activeKind),
    [channels, activeKind]
  );

  const filteredLogs = useMemo(
    () => logs.filter((l) => l.channelKind === activeKind).slice(0, 30),
    [logs, activeKind]
  );

  const onPickChannel = (id: string) => {
    setSelectedChannelId(id);
    const row = channels.find((c) => c.id === id);
    if (!row) {
      setForm(blankForm());
      return;
    }
    setForm({
      id: row.id,
      name: row.name,
      externalChatId: row.externalChatId,
      enabled: row.enabled,
      secret: row.secretRef ?? "",
      meta: metaToFormFields(row.metaJson ?? {}),
    });
  };

  const onSelectKind = (kind: IntegrationKind) => {
    setActiveKind(kind);
    setSelectedChannelId("");
    setForm({ ...blankForm(), name: `${kind}-channel` });
    setOkMsg(null);
    setError(null);
  };

  const onSave = async () => {
    if (!workspaceId) {
      setError("当前 workspace 未就绪，请先在配置中心创建工作区/项目");
      return;
    }
    if (!form.name.trim() || !form.externalChatId.trim()) {
      setError("name 与 externalChatId 必填");
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const meta = buildMetaPayload(provider, form);
      const upserted = await upsertIntegrationChannel({
        id: form.id,
        workspaceId,
        projectId: projectId ?? null,
        kind: activeKind,
        name: form.name.trim(),
        externalChatId: form.externalChatId.trim(),
        secretRef: form.secret,
        metaJson: meta,
        enabled: form.enabled,
      });
      setOkMsg(`已保存：${upserted.name}`);
      await reload();
      setSelectedChannelId(upserted.id);
      onPickChannel(upserted.id);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!form.id) return;
    if (!window.confirm(`确认删除渠道 ${form.name}？`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteIntegrationChannel(form.id);
      setOkMsg("已删除");
      setForm(blankForm());
      setSelectedChannelId("");
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSendTest = async () => {
    if (!form.id) {
      setError("请先保存渠道后再发送测试消息");
      return;
    }
    if (!testText.trim()) {
      setError("测试消息不可为空");
      return;
    }
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const res = await sendIntegrationMessage(form.id, testText.trim());
      setOkMsg(res.ok ? "测试消息已发送 ✓" : `发送失败：${res.errorMessage ?? "未知错误"}`);
      await reload();
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const catalogByKind = useMemo(() => {
    const map = new Map<string, IntegrationAdapterDescriptor>();
    for (const item of catalog) map.set(item.kind, item);
    return map;
  }, [catalog]);

  return (
    <div data-qb-integration-panel>
      <h3 style={styles.subTitle}>集成与 IM 工具</h3>
      <p className="qb-config-hint">
        统一管理 IM 推送 / Webhook 入站：支持 Telegram、飞书、企业微信、WhatsApp、钉钉、通用 Webhook。
        渠道按 kind 分类，每个 kind 可拥有多个独立配置，编排执行结果可按 channel 推送，外部消息回 Webhook 自动落地为研究任务。
      </p>

      <div style={styles.kindRow}>
        {INTEGRATION_KINDS.map((kind) => {
          const active = kind === activeKind;
          const count = channels.filter((c) => c.kind === kind).length;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onSelectKind(kind)}
              style={{
                ...styles.kindChip,
                borderColor: active ? KIND_BADGE_COLORS[kind] : "var(--qb-stream-box-border, #27272a)",
                boxShadow: active ? `inset 0 0 0 1px ${KIND_BADGE_COLORS[kind]}` : "none",
                color: active ? "var(--qb-body-fg)" : "var(--qb-main-meta, #a1a1aa)",
              }}
            >
              <span style={{ ...styles.kindDot, background: KIND_BADGE_COLORS[kind] }} aria-hidden />
              <span style={{ fontWeight: 600 }}>{KIND_LABELS[kind]}</span>
              <span style={styles.kindCount}>{count}</span>
            </button>
          );
        })}
      </div>

      <p className="qb-config-hint qb-config-hint--tight">{provider.description}</p>
      {catalogByKind.get(activeKind)?.docsUrl ? (
        <p className="qb-config-hint qb-config-hint--tight">
          官方文档：
          <a
            href={catalogByKind.get(activeKind)!.docsUrl}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: KIND_BADGE_COLORS[activeKind] }}
          >
            {catalogByKind.get(activeKind)!.docsUrl}
          </a>
        </p>
      ) : null}

      <div style={styles.twoCol}>
        {/* 左：渠道列表 */}
        <div style={styles.leftCol}>
          <div style={styles.colHeader}>
            <span style={styles.colTitle}>{KIND_LABELS[activeKind]} · 渠道列表</span>
            <button
              type="button"
              className="qb-btn-secondary"
              onClick={() => {
                setSelectedChannelId("");
                setForm({ ...blankForm(), name: `${activeKind}-channel` });
              }}
            >
              + 新建
            </button>
          </div>
          {filteredChannels.length === 0 ? (
            <p className="qb-config-hint">尚未配置 {KIND_LABELS[activeKind]} 渠道，右侧填写参数后保存即可。</p>
          ) : (
            <ul style={styles.channelList}>
              {filteredChannels.map((ch) => {
                const isActive = ch.id === selectedChannelId;
                return (
                  <li key={ch.id}>
                    <button
                      type="button"
                      onClick={() => onPickChannel(ch.id)}
                      style={{
                        ...styles.channelItem,
                        borderColor: isActive ? KIND_BADGE_COLORS[ch.kind] : "var(--qb-stream-box-border, #27272a)",
                        background: isActive ? "rgba(255,255,255,0.04)" : "transparent",
                      }}
                    >
                      <div style={styles.channelTitleRow}>
                        <span style={{ fontWeight: 600 }}>{ch.name}</span>
                        <span
                          style={{
                            ...styles.statusBadge,
                            color: ch.enabled ? "#10b981" : "#71717a",
                            borderColor: ch.enabled ? "#10b98166" : "#71717a55",
                          }}
                        >
                          {ch.enabled ? "ENABLED" : "DISABLED"}
                        </span>
                      </div>
                      <div style={styles.channelMeta}>{ch.externalChatId}</div>
                      <div style={styles.channelMetaSmall}>更新时间：{ch.updatedAt}</div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* 右：表单 + 测试 */}
        <div style={styles.rightCol}>
          <div style={styles.colHeader}>
            <span style={styles.colTitle}>{form.id ? "编辑渠道" : "新建渠道"}</span>
            {form.id ? (
              <span style={{ fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)" }}>id={form.id.slice(0, 8)}…</span>
            ) : null}
          </div>

          <label style={styles.fieldLabel}>
            渠道名称
            <input
              style={styles.input}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={`如：${activeKind}-trading-alert`}
            />
          </label>
          <label style={styles.fieldLabel}>
            {provider.chatIdLabel}
            <input
              style={styles.input}
              value={form.externalChatId}
              onChange={(e) => setForm({ ...form, externalChatId: e.target.value })}
              placeholder={provider.chatIdPlaceholder}
            />
          </label>

          {provider.fields.map((field) =>
            field.secret ? (
              <label key={field.key} style={styles.fieldLabel}>
                {field.label}
                <input
                  type="password"
                  style={styles.input}
                  value={form.secret}
                  onChange={(e) => setForm({ ...form, secret: e.target.value })}
                  placeholder={field.placeholder}
                  autoComplete="new-password"
                />
                {field.hint ? <span style={styles.fieldHint}>{field.hint}</span> : null}
              </label>
            ) : (
              <label key={field.key} style={styles.fieldLabel}>
                {field.label}
                <input
                  style={styles.input}
                  value={form.meta[field.key] ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, meta: { ...form.meta, [field.key]: e.target.value } })
                  }
                  placeholder={field.placeholder}
                />
                {field.hint ? <span style={styles.fieldHint}>{field.hint}</span> : null}
              </label>
            )
          )}

          <label style={{ ...styles.fieldLabel, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用该渠道
          </label>

          <div style={styles.actionsRow}>
            <button type="button" className="qb-btn-primary-brand" onClick={() => void onSave()} disabled={busy}>
              {form.id ? "保存修改" : "创建渠道"}
            </button>
            {form.id ? (
              <button type="button" className="qb-btn-secondary" onClick={() => void onDelete()} disabled={busy}>
                删除
              </button>
            ) : null}
          </div>

          {form.id ? (
            <div style={styles.testBox}>
              <div style={styles.colTitle}>测试发送</div>
              <textarea
                style={{ ...styles.input, minHeight: 64, resize: "vertical" as const }}
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                placeholder="输入测试消息文本"
              />
              <div style={styles.actionsRow}>
                <button type="button" className="qb-btn-secondary" onClick={() => void onSendTest()} disabled={busy}>
                  发送到 {KIND_LABELS[activeKind]}
                </button>
                <span style={{ fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" }}>
                  Webhook 入口：<code>/api/v1/integrations/{activeKind}/webhook</code>
                </span>
              </div>
            </div>
          ) : null}

          {error ? <div style={styles.errorBox}>错误：{error}</div> : null}
          {okMsg ? <div style={styles.okBox}>{okMsg}</div> : null}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={styles.colHeader}>
          <span style={styles.colTitle}>消息日志（最近 30 条 · {KIND_LABELS[activeKind]}）</span>
          <button type="button" className="qb-btn-secondary" onClick={() => void reload()} disabled={busy}>
            刷新
          </button>
        </div>
        {filteredLogs.length === 0 ? (
          <p className="qb-config-hint">暂无 {KIND_LABELS[activeKind]} 消息日志。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="qb-config-table" style={styles.logsTable}>
              <thead>
                <tr>
                  <th style={styles.th}>时间</th>
                  <th style={styles.th}>方向</th>
                  <th style={styles.th}>chat / target</th>
                  <th style={styles.th}>状态</th>
                  <th style={styles.th}>外部消息 ID</th>
                  <th style={styles.th}>错误</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.id}>
                    <td style={styles.td}>{log.createdAt}</td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.dirBadge,
                          color: log.direction === "outbound" ? "#60a5fa" : "#fbbf24",
                          borderColor: log.direction === "outbound" ? "#60a5fa55" : "#fbbf2455",
                        }}
                      >
                        {log.direction === "outbound" ? "OUT →" : "← IN"}
                      </span>
                    </td>
                    <td style={styles.td}>{log.externalChatId}</td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.statusBadge,
                          color: log.status === "success" ? "#10b981" : "#ef4444",
                          borderColor: log.status === "success" ? "#10b98166" : "#ef444466",
                        }}
                      >
                        {log.status.toUpperCase()}
                      </span>
                    </td>
                    <td style={styles.td}>{log.externalMessageId ?? "—"}</td>
                    <td style={{ ...styles.td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={log.errorMessage ?? ""}>
                      {log.errorMessage ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <details style={{ marginTop: 16 }}>
        <summary
          style={{ cursor: "pointer", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 12 }}
          onClick={() => setShowRaw((v) => !v)}
        >
          {showRaw ? "隐藏" : "展开"} 原始 JSON 数据（调试用）
        </summary>
        {showRaw ? (
          <>
            <pre className="qb-config-stream-box">{JSON.stringify(channels, null, 2)}</pre>
            <pre className="qb-config-stream-box">{JSON.stringify(logs, null, 2)}</pre>
          </>
        ) : null}
      </details>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  subTitle: { fontSize: 16, margin: "16px 0 8px", color: "var(--qb-body-fg)" },
  kindRow: { display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" },
  kindChip: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 999,
    background: "transparent",
    cursor: "pointer",
    fontSize: 12,
  },
  kindDot: { width: 8, height: 8, borderRadius: "50%" },
  kindCount: {
    fontSize: 11,
    padding: "1px 6px",
    background: "rgba(255,255,255,0.06)",
    borderRadius: 999,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "minmax(240px, 320px) 1fr",
    gap: 12,
    alignItems: "stretch",
    marginTop: 8,
  },
  leftCol: {
    background: "var(--qb-stream-box-bg, rgba(255,255,255,0.02))",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    padding: 10,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minHeight: 320,
  },
  rightCol: {
    background: "var(--qb-stream-box-bg, rgba(255,255,255,0.02))",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  colHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 4,
  },
  colTitle: { fontSize: 13, fontWeight: 700, color: "var(--qb-body-fg)" },
  channelList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
    maxHeight: 360,
  },
  channelItem: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    width: "100%",
    textAlign: "left",
    padding: "8px 10px",
    background: "transparent",
    border: "1px solid var(--qb-stream-box-border, #27272a)",
    borderRadius: 6,
    color: "var(--qb-body-fg)",
    cursor: "pointer",
    fontSize: 12,
  },
  channelTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 },
  channelMeta: { fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)", wordBreak: "break-all" },
  channelMetaSmall: { fontSize: 10, color: "var(--qb-main-meta, #a1a1aa)" },
  statusBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 6px",
    border: "1px solid",
    borderRadius: 4,
    letterSpacing: "0.04em",
  },
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  fieldHint: { fontSize: 11, color: "var(--qb-main-meta, #a1a1aa)", marginTop: 2 },
  input: {
    background: "var(--qb-main-input-bg, #18181b)",
    border: "1px solid var(--qb-main-input-border, #27272a)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12,
    width: "100%",
    boxSizing: "border-box",
  },
  actionsRow: { display: "flex", gap: 8, marginTop: 4, alignItems: "center", flexWrap: "wrap" },
  testBox: {
    marginTop: 8,
    padding: 10,
    border: "1px dashed var(--qb-stream-box-border, #27272a)",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  errorBox: {
    marginTop: 8,
    padding: 8,
    background: "rgba(239, 68, 68, 0.12)",
    border: "1px solid rgba(239, 68, 68, 0.35)",
    borderRadius: 6,
    fontSize: 12,
    color: "#fca5a5",
  },
  okBox: {
    marginTop: 8,
    padding: 8,
    background: "rgba(16, 185, 129, 0.10)",
    border: "1px solid rgba(16, 185, 129, 0.35)",
    borderRadius: 6,
    fontSize: 12,
    color: "#34d399",
  },
  logsTable: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12,
  },
  th: { textAlign: "left", padding: "6px 8px", fontWeight: 600 },
  td: { padding: "6px 8px", verticalAlign: "top" },
  dirBadge: {
    fontSize: 10,
    fontWeight: 700,
    padding: "2px 6px",
    border: "1px solid",
    borderRadius: 4,
    letterSpacing: "0.04em",
  },
};
