import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  type HarnessHealthDto,
  type HarnessHostGateDto,
  type HarnessMarketplaceItemDto,
  type HarnessPackageLockRecordDto,
  type HarnessPackageProfileDto,
  type HarnessPackageProfilesDto,
  type HarnessPackageVersionDto,
  type HarnessProfileActivationHistoryDto,
  type HarnessRecentEventsDto,
  type HarnessTrustDto,
  type PluginListItemDto,
  type PluginListTab,
  beginOauthAuthorize,
  disconnectOauthConnection,
  exportHarnessPackageProfiles,
  getHarnessHealth,
  getHarnessPackageProfiles,
  getHarnessProfileActivationHistory,
  getHarnessTrust,
  getOauthPreset,
  getRecentHarnessEvents,
  importHarnessPackageProfiles,
  importPluginPackage,
  installHarnessPackageManifest,
  installPlugin,
  listHarnessMarketplace,
  listHarnessPackageVersions,
  listHarnessPackages,
  listPlugins,
  rollbackHarnessPackage,
  setActiveHarnessPackageProfiles,
  uninstallHarnessPackage,
  uninstallPlugin,
  upsertOauthConnection,
  verifyHarnessPackageManifest,
} from "../../api/backend";

type Props = {
  projectId: string;
  /** 插件目录与 Harness 运行能力分开呈现，避免把运行时配置伪装成普通插件。 */
  view?: "plugins" | "harness";
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
  badge: {
    fontSize: 11,
    lineHeight: "16px",
    border: "1px solid var(--qb-border)",
    borderRadius: 4,
    padding: "1px 6px",
    color: "var(--qb-main-meta)",
    whiteSpace: "nowrap" as const,
  },
  chip: {
    fontSize: 11,
    lineHeight: "16px",
    borderRadius: 4,
    padding: "1px 6px",
    background: "var(--qb-pill-info-bg)",
    color: "var(--qb-fg)",
    whiteSpace: "nowrap" as const,
  },
};

function admissionKindLabel(kind: "global_toggle" | "workflow_lease" | undefined): string {
  return kind === "workflow_lease" ? "工作流租约" : "影子组合";
}

function isLeaseProfile(profile: Pick<HarnessPackageProfileDto, "admission">): boolean {
  return profile.admission?.kind === "workflow_lease";
}

function hostGateLayerLabel(layer: HarnessHostGateDto["layer"]): string {
  if (layer === "research") return "研究";
  if (layer === "backtest") return "回测";
  if (layer === "execution") return "执行";
  return "实盘";
}

function evidenceStageLabel(stage: "research" | "paper" | "live"): string {
  if (stage === "research") return "研究";
  if (stage === "paper") return "Paper";
  return "Live";
}

const HostAdapterRow: FC<{ gate: HarnessHostGateDto }> = ({ gate }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "minmax(0, 1fr) auto",
      gap: 10,
      alignItems: "start",
    }}
  >
    <div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{gate.title}</div>
        <span style={styles.badge}>{hostGateLayerLabel(gate.layer)}</span>
      </div>
      <div style={styles.meta}>{gate.description}</div>
    </div>
    <span style={styles.badge}>{gate.failClosedWhenMissing ? "缺失则拒绝" : "只观察"}</span>
  </div>
);

