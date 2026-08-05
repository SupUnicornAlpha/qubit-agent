import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  beginOauthAuthorize,
  disconnectOauthConnection,
  getOauthPreset,
  importPluginPackage,
  installPlugin,
  listPlugins,
  uninstallPlugin,
  upsertOauthConnection,
  type PluginListItemDto,
  type PluginListTab,
} from "../../api/backend";

type Props = {
  projectId: string;
  onOpenMcp?: () => void;
  onOpenSkills?: () => void;
};

const styles: Record<string, CSSProperties> = {
  hint: { color: "var(--qb-main-meta)", fontSize: 13, margin: "0 0 12px", lineHeight: 1.5 },
  row: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" },
  tab: {
    border: "1px solid var(--qb-border)",
    background: "transparent",
    color: "var(--qb-fg)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
  tabActive: {
    border: "1px solid var(--qb-accent)",
    background: "var(--qb-pill-info-bg)",
    color: "var(--qb-accent)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 13,
  },
  input: {
    flex: 1,
    minWidth: 140,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-border)",
    background: "var(--qb-input-bg, transparent)",
    color: "var(--qb-fg)",
    fontSize: 13,
  },
  card: {
    border: "1px solid var(--qb-border)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    background: "var(--qb-card-bg, transparent)",
  },
  meta: { fontSize: 12, color: "var(--qb-main-meta)", marginTop: 4 },
  btn: {
    border: "1px solid var(--qb-border)",
    background: "var(--qb-btn-bg, transparent)",
    color: "var(--qb-fg)",
    borderRadius: 6,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: 12,
  },
  warn: { color: "var(--qb-pill-warn-fg)", fontSize: 12, marginTop: 6 },
  err: { color: "var(--qb-danger, #c44)", fontSize: 13, marginBottom: 8 },
  label: { fontSize: 12, color: "var(--qb-main-meta)", marginBottom: 4 },
};

export const PluginsPanel: FC<Props> = ({ projectId, onOpenMcp, onOpenSkills }) => {
  const [tab, setTab] = useState<PluginListTab>("featured");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PluginListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<"codex_plugin" | "claude_plugin" | "agent_skills">(
    "codex_plugin"
  );
  const [importPath, setImportPath] = useState("");
  const [oauthPluginId, setOauthPluginId] = useState<string | null>(null);
  const [oauthForm, setOauthForm] = useState({
    clientId: "",
    clientSecret: "",
    authorizeUrl: "",
    tokenUrl: "",
    scopes: "",
    mcpServerName: "",
  });

  const reload = useCallback(async () => {
    if (!projectId && tab === "installed") {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listPlugins({
        ...(projectId ? { projectId } : {}),
        tab,
        ...(q.trim() ? { q: q.trim() } : {}),
        pageSize: 60,
      });
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, tab, q]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; status?: string } | null;
      if (data?.type === "qubit-oauth" && data.status === "connected") {
        setMessage("OAuth 连接成功");
        void reload();
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [reload]);

  const onInstall = async (item: PluginListItemDto) => {
    if (!projectId) {
      setError("请先选择项目");
      return;
    }
    setMessage(null);
    setError(null);
    try {
      if (item.id === "connector:futu" || item.kind === "connector") {
        const r = await installPlugin({
          projectId,
          targetId: item.id,
          kind: "connector",
        });
        const notes = [...(r.warnings ?? []), ...(r.item.warnings ?? [])].filter(Boolean);
        setMessage(notes[0] ?? `已配置：${r.item.name}`);
        await reload();
        return;
      }
      if (item.kind === "builtin_pack") {
        const r = await installPlugin({
          projectId,
          targetId: item.id,
          kind: "builtin_pack",
        });
        setMessage(r.warnings[0] ?? "官方包已内置");
        return;
      }
      if (item.kind === "mcp" && item.ref.mcpCatalogId) {
        const r = await installPlugin({
          projectId,
          targetId: `mcp-catalog:${String(item.ref.mcpCatalogId)}`,
          kind: "mcp",
          serverName: String(item.ref.mcpServerName ?? item.name),
        });
        setMessage(`已安装 MCP：${r.item.name}`);
        await reload();
        return;
      }
      setError("此类条目请走 MCP / Skills 直装入口（轨 B）");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUninstall = async (item: PluginListItemDto) => {
    if (!projectId || !item.installKey) return;
    if (item.installKey.startsWith("builtin:")) {
      setError("官方 builtin pack 不可卸载");
      return;
    }
    setError(null);
    try {
      await uninstallPlugin({ projectId, installKey: item.installKey });
      setMessage(`已卸载：${item.name}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const openOauthForm = async (item: PluginListItemDto) => {
    setOauthPluginId(item.id);
    setError(null);
    try {
      const preset = await getOauthPreset(item.id);
      setOauthForm({
        clientId: "",
        clientSecret: "",
        authorizeUrl: preset.authorizeUrl ?? "",
        tokenUrl: preset.tokenUrl ?? "",
        scopes: preset.scopes ?? (item.auth?.scopes ?? []).join(" "),
        mcpServerName: item.oauthMcpServerName ?? "",
      });
    } catch {
      setOauthForm({
        clientId: "",
        clientSecret: "",
        authorizeUrl: "",
        tokenUrl: "",
        scopes: (item.auth?.scopes ?? []).join(" "),
        mcpServerName: "",
      });
    }
  };

  const saveAndConnectOauth = async () => {
    if (!projectId || !oauthPluginId) return;
    setError(null);
    setMessage(null);
    try {
      await upsertOauthConnection({
        projectId,
        pluginId: oauthPluginId,
        clientId: oauthForm.clientId.trim(),
        clientSecret: oauthForm.clientSecret,
        authorizeUrl: oauthForm.authorizeUrl.trim() || undefined,
        tokenUrl: oauthForm.tokenUrl.trim() || undefined,
        scopes: oauthForm.scopes.trim() || undefined,
        mcpServerName: oauthForm.mcpServerName.trim() || null,
      });
      const { authorizeUrl } = await beginOauthAuthorize({
        projectId,
        pluginId: oauthPluginId,
      });
      window.open(authorizeUrl, "qubit-oauth", "width=560,height=720");
      setMessage("已打开授权窗口；完成后会自动刷新状态");
      setOauthPluginId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onDisconnectOauth = async (item: PluginListItemDto) => {
    if (!projectId) return;
    setError(null);
    try {
      await disconnectOauthConnection({ projectId, pluginId: item.id });
      setMessage(`已断开：${item.name}`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onImport = async () => {
    if (!projectId) {
      setError("请先选择项目");
      return;
    }
    if (!importPath.trim()) {
      setError("请填写本机插件目录或 SKILL.md 路径");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const data = await importPluginPackage({
        projectId,
        format: importFormat,
        rootPath: importPath.trim(),
      });
      const warn = data.warnings.length ? `；警告：${data.warnings.join("；")}` : "";
      setMessage(
        `导入成功：${data.manifest.name}（skills=${data.skillInstallIds.length}, mcp=${data.mcpServerNames.length}）${warn}`
      );
      setTab("installed");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>插件</h3>
      <p style={styles.hint}>
        自建插件管理（轨 A）：官方包、OAuth 连接器、MCP 目录投影、本机导入。Skill / MCP 仍可在各自页面直装（轨
        B）。
      </p>
      <div style={styles.row}>
        {(
          [
            ["featured", "精选"],
            ["installed", "已安装"],
            ["catalog", "MCP 目录"],
            ["all", "全部"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            style={tab === id ? styles.tabActive : styles.tab}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <input
          style={styles.input}
          placeholder="搜索插件…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" style={styles.btn} onClick={() => void reload()}>
          刷新
        </button>
        {onOpenMcp ? (
          <button type="button" style={styles.btn} onClick={onOpenMcp}>
            MCP 直装 →
          </button>
        ) : null}
        {onOpenSkills ? (
          <button type="button" style={styles.btn} onClick={onOpenSkills}>
            Skills 直装 →
          </button>
        ) : null}
      </div>

      <div style={{ ...styles.card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>从本机导入插件包</div>
        <div style={styles.row}>
          <select
            style={{ ...styles.input, flex: "0 0 180px" }}
            value={importFormat}
            onChange={(e) =>
              setImportFormat(e.target.value as "codex_plugin" | "claude_plugin" | "agent_skills")
            }
          >
            <option value="codex_plugin">Codex 插件目录</option>
            <option value="claude_plugin">Claude 插件目录</option>
            <option value="agent_skills">Agent Skill（SKILL.md）</option>
          </select>
          <input
            style={styles.input}
            placeholder="绝对路径，如 /path/to/plugin 或 …/SKILL.md"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
          />
          <button type="button" style={styles.btn} onClick={() => void onImport()}>
            导入
          </button>
        </div>
      </div>

      {oauthPluginId ? (
        <div style={{ ...styles.card, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            配置 OAuth：{oauthPluginId}
          </div>
          <div style={styles.label}>Client ID</div>
          <input
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.clientId}
            onChange={(e) => setOauthForm((f) => ({ ...f, clientId: e.target.value }))}
          />
          <div style={styles.label}>Client Secret</div>
          <input
            type="password"
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.clientSecret}
            onChange={(e) => setOauthForm((f) => ({ ...f, clientSecret: e.target.value }))}
          />
          <div style={styles.label}>Authorize URL</div>
          <input
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.authorizeUrl}
            onChange={(e) => setOauthForm((f) => ({ ...f, authorizeUrl: e.target.value }))}
            placeholder="https://…/authorize"
          />
          <div style={styles.label}>Token URL</div>
          <input
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.tokenUrl}
            onChange={(e) => setOauthForm((f) => ({ ...f, tokenUrl: e.target.value }))}
            placeholder="https://…/token"
          />
          <div style={styles.label}>Scopes（空格分隔）</div>
          <input
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.scopes}
            onChange={(e) => setOauthForm((f) => ({ ...f, scopes: e.target.value }))}
          />
          <div style={styles.label}>绑定 MCP server 名（可选，HTTP 调用注入 Bearer）</div>
          <input
            style={{ ...styles.input, width: "100%", marginBottom: 8 }}
            value={oauthForm.mcpServerName}
            onChange={(e) => setOauthForm((f) => ({ ...f, mcpServerName: e.target.value }))}
            placeholder="与 mcp_server_config.name 一致"
          />
          <div style={styles.row}>
            <button type="button" style={styles.btn} onClick={() => void saveAndConnectOauth()}>
              保存并连接
            </button>
            <button type="button" style={styles.btn} onClick={() => setOauthPluginId(null)}>
              取消
            </button>
          </div>
          <div style={styles.meta}>
            回调地址默认：/api/v1/plugins/oauth/callback（可用 QUBIT_PUBLIC_BASE_URL 覆盖公网域名）
          </div>
        </div>
      ) : null}

      {error ? <div style={styles.err}>{error}</div> : null}
      {message ? <div style={{ ...styles.meta, marginBottom: 8 }}>{message}</div> : null}
      {loading ? <div style={styles.meta}>加载中…</div> : null}

      {!loading && items.length === 0 ? (
        <div style={{ ...styles.card, color: "var(--qb-main-meta)", fontSize: 13 }}>暂无插件条目</div>
      ) : null}

      {items.map((item) => (
        <div key={item.id} style={styles.card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {item.name}{" "}
                <span style={styles.meta}>
                  · {item.kind}
                  {item.version ? ` · v${item.version}` : ""}
                  {item.installed ? " · 已安装" : ""}
                  {item.oauthConnected ? " · OAuth 已连接" : ""}
                  {item.oauthStatus && !item.oauthConnected ? ` · oauth=${item.oauthStatus}` : ""}
                </span>
              </div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{item.description || "（无描述）"}</div>
              <div style={styles.meta}>
                {item.category} · safety={item.safetyLevel}
                {item.auth?.type ? ` · auth=${item.auth.type}` : ""}
                {item.oauthMcpServerName ? ` · mcp=${item.oauthMcpServerName}` : ""}
              </div>
              {item.oauthError ? <div style={styles.warn}>{item.oauthError}</div> : null}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {item.id === "connector:futu" ? (
                <button type="button" style={styles.btn} onClick={() => void onInstall(item)}>
                  打通行情+交易
                </button>
              ) : item.kind === "connector" || item.auth?.type === "oauth2" ? (
                item.oauthConnected ? (
                  <button type="button" style={styles.btn} onClick={() => void onDisconnectOauth(item)}>
                    断开
                  </button>
                ) : (
                  <button type="button" style={styles.btn} onClick={() => void openOauthForm(item)}>
                    连接
                  </button>
                )
              ) : null}
              {!item.installed && item.kind === "mcp" ? (
                <button type="button" style={styles.btn} onClick={() => void onInstall(item)}>
                  安装
                </button>
              ) : null}
              {item.kind === "builtin_pack" ? (
                <button type="button" style={styles.btn} onClick={() => void onInstall(item)}>
                  内置
                </button>
              ) : null}
              {item.installed &&
              item.installKey &&
              !item.installKey.startsWith("builtin:") &&
              item.id !== "connector:futu" ? (
                <button type="button" style={styles.btn} onClick={() => void onUninstall(item)}>
                  卸载
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