const HarnessProfileInspection: FC<{ profile: HarnessPackageProfileDto }> = ({ profile }) => {
  const tools = profile.tools ?? [];
  const capabilities = profile.capabilities ?? [];
  const visibleTools = tools.slice(0, 6);
  const extraTools = tools.length - visibleTools.length;
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
      {profile.admission ? (
        <div style={styles.meta}>
          {profile.admission.summary}
          {profile.admission.configKey ? ` · ${profile.admission.configKey}` : ""}
        </div>
      ) : null}
      {profile.extends && profile.extends.length > 0 ? (
        <div style={styles.meta}>继承：{profile.extends.join("、")}</div>
      ) : null}
      {capabilities.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {capabilities.map((capability) => (
            <span key={capability.id} style={styles.chip} title={capability.description}>
              {capability.title}
            </span>
          ))}
        </div>
      ) : null}
      {visibleTools.length > 0 ? (
        <div style={styles.meta}>
          工具：{visibleTools.join("、")}
          {extraTools > 0 ? ` 等 ${tools.length} 个` : ""}
        </div>
      ) : profile.admission?.kind === "workflow_lease" ? (
        <div style={styles.meta}>无独立工具面；只投影已有证据，不新增执行权限。</div>
      ) : null}
      {profile.evidenceStages && profile.evidenceStages.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 6,
          }}
        >
          {profile.evidenceStages.map((stage) => (
            <div
              key={stage.stage}
              style={{
                border: "1px solid var(--qb-border)",
                borderRadius: 6,
                padding: 7,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600 }}>
                {evidenceStageLabel(stage.stage)} ·{" "}
                {stage.enforcement === "required" ? "硬门" : "提示"}
              </div>
              <div style={{ ...styles.meta, marginTop: 4 }}>
                {stage.checks.map((check) => check.title).join("、")}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {profile.admission?.unloadNote ? (
        <div style={styles.meta}>{profile.admission.unloadNote}</div>
      ) : null}
    </div>
  );
};

export const PluginsPanel: FC<Props> = ({
  projectId,
  view = "plugins",
  onOpenMcp,
  onOpenSkills,
}) => {
  const showPlugins = view === "plugins";
  const showHarness = view === "harness";
  const [tab, setTab] = useState<PluginListTab>("featured");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PluginListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<
    "codex_plugin" | "claude_plugin" | "agent_skills"
  >("codex_plugin");
  const [importPath, setImportPath] = useState("");
  const [harnessPackageSource, setHarnessPackageSource] = useState("");
  const [harnessProfileSource, setHarnessProfileSource] = useState("");
  const [harnessPackages, setHarnessPackages] = useState<HarnessPackageLockRecordDto[]>([]);
  const [harnessVersions, setHarnessVersions] = useState<
    Record<string, HarnessPackageVersionDto[]>
  >({});
  const [harnessProfiles, setHarnessProfiles] = useState<HarnessPackageProfilesDto>({
    activeProfileIds: [],
    activation: {
      schemaVersion: 1,
      profileIds: [],
      parameterOverrides: {},
      revision: 0,
      updatedAt: null,
    },
    available: [],
    hostGates: [],
    rejected: [],
  });
  const [harnessEvents, setHarnessEvents] = useState<HarnessRecentEventsDto | null>(null);
  const [harnessHealth, setHarnessHealth] = useState<HarnessHealthDto | null>(null);
  const [harnessHistory, setHarnessHistory] = useState<HarnessProfileActivationHistoryDto[]>([]);
  const [harnessTrust, setHarnessTrust] = useState<HarnessTrustDto | null>(null);
  const [harnessMarketplace, setHarnessMarketplace] = useState<HarnessMarketplaceItemDto[]>([]);
  const [harnessParameterDrafts, setHarnessParameterDrafts] = useState<
    Record<string, Record<string, string | number | boolean>>
  >({});
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
    if (!showPlugins) {
      setItems([]);
      return;
    }
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
  }, [projectId, q, showPlugins, tab]);

  useEffect(() => {
    if (!showPlugins) return;
    void reload();
  }, [reload, showPlugins]);

  const reloadHarnessPackages = useCallback(async () => {
    try {
      const [packages, profiles, events, health, history, trust, marketplace] = await Promise.all([
        listHarnessPackages(),
        getHarnessPackageProfiles(),
        getRecentHarnessEvents(),
        getHarnessHealth(),
        getHarnessProfileActivationHistory(),
        getHarnessTrust(),
        listHarnessMarketplace(),
      ]);
      setHarnessPackages(packages);
      setHarnessProfiles(profiles);
      setHarnessEvents(events);
      setHarnessHealth(health);
      setHarnessHistory(history);
      setHarnessTrust(trust);
      setHarnessMarketplace(marketplace);
      setHarnessParameterDrafts(profiles.activation.parameterOverrides);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!showHarness) return;
    void reloadHarnessPackages();
  }, [reloadHarnessPackages, showHarness]);

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

  const parseHarnessPackage = (): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(harnessPackageSource) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Harness 包必须是一个 JSON 对象");
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      setError(`Harness 包 JSON 无法解析：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const onVerifyHarnessPackage = async () => {
    const packageData = parseHarnessPackage();
    if (!packageData) return;
    setError(null);
    setMessage(null);
    try {
      const result = await verifyHarnessPackageManifest(packageData);
      if (!result.ok) {
        setError(`验证失败：${result.code ?? "invalid"} · ${result.message ?? "未知原因"}`);
        return;
      }
      setMessage(
        `Harness 包验证通过：${result.keyId ?? "trusted signer"} · ${result.digest?.slice(0, 12) ?? ""}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onInstallHarnessPackage = async () => {
    const packageData = parseHarnessPackage();
    if (!packageData) return;
    setError(null);
    setMessage(null);
    try {
      const installed = await installHarnessPackageManifest(packageData);
      setMessage(`Harness 能力包已安装：${installed.packageId}@${installed.version}`);
      await reloadHarnessPackages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onApplyHarnessProfiles = async (profileIds: string[]) => {
    const leaseIds = new Set(
      harnessProfiles.available.filter(isLeaseProfile).map((profile) => profile.id)
    );
    const nextIds = profileIds.filter((id) => !leaseIds.has(id));
    const parameterOverrides = Object.fromEntries(
      Object.entries(harnessParameterDrafts).filter(([id]) => nextIds.includes(id))
    );
    setError(null);
    try {
      const activation = await setActiveHarnessPackageProfiles({
        profileIds: nextIds,
        parameterOverrides,
      });
      setHarnessProfiles((current) => ({
        ...current,
        activeProfileIds: activation.profileIds,
        activation,
      }));
      setHarnessParameterDrafts(activation.parameterOverrides);
      setMessage(`影子组合已更新：${activation.profileIds.length} 项`);
      await reloadHarnessPackages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onToggleHarnessProfile = async (profileId: string) => {
    const profile = harnessProfiles.available.find((item) => item.id === profileId);
    if (profile && isLeaseProfile(profile)) return;
    const next = harnessProfiles.activeProfileIds.includes(profileId)
      ? harnessProfiles.activeProfileIds.filter((id) => id !== profileId)
      : [...harnessProfiles.activeProfileIds, profileId];
    await onApplyHarnessProfiles(next);
  };

  const onSaveHarnessProfileParameters = async () => {
    const leaseIds = new Set(
      harnessProfiles.available.filter(isLeaseProfile).map((profile) => profile.id)
    );
    const nextIds = harnessProfiles.activeProfileIds.filter((id) => !leaseIds.has(id));
    const parameterOverrides = Object.fromEntries(
      Object.entries(harnessParameterDrafts).filter(([profileId]) => nextIds.includes(profileId))
    );
    setError(null);
    try {
      const activation = await setActiveHarnessPackageProfiles({
        profileIds: nextIds,
        parameterOverrides,
      });
      setHarnessProfiles((current) => ({
        ...current,
        activeProfileIds: activation.profileIds,
        activation,
      }));
      setHarnessParameterDrafts(activation.parameterOverrides);
      setMessage(`已保存 Profile 参数（修订 ${activation.revision}）`);
      await reloadHarnessPackages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onResetHarnessProfileParameters = (profileId: string) => {
    setHarnessParameterDrafts((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
    setMessage("已恢复包内默认参数；点击“保存参数修订”后生效");
  };

  const leaseProfileIds = new Set(
    harnessProfiles.available.filter(isLeaseProfile).map((profile) => profile.id)
  );
  const shadowProfileIds = harnessProfiles.activeProfileIds.filter(
    (id) => !leaseProfileIds.has(id)
  );
  const hostHardGates = (harnessProfiles.hostGates ?? []).filter((gate) => gate.role === "gate");
  const hostObservations = (harnessProfiles.hostGates ?? []).filter(
    (gate) => gate.role === "observation"
  );
  const allowlistedShadow = harnessProfiles.available.filter(
    (profile) => !isLeaseProfile(profile) && profile.resolverAllowlisted
  );

  const onExportHarnessProfiles = async () => {
    setError(null);
    try {
      const activation = await exportHarnessPackageProfiles();
      setHarnessProfileSource(JSON.stringify(activation, null, 2));
      setMessage(`已导出 Harness Profile 配置（修订 ${activation.revision}）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onImportHarnessProfiles = async () => {
    setError(null);
    try {
      const parsed = JSON.parse(harnessProfileSource) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Profile 配置必须是导出的 JSON 对象");
        return;
      }
      const payload = parsed as Record<string, unknown>;
      if (Array.isArray(payload.profileIds)) {
        payload.profileIds = payload.profileIds.filter(
          (id) => typeof id === "string" && !leaseProfileIds.has(id)
        );
      }
      const activation = await importHarnessPackageProfiles(payload);
      setMessage(`已导入 Harness Profile 配置（修订 ${activation.revision}）`);
      await reloadHarnessPackages();
    } catch (e) {
      setError(`Profile 配置无法导入：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onToggleHarnessVersions = async (packageId: string) => {
    if (harnessVersions[packageId]) {
      setHarnessVersions((current) => {
        const next = { ...current };
        delete next[packageId];
        return next;
      });
      return;
    }
    setError(null);
    try {
      const versions = await listHarnessPackageVersions(packageId);
      setHarnessVersions((current) => ({ ...current, [packageId]: versions }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onRollbackHarnessPackage = async (packageId: string, version: string) => {
    setError(null);
    try {
      await rollbackHarnessPackage(packageId, version);
      setMessage(`Harness 包已回退：${packageId}@${version}`);
      setHarnessVersions((current) => {
        const next = { ...current };
        delete next[packageId];
        return next;
      });
      await reloadHarnessPackages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onUninstallHarnessPackage = async (packageId: string) => {
    const confirmed = window.confirm(
      `卸载 ${packageId}？它会从当前运行时锁定包中移除，并自动停用该包的 Profile；保留的签名版本不会被删除，可随后回退。`
    );
    if (!confirmed) return;
    setError(null);
    try {
      await uninstallHarnessPackage(packageId);
      setMessage(`Harness 包已卸载：${packageId}`);
      setHarnessVersions((current) => {
        const next = { ...current };
        delete next[packageId];
        return next;
      });
      await reloadHarnessPackages();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      {showPlugins ? (
        <>
          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>插件</h3>
          <p style={styles.hint}>
            自建插件管理（轨 A）：官方包、OAuth 连接器、MCP 目录投影、本机导入。Skill / MCP
            仍可在各自页面直装（轨 B）。
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
                  setImportFormat(
                    e.target.value as "codex_plugin" | "claude_plugin" | "agent_skills"
                  )
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
        </>
      ) : null}

      {showHarness ? (
        <>
          <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Harness</h3>
          <p style={styles.hint}>
            能力组合默认只进影子工具面。工作流租约按场景自动加载，本页不能开关。灰度白名单由部署环境
            QUBIT_HARNESS_RESOLVER_PROFILES 决定；未列入只做对比，列入后也只取与旧工具面的交集。宿主硬门始终
            fail-closed。TCA 是观察仪器，不是晋级门。
          </p>
          {error ? <div style={styles.err}>{error}</div> : null}
          {message ? <div style={{ ...styles.meta, marginBottom: 8 }}>{message}</div> : null}
          <div style={{ ...styles.card, marginBottom: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 650 }}>影子组合</div>
              <div style={styles.meta}>
                当前 {shadowProfileIds.length} 项
                {harnessProfiles.activation.updatedAt
                  ? ` · ${new Date(harnessProfiles.activation.updatedAt).toLocaleString()}`
                  : ""}
              </div>
            </div>
            <div style={{ ...styles.row, marginBottom: 10 }}>
              {[
                { title: "金融研究", ids: ["financial-research"] },
                { title: "券商行情", ids: ["broker-connected-research"] },
                { title: "期权研究", ids: ["us-options-research"] },
                { title: "模拟交易", ids: ["paper-trading"] },
                { title: "研究交付", ids: ["document-production"] },
              ].map((preset) => {
                const active =
                  preset.ids.length === shadowProfileIds.length &&
                  preset.ids.every((id) => shadowProfileIds.includes(id));
                return (
                  <button
                    key={preset.title}
                    type="button"
                    style={active ? styles.tabActive : styles.tab}
                    onClick={() => void onApplyHarnessProfiles(preset.ids)}
                  >
                    {preset.title}
                  </button>
                );
              })}
              <button
                type="button"
                style={styles.btn}
                onClick={() => void onApplyHarnessProfiles([])}
              >
                清空
              </button>
            </div>
              {allowlistedShadow.length > 0 ? (
                <div style={{ ...styles.meta, marginBottom: 10 }}>
                  已列入部署白名单（本页不能改）：
                  {allowlistedShadow.map((profile) => profile.title).join("、")}
                </div>
              ) : (
                <div style={{ ...styles.meta, marginBottom: 10 }}>
                  当前没有 Profile 列入部署白名单，组合只做影子对比。
                </div>
              )}
              <div style={{ display: "grid", gap: 10 }}>
              {harnessProfiles.available
                .filter((profile) => profile.source === "system")
                .map((profile) => {
                  const active = shadowProfileIds.includes(profile.id);
                  const lease = isLeaseProfile(profile);
                  return (
                    <div
                      key={profile.id}
                      style={{
                        borderTop: "1px solid var(--qb-border)",
                        paddingTop: 10,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          gap: 12,
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{profile.title}</div>
                            <span style={styles.badge}>{admissionKindLabel(profile.admission?.kind)}</span>
                            {lease ? <span style={styles.badge}>本页不能开关</span> : null}
                            {!lease && profile.resolverAllowlisted ? (
                              <span style={styles.badge}>已列入灰度</span>
                            ) : null}
                            {!lease && !profile.resolverAllowlisted ? (
                              <span style={styles.badge}>仅影子</span>
                            ) : null}
                          </div>
                          <div style={styles.meta}>{profile.description}</div>
                          <HarnessProfileInspection profile={profile} />
                        </div>
                        {lease ? (
                          <span style={styles.badge}>由工作流加载</span>
                        ) : (
                          <button
                            type="button"
                            style={active ? styles.tabActive : styles.btn}
                            onClick={() => void onToggleHarnessProfile(profile.id)}
                            title="只加入影子组合。不能新增工具，也不能关闭宿主闸门。"
                          >
                            {active ? "已在影子组合" : "加入影子组合"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            {hostHardGates.length > 0 ? (
              <div
                style={{
                  marginTop: 14,
                  borderTop: "1px solid var(--qb-border)",
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 650 }}>宿主强制闸门</div>
                <div style={styles.meta}>
                  写在回测、风控和执行服务里，不是可卸载 Profile。没有关闭开关，缺失则拒绝。
                </div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {hostHardGates.map((gate) => (
                    <HostAdapterRow key={gate.id} gate={gate} />
                  ))}
                </div>
              </div>
            ) : null}
            {hostObservations.length > 0 ? (
              <div
                style={{
                  marginTop: 14,
                  borderTop: "1px solid var(--qb-border)",
                  paddingTop: 12,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 650 }}>观察仪器</div>
                <div style={styles.meta}>
                  写入评估证据，供复盘使用。尚未校准，不会单独改变 pass 或晋级。
                </div>
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {hostObservations.map((gate) => (
                    <HostAdapterRow key={gate.id} gate={gate} />
                  ))}
                </div>
              </div>
            ) : null}
            {harnessProfiles.available.length === 0 ? (
              <div style={styles.meta}>正在读取可用工作模式…</div>
            ) : null}
          </div>

          <details style={{ marginBottom: 16 }}>
            <summary
              style={{
                ...styles.meta,
                cursor: "pointer",
                userSelect: "none",
                padding: "4px 0",
              }}
            >
              高级：导入能力包、参数、迁移与运行审计
            </summary>
            <div style={{ ...styles.card, marginTop: 8, marginBottom: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>导入签名能力包</div>
              <textarea
                style={{
                  ...styles.input,
                  width: "100%",
                  minHeight: 110,
                  marginTop: 8,
                  resize: "vertical",
                }}
                placeholder='粘贴 Harness package JSON，例如 { "schemaVersion": 1, ... }'
                value={harnessPackageSource}
                onChange={(event) => setHarnessPackageSource(event.target.value)}
              />
              <div style={{ ...styles.row, marginTop: 8, marginBottom: 0 }}>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={() => void onVerifyHarnessPackage()}
                >
                  验证签名
                </button>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={() => void onInstallHarnessPackage()}
                >
                  安装能力包
                </button>
                <button
                  type="button"
                  style={styles.btn}
                  onClick={() => void reloadHarnessPackages()}
                >
                  刷新已安装
                </button>
              </div>
              {harnessPackages.length > 0 ? (
                <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                  {harnessPackages.map((item) => {
                    const versions = harnessVersions[item.packageId];
                    return (
                      <div
                        key={item.packageId}
                        style={{
                          border: "1px solid var(--qb-border)",
                          borderRadius: 6,
                          padding: 8,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <strong style={{ fontSize: 13 }}>{item.packageId}</strong>
                          <span style={styles.meta}>当前 {item.version}</span>
                          <span style={styles.meta}>签名 {item.keyId}</span>
                          <button
                            type="button"
                            style={styles.btn}
                            onClick={() => void onToggleHarnessVersions(item.packageId)}
                          >
                            {versions ? "收起版本" : "历史版本"}
                          </button>
                          <button
                            type="button"
                            style={styles.btn}
                            onClick={() => void onUninstallHarnessPackage(item.packageId)}
                          >
                            卸载
                          </button>
                        </div>
                        {versions ? (
                          <div style={{ ...styles.row, margin: "8px 0 0" }}>
                            {versions.map((version) => (
                              <span
                                key={version.version}
                                style={{
                                  ...styles.meta,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 6,
                                }}
                              >
                                {version.current ? "● 当前" : "○"} {version.version}
                                {!version.current ? (
                                  <button
                                    type="button"
                                    style={styles.btn}
                                    onClick={() =>
                                      void onRollbackHarnessPackage(item.packageId, version.version)
                                    }
                                  >
                                    回退到此版
                                  </button>
                                ) : null}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ ...styles.meta, marginTop: 8 }}>暂无已安装 Harness 能力包</div>
              )}
              {harnessProfiles.available.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div style={styles.label}>
                    影子组合（包 Profile 可加入；租约型不在此开关。切面仍需部署白名单）
                  </div>
                  <div style={{ ...styles.row, marginTop: 6, marginBottom: 0 }}>
                    {harnessProfiles.available
                      .filter((profile) => !isLeaseProfile(profile))
                      .map((profile) => {
                      const active = shadowProfileIds.includes(profile.id);
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          style={active ? styles.tabActive : styles.tab}
                          onClick={() => void onToggleHarnessProfile(profile.id)}
                          title={`${profile.packageId}@${profile.packageVersion}`}
                        >
                          {active ? "● " : "○ "}
                          {profile.title}
                          {active
                            ? profile.resolverAllowlisted
                              ? " · 已列入灰度"
                              : " · 仅影子"
                            : ""}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              {harnessProfiles.available.some(
                (profile) =>
                  shadowProfileIds.includes(profile.id) &&
                  !isLeaseProfile(profile) &&
                  profile.parameters.length > 0
              ) ? (
                <div
                  style={{ marginTop: 12, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>影子组合中的参数</div>
                  <div style={{ ...styles.meta, marginTop: 4 }}>
                    参数来自签名能力包的
                    schema，仅支持非密钥的字符串、数字、开关和枚举值；保存会生成可回溯修订。
                  </div>
                  <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                    {harnessProfiles.available
                      .filter(
                        (profile) =>
                          shadowProfileIds.includes(profile.id) &&
                          !isLeaseProfile(profile) &&
                          profile.parameters.length > 0
                      )
                      .map((profile) => (
                        <div
                          key={profile.id}
                          style={{
                            border: "1px solid var(--qb-border)",
                            borderRadius: 6,
                            padding: 10,
                          }}
                        >
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{profile.title}</div>
                          <div style={styles.meta}>
                            {profile.id} · {profile.resolverAllowlisted ? "灰度准入" : "影子模式"}
                          </div>
                          {profile.description ? (
                            <div style={styles.meta}>{profile.description}</div>
                          ) : null}
                          <div style={{ display: "grid", gap: 8, marginTop: 9 }}>
                            {profile.parameters.map((parameter) => {
                              const value =
                                harnessParameterDrafts[profile.id]?.[parameter.id] ??
                                parameter.default ??
                                "";
                              const setValue = (next: string | number | boolean) =>
                                setHarnessParameterDrafts((current) => ({
                                  ...current,
                                  [profile.id]: { ...current[profile.id], [parameter.id]: next },
                                }));
                              return (
                                <div key={parameter.id} style={{ display: "grid", gap: 4 }}>
                                  <span style={styles.label}>
                                    {parameter.title} · {parameter.type}
                                    {parameter.description ? ` · ${parameter.description}` : ""}
                                  </span>
                                  {parameter.type === "boolean" ? (
                                    <input
                                      type="checkbox"
                                      checked={Boolean(value)}
                                      onChange={(event) => setValue(event.target.checked)}
                                    />
                                  ) : parameter.type === "enum" ? (
                                    <select
                                      style={styles.input}
                                      value={String(value)}
                                      onChange={(event) => setValue(event.target.value)}
                                    >
                                      {(parameter.values ?? []).map((item) => (
                                        <option key={item} value={item}>
                                          {item}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type={parameter.type === "number" ? "number" : "text"}
                                      style={styles.input}
                                      value={String(value)}
                                      onChange={(event) => {
                                        if (parameter.type === "number") {
                                          const next = Number(event.target.value);
                                          if (Number.isFinite(next)) setValue(next);
                                          return;
                                        }
                                        setValue(event.target.value);
                                      }}
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ ...styles.row, marginTop: 8, marginBottom: 0 }}>
                            <button
                              type="button"
                              style={styles.btn}
                              onClick={() => onResetHarnessProfileParameters(profile.id)}
                            >
                              恢复包内默认值
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                  <div style={{ ...styles.row, marginTop: 8, marginBottom: 0 }}>
                    <button
                      type="button"
                      style={styles.btn}
                      onClick={() => void onSaveHarnessProfileParameters()}
                    >
                      保存参数修订
                    </button>
                  </div>
                </div>
              ) : null}
              <div style={{ marginTop: 12 }}>
                <div style={styles.label}>
                  Profile 配置导入/导出 · 当前修订 {harnessProfiles.activation.revision}
                  {harnessProfiles.activation.updatedAt
                    ? ` · 更新于 ${new Date(harnessProfiles.activation.updatedAt).toLocaleString()}`
                    : ""}
                </div>
                <textarea
                  style={{ ...styles.input, width: "100%", minHeight: 74, resize: "vertical" }}
                  placeholder='导出的 Profile JSON，例如 { "schemaVersion": 1, "profileIds": [...] }'
                  value={harnessProfileSource}
                  onChange={(event) => setHarnessProfileSource(event.target.value)}
                />
                <div style={{ ...styles.row, marginTop: 7, marginBottom: 0 }}>
                  <button
                    type="button"
                    style={styles.btn}
                    onClick={() => void onExportHarnessProfiles()}
                  >
                    导出当前配置
                  </button>
                  <button
                    type="button"
                    style={styles.btn}
                    onClick={() => void onImportHarnessProfiles()}
                  >
                    导入并校验
                  </button>
                </div>
              </div>
              {harnessMarketplace.length > 0 ? (
                <div
                  style={{ marginTop: 14, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Harness 能力市场目录</div>
                  <div style={{ ...styles.meta, marginTop: 4 }}>
                    目录由部署方同步，展示前会再次校验签名；从目录安装仍需导入完整签名
                    JSON，避免页面成为可执行代码入口。
                  </div>
                  <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
                    {harnessMarketplace.map((item) => (
                      <div key={`${item.id}@${item.version}`} style={styles.meta}>
                        {item.verification.ok ? "●" : "○"} {item.title} · {item.id}@{item.version}
                        {item.verification.ok
                          ? ` · 签名 ${item.verification.keyId ?? "已验证"}`
                          : ` · 不可安装：${item.verification.message ?? item.verification.code ?? "签名无效"}`}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {harnessTrust ? (
                <div
                  style={{ marginTop: 14, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>信任与部署边界</div>
                  <div style={{ ...styles.meta, marginTop: 4 }}>
                    信任根、撤销密钥、灰度白名单、容器镜像与出网代理由部署管理员配置，普通插件页只显示状态，不能降低执行边界。
                  </div>
                  <div style={{ ...styles.meta, marginTop: 6 }}>
                    信任签名：{harnessTrust.trustedKeyIds.join("、") || "未配置"} · 已撤销：
                    {harnessTrust.revokedKeyIds.join("、") || "无"} · 支持密钥轮换：
                    {harnessTrust.keyRotationSupported ? "是" : "否"}
                  </div>
                </div>
              ) : null}
              {harnessHistory.length > 0 ? (
                <div
                  style={{ marginTop: 14, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Profile 配置历史</div>
                  <div style={{ display: "grid", gap: 3, marginTop: 6 }}>
                    {harnessHistory.slice(0, 6).map((entry) => (
                      <div key={`${entry.revision}-${entry.changedAt}`} style={styles.meta}>
                        r{entry.revision} · {new Date(entry.changedAt).toLocaleString()} ·{" "}
                        {entry.source} · 启用：
                        {entry.profileIds.join("、") || "无"}
                        {entry.changedParameterProfiles.length
                          ? ` · 参数：${entry.changedParameterProfiles.join("、")}`
                          : ""}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {harnessProfiles.rejected.length > 0 ? (
                <div style={styles.warn}>
                  忽略未通过校验的包：
                  {harnessProfiles.rejected
                    .map((item) => `${item.packageId}（${item.reason}）`)
                    .join("；")}
                </div>
              ) : null}
              {harnessEvents ? (
                <div
                  style={{ marginTop: 14, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>近期 Harness 运行摘要</div>
                  <div style={{ ...styles.meta, marginTop: 4 }}>
                    组合 {harnessEvents.summary.composed} · 降级 {harnessEvents.summary.degraded} ·
                    准入 {harnessEvents.summary.admitted} · 拒绝 {harnessEvents.summary.rejected} ·
                    完成 {harnessEvents.summary.completed} · Artifact{" "}
                    {harnessEvents.summary.artifacts}
                  </div>
                  {harnessEvents.events.length > 0 ? (
                    <div style={{ display: "grid", gap: 3, marginTop: 7 }}>
                      {harnessEvents.events.slice(0, 8).map((event) => (
                        <div key={event.id} style={styles.meta}>
                          {event.eventType}
                          {event.profileId ? ` · ${event.profileId}` : ""}
                          {event.status ? ` · ${event.status}` : ""}
                          {` · ${new Date(event.createdAt).toLocaleString()}`}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ ...styles.meta, marginTop: 6 }}>暂无 Harness 调用记录</div>
                  )}
                </div>
              ) : null}
              {harnessHealth ? (
                <div
                  style={{ marginTop: 14, borderTop: "1px solid var(--qb-border)", paddingTop: 10 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Harness 健康与自动降级</div>
                  <div style={{ ...styles.meta, marginTop: 4 }}>
                    回退策略：旧工具面持续可用 · 最近降级 {harnessHealth.recentDegradations}
                  </div>
                  {harnessHealth.profiles.length ? (
                    <div style={{ display: "grid", gap: 3, marginTop: 7 }}>
                      {harnessHealth.profiles.map((profile) => (
                        <div
                          key={profile.profileId}
                          style={profile.state === "open" ? styles.warn : styles.meta}
                        >
                          {profile.state === "open" ? "熔断中" : "正常"} · {profile.profileId} · 近
                          5 分钟失败 {profile.failuresInWindow}
                          {profile.retryAt
                            ? ` · ${new Date(profile.retryAt).toLocaleString()} 后自动重试`
                            : ""}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ ...styles.meta, marginTop: 6 }}>暂无受控 Profile 失败记录</div>
                  )}
                </div>
              ) : null}
            </div>
          </details>
        </>
      ) : null}

      {showPlugins && oauthPluginId ? (
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

      {showPlugins && error ? <div style={styles.err}>{error}</div> : null}
      {showPlugins && message ? (
        <div style={{ ...styles.meta, marginBottom: 8 }}>{message}</div>
      ) : null}
      {showPlugins && loading ? <div style={styles.meta}>加载中…</div> : null}

      {showPlugins && !loading && items.length === 0 ? (
        <div style={{ ...styles.card, color: "var(--qb-main-meta)", fontSize: 13 }}>
          暂无插件条目
        </div>
      ) : null}

      {showPlugins &&
        items.map((item) => (
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
                    <button
                      type="button"
                      style={styles.btn}
                      onClick={() => void onDisconnectOauth(item)}
                    >
                      断开
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={styles.btn}
                      onClick={() => void openOauthForm(item)}
                    >
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
