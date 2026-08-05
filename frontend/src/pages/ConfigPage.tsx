import { useCallback, useEffect, useMemo, useRef, useState, type FC } from "react";
import { getAgentsConfig, getDefaultWorkspace, getModelConfig, getBuiltinConnectorConfig, getWindSessionStatus, loginWindSession, reconnectWindSession, listMcpBindings, listMcpMarketCatalog, listMcpProjectInstalls, listMcpSources, listMcpServers, appendAgentDraftSkills, deleteSkillMarketInstall, getSkillMarketStatus, installManualSkill, installSkillFromMarket, listSkillLibrary, listSkillMarketInstalls, patchAgentSkill, listAgentDefinitions, refreshSkillMarketRegistry, searchSkillMarket, getAgentDefinitionMemoryStats, getAgentDefinitionPack, listProjects, reloadAgents, saveModelConfig, testEmbeddingModelConfig, saveBuiltinConnectorConfig, testMcpCall, testMcpProjectInstall, upsertMcpBinding, upsertMcpSource, upsertMcpServer, installMcpMarket, syncMcpSource, uninstallMcpProjectInstall } from "../api/backend";
import type { AgentDefinitionBundle, AgentDefinitionRecord, AgentMemoryStatsResponse, AgentPackResponse, AgentSkillRecord, McpServerConfigRecord, McpCatalogItemRecord, McpProjectInstallRecord, McpRegistrySourceRecord, McpToolBindingRecord, OpenSkillMarketEntryDto, SkillMarketInstallRecord, SkillMarketStatusDto, BuiltinConnectorConfig } from "../api/types";
import { useAppStore } from "../store";
import { agentDisplayLabel } from "../lib/agentDisplay";
import { ConfigAgentPanel, parseAgentMcpServerNames, type AgentConfigUiTab } from "../components/config/ConfigAgentPanel";
import { IntegrationCenterPanel } from "../components/config/IntegrationCenterPanel";
import { PluginsPanel } from "../components/config/PluginsPanel";
import { ScheduledJobsPanel } from "../components/config/ScheduledJobsPanel";
import { ProvidersPanel } from "../components/config/ProvidersPanel";
import { LlmProvidersList } from "../components/config/LlmProvidersList";
import { OriginBadge } from "../components/common/OriginBadge";
import { PythonRuntimeCard } from "../components/common/PythonRuntimeCard";
import { EnvironmentPanel } from "../components/environment/EnvironmentPanel";

import { styles } from "./_shared/legacyMainStyles";

/** Config 页面（原 MainContent.ConfigPanel） */
export const ConfigPanel: FC = () => {
  const setConfigData = useAppStore((s) => s.setConfigData);
  const reloadSummary = useAppStore((s) => s.reloadSummary);
  const setReloadSummary = useAppStore((s) => s.setReloadSummary);
  const activeConfigSubPage = useAppStore((s) => s.configSubPage);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const [definitions, setDefinitions] = useState<AgentDefinitionBundle[]>([]);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftSoul, setDraftSoul] = useState("");
  const [draftNote, setDraftNote] = useState("");
  const [agentUiTab, setAgentUiTab] = useState<AgentConfigUiTab>("overview");
  const [agentPack, setAgentPack] = useState<AgentPackResponse | null>(null);
  const [agentMemoryStats, setAgentMemoryStats] = useState<AgentMemoryStatsResponse | null>(null);
  const [fileSoulMd, setFileSoulMd] = useState("");
  const [filePromptMd, setFilePromptMd] = useState("");
  const [fileAgentMd, setFileAgentMd] = useState("");
  const [fileUserMd, setFileUserMd] = useState("");
  const [fileMemoryMd, setFileMemoryMd] = useState("");
  const [draftPromptMode, setDraftPromptMode] = useState<"db_primary" | "file_primary" | "merged">("db_primary");
  const [draftMemoryNamespace, setDraftMemoryNamespace] = useState("");
  const [draftConfigRootUri, setDraftConfigRootUri] = useState("");
  const [draftMcpServerNames, setDraftMcpServerNames] = useState<string[]>([]);
  const [draftDisplayName, setDraftDisplayName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftTools, setDraftTools] = useState<string[]>([]);
  const [draftMaxIterations, setDraftMaxIterations] = useState(20);
  const [draftSkills, setDraftSkills] = useState<string[]>([]);
  const [draftSubscriptions, setDraftSubscriptions] = useState<string[]>([]);
  const [draftPromptTemplateRef, setDraftPromptTemplateRef] = useState("");
  const [draftLlmProvider, setDraftLlmProvider] = useState("");
  const [provider, setProvider] = useState<
    "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
  >("mock");
  const [modelName, setModelName] = useState("gpt-4o-mini");
  const [modelApiKey, setModelApiKey] = useState("");
  const [modelApiKeyConfigured, setModelApiKeyConfigured] = useState(false);
  const [modelBaseUrl, setModelBaseUrl] = useState("");
  const [embeddingEnabled, setEmbeddingEnabled] = useState(true);
  const [embeddingModel, setEmbeddingModel] = useState("text-embedding-3-small");
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingApiKeyConfigured, setEmbeddingApiKeyConfigured] = useState(false);
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState("");
  const [embeddingRuntimeHint, setEmbeddingRuntimeHint] = useState("");
  const [embeddingTestMsg, setEmbeddingTestMsg] = useState<string | null>(null);
  const [embeddingBusy, setEmbeddingBusy] = useState(false);
  const [tushareToken, setTushareToken] = useState("");
  const [windUsername, setWindUsername] = useState("");
  const [windPassword, setWindPassword] = useState("");
  const [windStartWaitSec, setWindStartWaitSec] = useState(60);
  const [windAutoLogin, setWindAutoLogin] = useState(true);
  const [windSession, setWindSession] = useState<{
    connected: boolean;
    userId: string | null;
    message: string;
    lastLoginAt: string | null;
  } | null>(null);
  const [windSessionBusy, setWindSessionBusy] = useState(false);
  const [windSessionError, setWindSessionError] = useState("");
  const [klinesDataSource, setKlinesDataSource] = useState<
    | "auto"
    | "tushare_daily"
    | "yahoo_chart"
    | "eastmoney"
    | "akshare"
    | "akshare_tencent"
    | "yfinance"
    | "binance_crypto"
    | "wind"
    | "synthetic"
  >("auto");
  const [cryptoUseTestnet, setCryptoUseTestnet] = useState(false);
  const [marketDataNetworkMode, setMarketDataNetworkMode] = useState<"auto" | "direct" | "proxy">("auto");
  const [marketDataProxyUrl, setMarketDataProxyUrl] = useState("");
  const [newsApiBaseUrl, setNewsApiBaseUrl] = useState("");
  const [newsApiKey, setNewsApiKey] = useState("");
  const [newsFetchPath, setNewsFetchPath] = useState("/");
  const [newsTimeoutMs, setNewsTimeoutMs] = useState(15_000);
  const [newsSyntheticWhenEmpty, setNewsSyntheticWhenEmpty] = useState(true);
  const [mcpServers, setMcpServers] = useState<McpServerConfigRecord[]>([]);
  const [mcpBindings, setMcpBindings] = useState<McpToolBindingRecord[]>([]);
  const [mcpSources, setMcpSources] = useState<McpRegistrySourceRecord[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [sourceName, setSourceName] = useState("MCP Official Registry");
  const [sourceBaseUrl, setSourceBaseUrl] = useState(
    "https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100"
  );
  const [sourceAuthType, setSourceAuthType] = useState<"none" | "bearer" | "api_key">("none");
  const [sourceAuthRef, setSourceAuthRef] = useState("");
  const [mcpMarketItems, setMcpMarketItems] = useState<McpCatalogItemRecord[]>([]);
  const [mcpMarketPage, setMcpMarketPage] = useState(1);
  const [mcpMarketTotal, setMcpMarketTotal] = useState(0);
  const [mcpMarketTotalPages, setMcpMarketTotalPages] = useState(1);
  const [mcpMarketLoading, setMcpMarketLoading] = useState(false);
  const MCP_MARKET_PAGE_SIZE = 24;
  const [mcpMarketInstalls, setMcpMarketInstalls] = useState<McpProjectInstallRecord[]>([]);
  const [skillMarketStatus, setSkillMarketStatus] = useState<SkillMarketStatusDto | null>(null);
  const [skillMarketProvider, setSkillMarketProvider] = useState<"skillsmp" | "open">("skillsmp");
  const [skillSearchQ, setSkillSearchQ] = useState("");
  const [skillSearchBusy, setSkillSearchBusy] = useState(false);
  const [skillSearchHits, setSkillSearchHits] = useState<OpenSkillMarketEntryDto[]>([]);
  const [skillMarketPage, setSkillMarketPage] = useState(1);
  const [skillMarketTotal, setSkillMarketTotal] = useState(0);
  const [skillMarketTotalPages, setSkillMarketTotalPages] = useState(1);
  const SKILL_MARKET_PAGE_SIZE = 24;
  const [skillInstalls, setSkillInstalls] = useState<SkillMarketInstallRecord[]>([]);
  /** 由 curator / evolver / 用户手写 / 市场镜像汇总到 agent_skill 表的统一 skill 库。 */
  const [skillLibrary, setSkillLibrary] = useState<AgentSkillRecord[]>([]);
  const [skillLibraryIncludeArchived, setSkillLibraryIncludeArchived] = useState(false);
  const [skillRefreshBusy, setSkillRefreshBusy] = useState(false);
  const [skillAppendDefinitionId, setSkillAppendDefinitionId] = useState("");
  const [manualSkillName, setManualSkillName] = useState("");
  const [manualSkillDescription, setManualSkillDescription] = useState("");
  const [manualSkillRepo, setManualSkillRepo] = useState("");
  const [manualSkillPath, setManualSkillPath] = useState("");
  const [manualSkillLocalPath, setManualSkillLocalPath] = useState("");
  const [manualSkillTags, setManualSkillTags] = useState("");
  const [manualSkillError, setManualSkillError] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState("");
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState("");
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const [catalogServerName, setCatalogServerName] = useState("");
  const [selectedMcpServer, setSelectedMcpServer] = useState("");
  const [newMcpServerName, setNewMcpServerName] = useState("");
  const [newMcpServerTransport, setNewMcpServerTransport] = useState<"stdio" | "http" | "ws">("stdio");
  const [newMcpServerCommand, setNewMcpServerCommand] = useState("");
  const [newMcpServerUrl, setNewMcpServerUrl] = useState("");
  const [mcpToolName, setMcpToolName] = useState("");
  const [mcpTimeoutMs, setMcpTimeoutMs] = useState(20000);
  const [mcpTestOutput, setMcpTestOutput] = useState("");
  const [focusedMcpServerId, setFocusedMcpServerId] = useState<string | null>(null);
  const [mcpAdvancedEditorOpen, setMcpAdvancedEditorOpen] = useState(false);
  const [mcpAdvancedJsonDraft, setMcpAdvancedJsonDraft] = useState("");
  const [mcpAdvancedJsonError, setMcpAdvancedJsonError] = useState("");
  const [mcpProbeByServer, setMcpProbeByServer] = useState<
    Record<string, { status: "idle" | "checking" | "ok" | "error"; message?: string; checkedAt?: string }>
  >({});
  // 定时任务 / 集成 / IM：状态由各自的子面板（ScheduledJobsPanel / IntegrationCenterPanel）自管，
  // 这里只透传 workspace/project 上下文。

  const hydrateBuiltinConnectorForm = (cfg: BuiltinConnectorConfig) => {
    const d = cfg["qubit-data"] ?? {};
    const n = cfg["qubit-news"] ?? {};
    setTushareToken(typeof d.tushareToken === "string" ? d.tushareToken : "");
    setWindUsername(typeof d.windUsername === "string" ? d.windUsername : "");
    setWindPassword(typeof d.windPassword === "string" ? d.windPassword : "");
    const wsw = d["windStartWaitSec"];
    setWindStartWaitSec(
      typeof wsw === "number" && Number.isFinite(wsw)
        ? wsw
        : typeof wsw === "string" && Number.isFinite(Number(wsw))
          ? Number(wsw)
          : 60
    );
    setWindAutoLogin(d.windAutoLogin === false ? false : true);
    const kds = d["klinesDataSource"];
    setKlinesDataSource(
      kds === "tushare_daily" ||
      kds === "yahoo_chart" ||
      kds === "eastmoney" ||
      kds === "akshare" ||
      kds === "akshare_tencent" ||
      kds === "yfinance" ||
      kds === "binance_crypto" ||
      kds === "wind" ||
      kds === "synthetic" ||
      kds === "auto"
        ? kds
        : "auto"
    );
    const testnet = d["cryptoUseTestnet"];
    setCryptoUseTestnet(testnet === true || testnet === "true");
    const networkMode = d["marketDataNetworkMode"];
    setMarketDataNetworkMode(networkMode === "direct" || networkMode === "proxy" ? networkMode : "auto");
    setMarketDataProxyUrl(typeof d.marketDataProxyUrl === "string" ? d.marketDataProxyUrl : "");
    setNewsApiBaseUrl(typeof n.newsApiBaseUrl === "string" ? n.newsApiBaseUrl : "");
    setNewsApiKey(typeof n.newsApiKey === "string" ? n.newsApiKey : "");
    setNewsFetchPath(typeof n.newsFetchPath === "string" ? n.newsFetchPath : "/");
    const to = n["newsTimeoutMs"];
    setNewsTimeoutMs(
      typeof to === "number" && Number.isFinite(to)
        ? to
        : typeof to === "string" && Number.isFinite(Number(to))
          ? Number(to)
          : 15_000
    );
    const swe = n["syntheticWhenEmpty"];
    setNewsSyntheticWhenEmpty(typeof swe === "boolean" ? swe : String(swe) !== "false");
  };

  const preferAgentDefinitionIdRef = useRef<string | null>(null);
  const prevAgentDefId = useRef<string>("");

  const loadConfig = async () => {
    // 用 default workspace（不再用 workspaces[0]，避免被 A2A Pool 抢走）。
    const dft = await getDefaultWorkspace();
    const projects = await listProjects(dft.id);
    const currentProject = projects[0];
    const [data, bundles, servers, bindings, sources] = await Promise.all([
      getAgentsConfig(),
      listAgentDefinitions(),
      listMcpServers(currentProject?.id),
      listMcpBindings(currentProject?.id),
      listMcpSources(),
    ]);
    const [installs, skillInstallRows] = await Promise.all([
      currentProject ? listMcpProjectInstalls(currentProject.id) : Promise.resolve([]),
      currentProject ? listSkillMarketInstalls(currentProject.id) : Promise.resolve([]),
    ]);
    setConfigData(data);
    let list: AgentDefinitionBundle[] = bundles ?? [];
    if (list.length === 0 && Array.isArray(data.dbEffective?.definitions)) {
      const raw = data.dbEffective.definitions as AgentDefinitionRecord[];
      if (raw.length > 0) {
        list = raw.map((definition) => ({ definition, profile: null, draft: null }));
      }
    }
    setDefinitions(list);
    setMcpServers(servers);
    setMcpBindings(bindings);
    setMcpProbeByServer({});
    setFocusedMcpServerId((prev) => (prev && servers.some((s) => s.id === prev) ? prev : null));
    setMcpSources(sources);
    setMcpMarketItems([]);
    setMcpMarketPage(1);
    setMcpMarketTotal(0);
    setMcpMarketTotalPages(1);
    setMcpMarketInstalls(installs);
    setSkillInstalls(skillInstallRows);
    setCurrentWorkspaceId(dft.id);
    if (currentProject) setCurrentProjectId(currentProject.id);
    if (!selectedMcpServer && servers[0]) {
      setSelectedMcpServer(servers[0].name);
    }
    if (!selectedSourceId && sources[0]) {
      setSelectedSourceId(sources[0].id);
      setSourceName(sources[0].name);
      setSourceBaseUrl(sources[0].baseUrl);
      setSourceAuthType(sources[0].authType);
      setSourceAuthRef(sources[0].authRef ?? "");
    }
    if (list.length === 0) {
      setSelectedDefinitionId("");
    } else {
      const preferred = preferAgentDefinitionIdRef.current;
      preferAgentDefinitionIdRef.current = null;
      const resolvedId =
        (preferred && list.some((x) => x.definition.id === preferred) ? preferred : null) ??
        (selectedDefinitionId && list.some((x) => x.definition.id === selectedDefinitionId) ? selectedDefinitionId : null) ??
        list[0]!.definition.id;
      const b = list.find((x) => x.definition.id === resolvedId) ?? list[0]!;
      const selectionChanged = resolvedId !== selectedDefinitionId;
      setSelectedDefinitionId(resolvedId);
      if (selectionChanged) {
        prevAgentDefId.current = "";
        setDraftPrompt(b.draft?.systemPrompt ?? b.definition.systemPrompt);
        setDraftSoul(b.profile?.soulFileRef ?? "");
        setDraftPromptMode((b.profile?.promptMode as "db_primary" | "file_primary" | "merged") ?? "db_primary");
        setDraftMemoryNamespace(b.profile?.memoryNamespace ?? "");
        setDraftConfigRootUri(b.profile?.configRootUri ?? "");
        setDraftMcpServerNames(parseAgentMcpServerNames(b.draft?.mcpServersJson ?? b.definition.mcpServersJson));
        setDraftPromptTemplateRef(b.profile?.promptTemplateRef ?? "");
        setDraftLlmProvider(b.draft?.llmProvider ?? b.definition.llmProvider ?? "");
      }
    }
    try {
      const bc = await getBuiltinConnectorConfig();
      hydrateBuiltinConnectorForm(bc);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void loadConfig();
    void getModelConfig().then((cfg) => {
      setProvider(cfg.provider ?? "mock");
      setModelName(cfg.model ?? "gpt-4o-mini");
      setModelApiKey(cfg.apiKey ?? "");
      setModelApiKeyConfigured(Boolean(cfg.apiKeyConfigured));
      setModelBaseUrl(cfg.baseUrl ?? "");
      const emb = cfg.embedding;
      setEmbeddingEnabled(emb?.enabled ?? true);
      setEmbeddingModel(emb?.model ?? "text-embedding-3-small");
      setEmbeddingApiKey("");
      setEmbeddingApiKeyConfigured(Boolean(emb?.apiKeyConfigured));
      setEmbeddingBaseUrl(emb?.baseUrl ?? "");
      setEmbeddingDimensions(
        emb?.dimensions != null && Number.isFinite(emb.dimensions) ? String(emb.dimensions) : ""
      );
      if (emb?.runtime) {
        setEmbeddingRuntimeHint(
          emb.runtime.configured
            ? `就绪 · ${emb.runtime.model ?? "?"} · dim=${emb.runtime.dimension ?? "?"} · source=${emb.runtime.source}`
            : `未就绪 · source=${emb.runtime.source}（将降级为 keyword-only）`
        );
      } else {
        setEmbeddingRuntimeHint("");
      }
    });
    void getBuiltinConnectorConfig()
      .then(hydrateBuiltinConnectorForm)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (activeConfigSubPage !== "skills") return;
    void getSkillMarketStatus().then(setSkillMarketStatus);
  }, [activeConfigSubPage]);

  useEffect(() => {
    if (activeConfigSubPage !== "skills" || !currentProjectId) return;
    void listSkillMarketInstalls(currentProjectId).then(setSkillInstalls);
  }, [activeConfigSubPage, currentProjectId]);

  useEffect(() => {
    if (activeConfigSubPage !== "skills" || !currentProjectId) return;
    void listSkillLibrary(currentProjectId, { includeArchived: skillLibraryIncludeArchived })
      .then(setSkillLibrary)
      .catch(() => setSkillLibrary([]));
  }, [activeConfigSubPage, currentProjectId, skillLibraryIncludeArchived]);

  const loadMcpMarketPage = useCallback(
    async (page: number) => {
      const sourceId = selectedSourceId || mcpSources[0]?.id;
      if (!sourceId) {
        setMcpMarketItems([]);
        setMcpMarketTotal(0);
        setMcpMarketTotalPages(1);
        setMcpMarketPage(1);
        return;
      }
      setMcpMarketLoading(true);
      try {
        const res = await listMcpMarketCatalog({
          sourceId,
          q: marketQuery.trim() || undefined,
          page,
          pageSize: MCP_MARKET_PAGE_SIZE,
        });
        const items = Array.isArray(res.items) ? res.items : [];
        setMcpMarketItems(items);
        setMcpMarketPage(res.page ?? page);
        setMcpMarketTotal(res.total ?? items.length);
        setMcpMarketTotalPages(Math.max(1, res.totalPages ?? 1));
        if (items.length > 0) {
          const first = items[0]!;
          setSelectedCatalogId((prev) => {
            const nextId = prev && items.some((x) => x.id === prev) ? prev : first.id;
            const hit = items.find((x) => x.id === nextId) ?? first;
            setCatalogServerName(hit.slug.replace(/[^a-z0-9_-]/gi, "-"));
            return nextId;
          });
        }
      } finally {
        setMcpMarketLoading(false);
      }
    },
    [selectedSourceId, mcpSources, marketQuery]
  );

  useEffect(() => {
    if (activeConfigSubPage !== "mcp") return;
    void loadMcpMarketPage(1);
  }, [activeConfigSubPage, selectedSourceId, loadMcpMarketPage]);

  const loadSkillMarketPage = useCallback(
    async (page: number) => {
      setSkillSearchBusy(true);
      try {
        const res = await searchSkillMarket({
          q: skillSearchQ,
          page,
          pageSize: SKILL_MARKET_PAGE_SIZE,
          provider: skillMarketProvider,
        });
        const items = Array.isArray(res.items) ? res.items : [];
        setSkillSearchHits(items);
        setSkillMarketPage(res.page ?? page);
        setSkillMarketTotal(res.total ?? items.length);
        setSkillMarketTotalPages(Math.max(1, res.totalPages ?? 1));
      } finally {
        setSkillSearchBusy(false);
      }
    },
    [skillSearchQ, skillMarketProvider]
  );

  const searchSkillMarketNow = async () => {
    await loadSkillMarketPage(1);
  };

  const installManualSkillNow = async () => {
    if (!currentProjectId) {
      setManualSkillError("请先加载项目后再添加 Skill。");
      return;
    }
    const skillName = manualSkillName.trim();
    if (!skillName) {
      setManualSkillError("请填写 skill 名称。");
      return;
    }
    try {
      setManualSkillError("");
      await installManualSkill({
        projectId: currentProjectId,
        skillName,
        description: manualSkillDescription.trim() || undefined,
        repo: manualSkillRepo.trim() || undefined,
        path: manualSkillPath.trim() || undefined,
        localPath: manualSkillLocalPath.trim() || undefined,
        tags: manualSkillTags
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setManualSkillName("");
      setManualSkillDescription("");
      setManualSkillRepo("");
      setManualSkillPath("");
      setManualSkillLocalPath("");
      setManualSkillTags("");
      await listSkillMarketInstalls(currentProjectId).then(setSkillInstalls);
    } catch (e) {
      setManualSkillError(e instanceof Error ? e.message : "添加 Skill 失败");
    }
  };

  useEffect(() => {
    if (!definitions.length) return;
    setSkillAppendDefinitionId((prev) =>
      prev && definitions.some((b) => b.definition.id === prev) ? prev : definitions[0]!.definition.id
    );
  }, [definitions]);

  const selectedBundle = useMemo(
    () => definitions.find((item) => item.definition.id === selectedDefinitionId) ?? null,
    [definitions, selectedDefinitionId]
  );

  useEffect(() => {
    if (!selectedDefinitionId) return;
    void Promise.all([getAgentDefinitionPack(selectedDefinitionId), getAgentDefinitionMemoryStats(selectedDefinitionId)])
      .then(([pack, mem]) => {
        setAgentPack(pack);
        setAgentMemoryStats(mem);
        setFileAgentMd(pack.agentMarkdown ?? "");
        setFileSoulMd(pack.soulMarkdown);
        setFilePromptMd(pack.promptMarkdown);
        setFileUserMd(pack.userMarkdown ?? "");
        setFileMemoryMd(pack.memoryMarkdown ?? "");
      })
      .catch(() => {
        setAgentPack(null);
        setAgentMemoryStats(null);
        setFileAgentMd("");
        setFileUserMd("");
        setFileMemoryMd("");
      });
  }, [selectedDefinitionId]);

  useEffect(() => {
    if (!selectedDefinitionId) return;
    if (prevAgentDefId.current === selectedDefinitionId) return;
    prevAgentDefId.current = selectedDefinitionId;
    const b = definitions.find((x) => x.definition.id === selectedDefinitionId);
    if (!b) return;
    setDraftPrompt(b.draft?.systemPrompt ?? b.definition.systemPrompt);
    setDraftSoul(b.profile?.soulFileRef ?? "");
    setDraftPromptMode((b.profile?.promptMode as "db_primary" | "file_primary" | "merged") ?? "db_primary");
    setDraftMemoryNamespace(b.profile?.memoryNamespace ?? "");
    setDraftConfigRootUri(b.profile?.configRootUri ?? "");
    setDraftMcpServerNames(parseAgentMcpServerNames(b.draft?.mcpServersJson ?? b.definition.mcpServersJson));
    setDraftDisplayName(b.profile?.displayName?.trim() || agentDisplayLabel(b));
    setDraftDescription(b.profile?.description ?? "");
    const parseStrList = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [];
    setDraftTools(parseStrList(b.draft?.toolsJson ?? b.definition.toolsJson));
    setDraftMaxIterations(b.draft?.maxIterations ?? b.definition.maxIterations ?? 20);
    setDraftSkills(parseStrList(b.draft?.skillsJson ?? b.definition.skillsJson));
    setDraftSubscriptions(parseStrList(b.draft?.subscriptionsJson ?? b.definition.subscriptionsJson));
    setDraftPromptTemplateRef(b.profile?.promptTemplateRef ?? "");
    setDraftLlmProvider(b.draft?.llmProvider ?? b.definition.llmProvider ?? "");
  }, [selectedDefinitionId, definitions]);

  const knownToolPool = useMemo(() => {
    const s = new Set<string>();
    for (const b of definitions) {
      const raw = b.draft?.toolsJson ?? b.definition.toolsJson;
      if (Array.isArray(raw)) {
        for (const x of raw) {
          if (typeof x === "string" && x.trim()) s.add(x.trim());
        }
      }
    }
    return Array.from(s).sort();
  }, [definitions]);

  const mcpServerBindingCount = useMemo(() => {
    const map = new Map<string, number>();
    const did = selectedDefinitionId || undefined;
    for (const row of mcpBindings) {
      if (did) {
        if (row.definitionId && row.definitionId !== did) continue;
      } else if (row.definitionId) continue;
      map.set(row.serverName, (map.get(row.serverName) ?? 0) + 1);
    }
    return map;
  }, [mcpBindings, selectedDefinitionId]);

  const pickBindingForMcpServer = (serverName: string): McpToolBindingRecord | undefined => {
    const pid = currentProjectId || undefined;
    const did = selectedDefinitionId || undefined;
    const forServer = mcpBindings.filter((b) => b.serverName === serverName);
    const score = (b: McpToolBindingRecord) => {
      let s = 0;
      if (did) {
        if (b.definitionId === did) s += 100;
        else if (b.definitionId == null) s += 10;
        else return -1;
      } else {
        if (b.definitionId != null) return -1;
        s += 10;
      }
      if (pid) {
        if (b.projectId === pid) s += 50;
        else if (b.projectId == null) s += 5;
        else return -1;
      } else {
        if (b.projectId != null) return -1;
        s += 5;
      }
      return s;
    };
    const pool = forServer.filter((b) => score(b) >= 0);
    const sorted = [...pool].sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return 0;
    });
    return sorted.find((b) => b.enabled) ?? sorted[0];
  };

  const mcpConnectionSpecOk = (row: McpServerConfigRecord): boolean => {
    if (!row.enabled) return false;
    if (row.transport === "stdio") return Boolean(row.command?.trim());
    return Boolean(row.url?.trim());
  };

  /** 探测用真实工具名：通配 `*` 不能直接 RPC，回退到 capabilities / ping。 */
  const resolveMcpProbeToolName = (
    row: McpServerConfigRecord,
    binding?: McpToolBindingRecord
  ): string => {
    const fromBind = binding?.toolName?.trim();
    if (fromBind && fromBind !== "*") return fromBind;
    const caps = row.capabilitiesJson;
    if (caps && typeof caps === "object" && !Array.isArray(caps)) {
      const tools = (caps as { tools?: unknown }).tools;
      if (Array.isArray(tools)) {
        for (const item of tools) {
          if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
            const name = (item as { name: string }).name.trim();
            if (name && name !== "*") return name;
          }
        }
      }
    }
    return "ping";
  };

  const formatMcpProbeDetail = (e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const jsonMatch = raw.match(/^HTTP \d+:([\s\S]*)$/);
    if (jsonMatch?.[1]) {
      try {
        const body = JSON.parse(jsonMatch[1].trim()) as unknown;
        return typeof body === "string" ? body : JSON.stringify(body, null, 2);
      } catch {
        return raw;
      }
    }
    return raw;
  };

  const probeMcpServer = async (row: McpServerConfigRecord, binding?: McpToolBindingRecord) => {
    const key = row.name;
    if (!mcpConnectionSpecOk(row)) {
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "error",
          message: !row.enabled ? "Server 已禁用" : row.transport === "stdio" ? "缺少 command" : "缺少 url",
          checkedAt: new Date().toISOString(),
        },
      }));
      return;
    }
    const bind = binding ?? pickBindingForMcpServer(row.name);
    const toolName = resolveMcpProbeToolName(row, bind);
    setMcpProbeByServer((prev) => ({
      ...prev,
      [key]: { status: "checking", checkedAt: new Date().toISOString() },
    }));
    try {
      const out = await testMcpCall({
        projectId: currentProjectId || undefined,
        serverName: row.name,
        toolName,
        arguments: { ping: true, ts: Date.now() },
      });
      setMcpTestOutput(JSON.stringify(out, null, 2));
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "ok",
          message: out.accepted ? `工具「${toolName}」调用成功` : `工具「${toolName}」返回未接受`,
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (e) {
      const msg = formatMcpProbeDetail(e);
      setMcpTestOutput(msg);
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: { status: "error", message: msg, checkedAt: new Date().toISOString() },
      }));
    }
  };

  const buildMcpAdvancedPayload = (row: McpServerConfigRecord, bind?: McpToolBindingRecord) => ({
    server: {
      id: row.id,
      name: row.name,
      projectId: row.projectId,
      transport: row.transport,
      command: row.command?.trim() ? String(row.command) : "",
      url: row.url?.trim() ? String(row.url) : "",
      capabilitiesJson: row.capabilitiesJson,
      enabled: row.enabled,
    },
    binding: bind
      ? {
          id: bind.id,
          projectId: bind.projectId,
          serverName: bind.serverName,
          toolName: bind.toolName,
          enabled: bind.enabled,
          timeoutMs: bind.timeoutMs ?? 20_000,
          retryPolicyJson: bind.retryPolicyJson,
          rateLimitJson: bind.rateLimitJson,
        }
      : null,
  });

  const openMcpAdvancedEditor = (row: McpServerConfigRecord) => {
    const bind = pickBindingForMcpServer(row.name);
    setMcpAdvancedJsonDraft(JSON.stringify(buildMcpAdvancedPayload(row, bind), null, 2));
    setMcpAdvancedJsonError("");
    setMcpTestOutput("");
    setSelectedMcpServer(row.name);
    setFocusedMcpServerId(row.id);
    setMcpAdvancedEditorOpen(true);
    if (bind) {
      setMcpToolName(bind.toolName);
      if (typeof bind.timeoutMs === "number" && Number.isFinite(bind.timeoutMs)) {
        setMcpTimeoutMs(bind.timeoutMs);
      }
    }
    void probeMcpServer(row, bind);
  };

  const saveMcpAdvancedJson = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mcpAdvancedJsonDraft || "{}");
    } catch {
      setMcpAdvancedJsonError("JSON 解析失败，请检查语法");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setMcpAdvancedJsonError("根节点须为对象，且包含 server 字段");
      return;
    }
    const root = parsed as Record<string, unknown>;
    const server = root["server"];
    if (!server || typeof server !== "object") {
      setMcpAdvancedJsonError("缺少 server 对象");
      return;
    }
    const s = server as Record<string, unknown>;
    const name = typeof s["name"] === "string" ? s["name"].trim() : "";
    const transport = s["transport"];
    if (!name || (transport !== "stdio" && transport !== "http" && transport !== "ws")) {
      setMcpAdvancedJsonError("server.name 与 server.transport（stdio|http|ws）为必填");
      return;
    }
    const cmd = typeof s["command"] === "string" ? s["command"].trim() : "";
    const url = typeof s["url"] === "string" ? s["url"].trim() : "";
    const caps = s["capabilitiesJson"];
    const enabled = typeof s["enabled"] === "boolean" ? s["enabled"] : true;
    const proj =
      typeof s["projectId"] === "string" && s["projectId"].trim()
        ? s["projectId"].trim()
        : currentProjectId || undefined;
    try {
      await upsertMcpServer({
        name,
        projectId: proj,
        transport,
        command: cmd || undefined,
        url: url || undefined,
        capabilitiesJson: Array.isArray(caps) ? (caps as unknown[]) : ["tools"],
        enabled,
      });
    } catch (e) {
      setMcpAdvancedJsonError(e instanceof Error ? e.message : String(e));
      return;
    }
    const binding = root["binding"];
    if (binding && typeof binding === "object") {
      const b = binding as Record<string, unknown>;
      const toolName = typeof b["toolName"] === "string" ? b["toolName"].trim() : "";
      if (toolName) {
        const timeoutRaw = b["timeoutMs"];
        const timeoutMs =
          typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
            ? timeoutRaw
            : typeof timeoutRaw === "string" && Number.isFinite(Number(timeoutRaw))
              ? Number(timeoutRaw)
              : 20_000;
        const ben = typeof b["enabled"] === "boolean" ? b["enabled"] : true;
        const retry = b["retryPolicyJson"];
        const rate = b["rateLimitJson"];
        try {
          await upsertMcpBinding({
            projectId: proj,
            serverName: name,
            toolName,
            enabled: ben,
            timeoutMs,
            retryPolicyJson:
              retry && typeof retry === "object" ? (retry as Record<string, unknown>) : { maxAttempts: 2, backoffMs: 300 },
            rateLimitJson: rate && typeof rate === "object" ? (rate as Record<string, unknown>) : {},
          });
        } catch (e) {
          setMcpAdvancedJsonError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
    }
    setMcpAdvancedJsonError("");
    setMcpServers(await listMcpServers(currentProjectId || undefined));
    setMcpBindings(await listMcpBindings(currentProjectId || undefined));
    setMcpTestOutput("高级 JSON 已保存并同步到数据库");
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const installMarketCatalogItem = async (item: McpCatalogItemRecord) => {
    if (!currentProjectId) return;
    const serverName = item.slug.replace(/[^a-z0-9_-]/gi, "-");
    const toolRaw = item.defaultToolName;
    const toolName = typeof toolRaw === "string" && toolRaw.trim() ? toolRaw.trim() : undefined;
    const toRaw = item.defaultTimeoutMs;
    const timeoutMs =
      typeof toRaw === "number" && Number.isFinite(toRaw)
        ? toRaw
        : typeof toRaw === "string" && Number.isFinite(Number(toRaw))
          ? Number(toRaw)
          : mcpTimeoutMs;
    const cmd = typeof item.command === "string" ? item.command.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    try {
      const installed = await installMcpMarket({
        projectId: currentProjectId,
        catalogItemId: item.id,
        serverName,
        toolName,
        timeoutMs,
        command: cmd || undefined,
        url: url || undefined,
      });
      setSelectedCatalogId(item.id);
      setCatalogServerName(serverName);
      if (toolName) setMcpToolName(toolName);
      setMcpTimeoutMs(timeoutMs);
      setMcpMarketInstalls((prev) => [installed, ...prev].slice(0, 30));
      setMcpServers(await listMcpServers(currentProjectId));
      setMcpBindings(await listMcpBindings(currentProjectId));
      setSelectedMcpServer(installed.serverName);
      setMcpTestOutput(`已从市场安装：${item.name} → ${installed.serverName}`);
    } catch (e) {
      setMcpTestOutput(e instanceof Error ? e.message : String(e));
    }
  };

  const saveMcpBindingNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const row = await upsertMcpBinding({
      projectId: currentProjectId || undefined,
      serverName: selectedMcpServer,
      toolName: mcpToolName.trim(),
      enabled: true,
      timeoutMs: mcpTimeoutMs,
      retryPolicyJson: { maxAttempts: 2, backoffMs: 300 },
      rateLimitJson: {},
    });
    setMcpTestOutput(`binding saved: ${row.serverName}/${row.toolName}`);
    setMcpBindings(await listMcpBindings(currentProjectId || undefined));
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[row.serverName];
      return next;
    });
  };

  const testMcpNow = async () => {
    if (!selectedMcpServer || !mcpToolName.trim()) return;
    const key = selectedMcpServer;
    setMcpProbeByServer((prev) => ({
      ...prev,
      [key]: { status: "checking", checkedAt: new Date().toISOString() },
    }));
    try {
      const out = await testMcpCall({
        projectId: currentProjectId || undefined,
        serverName: selectedMcpServer,
        toolName: mcpToolName.trim(),
        arguments: { ping: true, ts: Date.now() },
      });
      setMcpTestOutput(JSON.stringify(out, null, 2));
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: {
          status: "ok",
          message: out.accepted ? `工具「${mcpToolName.trim()}」调用成功` : "返回未接受",
          checkedAt: new Date().toISOString(),
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMcpTestOutput(msg);
      setMcpProbeByServer((prev) => ({
        ...prev,
        [key]: { status: "error", message: msg, checkedAt: new Date().toISOString() },
      }));
    }
  };

  const upsertMcpServerNow = async () => {
    if (!newMcpServerName.trim()) return;
    const saved = await upsertMcpServer({
      projectId: currentProjectId || undefined,
      name: newMcpServerName.trim(),
      transport: newMcpServerTransport,
      command: newMcpServerCommand.trim() || undefined,
      url: newMcpServerUrl.trim() || undefined,
      capabilitiesJson: ["tools"],
      enabled: true,
    });
    setSelectedMcpServer(saved.name);
    setMcpServers(await listMcpServers(currentProjectId || undefined));
    setMcpProbeByServer((prev) => {
      const next = { ...prev };
      delete next[saved.name];
      return next;
    });
    setMcpTestOutput(`server upserted: ${saved.name}`);
  };

  const saveSourceNow = async () => {
    const saved = await upsertMcpSource({
      id: selectedSourceId || undefined,
      name: sourceName.trim(),
      baseUrl: sourceBaseUrl.trim(),
      authType: sourceAuthType,
      authRef: sourceAuthRef.trim() || undefined,
      enabled: true,
      isDefault: true,
    });
    setSelectedSourceId(saved.id);
    setMcpSources(await listMcpSources());
  };

  const syncSourceNowAction = async () => {
    if (!selectedSourceId) return;
    setMcpMarketLoading(true);
    try {
      const out = await syncMcpSource(selectedSourceId);
      setMcpTestOutput(`source synced: ${out.syncedCount}, fallback=${out.usedFallback}`);
      await loadMcpMarketPage(1);
    } finally {
      setMcpMarketLoading(false);
    }
  };

  const searchMarketNow = async () => {
    await loadMcpMarketPage(1);
  };

  const installMarketItemNow = async () => {
    if (!currentProjectId || !selectedCatalogId || !catalogServerName.trim()) return;
    const installed = await installMcpMarket({
      projectId: currentProjectId,
      catalogItemId: selectedCatalogId,
      serverName: catalogServerName.trim(),
      toolName: mcpToolName.trim() || undefined,
      timeoutMs: mcpTimeoutMs,
    });
    setMcpMarketInstalls((prev) => [installed, ...prev].slice(0, 30));
    setMcpServers(await listMcpServers(currentProjectId));
    setMcpBindings(await listMcpBindings(currentProjectId));
    setSelectedMcpServer(installed.serverName);
  };

  const testProjectInstallNow = async () => {
    if (!mcpMarketInstalls[0]) return;
    const out = await testMcpProjectInstall({
      installId: mcpMarketInstalls[0].id,
      toolName: mcpToolName.trim() || undefined,
    });
    setMcpTestOutput(JSON.stringify(out, null, 2));
  };

  const uninstallMarketInstallNow = async (installId: string) => {
    if (!currentProjectId) return;
    await uninstallMcpProjectInstall({ projectId: currentProjectId, installId });
    setMcpMarketInstalls(await listMcpProjectInstalls(currentProjectId));
    setMcpServers(await listMcpServers(currentProjectId));
    setMcpBindings(await listMcpBindings(currentProjectId));
    setMcpTestOutput(`已卸载安装记录 ${installId}`);
  };

  // 定时任务 / 集成的 CRUD 逻辑已下沉到 ScheduledJobsPanel 与 IntegrationCenterPanel。

  return (
    <div data-qb-config-center className="qb-config-center">
      <h2 style={styles.title}>配置中心</h2>
      <div style={styles.actions}>
        <button type="button" className="qb-btn-primary-brand" onClick={() => void loadConfig()}>
          刷新配置
        </button>
        <button
          type="button"
          className="qb-btn-secondary"
          onClick={() =>
            void reloadAgents().then((res) => setReloadSummary({ before: res.before, after: res.after }))
          }
        >
          触发 reload
        </button>
      </div>
      {reloadSummary ? (
        <div style={{ ...styles.meta, marginBottom: 12 }}>
          <span>reload before: {reloadSummary.before}</span>
          <span>reload after: {reloadSummary.after}</span>
        </div>
      ) : null}
      <div className="qb-segmented" role="tablist" aria-label="配置分类">
        {(
          [
            ["llm", "LLM"],
            ["datasources", "数据源"],
            ["mcp", "MCP"],
            ["skills", "Skills"],
            ["agent", "Agent"],
            ["providers", "Providers"],
            ["integration", "集成 / IM"],
            ["schedule", "定时任务"],
            ["runtime", "运行时"],
            ["env", "环境管理"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeConfigSubPage === id}
            className={`qb-segmented__tab${activeConfigSubPage === id ? " qb-segmented__tab--active" : ""}`}
            onClick={() => setConfigSubPage(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.configPageBody}>
        {activeConfigSubPage === "llm" ? (
          <>
            <h3 style={styles.subTitle}>默认 LLM 配置（降级模型）</h3>
            <p className="qb-config-hint">
              此处配置的模型作为<strong>系统默认</strong>，当 Agent 未指定 provider 或
              指定 provider 不可用时自动降级到这里。保存写入 <code>.qubit/model.json</code>。
            </p>
            <div style={styles.form}>
              <select
                style={styles.select}
                value={provider}
                onChange={(e) =>
                  setProvider(
                    e.target.value as "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock"
                  )
                }
              >
                <option value="mock">mock</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="ollama">ollama</option>
                <option value="deepseek">deepseek</option>
                <option value="qwen">qwen</option>
                <option value="zhipu">zhipu</option>
              </select>
              <input style={styles.input} value={modelName} onChange={(e) => setModelName(e.target.value)} />
              <input
                style={styles.input}
                type="password"
                autoComplete="new-password"
                value={modelApiKey}
                placeholder={modelApiKeyConfigured ? "已配置；输入新值可替换" : "输入 API Key"}
                onChange={(e) => setModelApiKey(e.target.value)}
              />
              <input style={styles.input} value={modelBaseUrl} onChange={(e) => setModelBaseUrl(e.target.value)} />
              <button
                className="qb-btn-primary-brand"
                onClick={() => {
                  void saveModelConfig({
                    provider,
                    model: modelName,
                    ...(modelApiKey.trim() ? { apiKey: modelApiKey.trim() } : {}),
                    baseUrl: modelBaseUrl || undefined,
                  }).then((saved) => {
                    setModelApiKey("");
                    setModelApiKeyConfigured(Boolean(saved.apiKeyConfigured));
                  });
                }}
              >
                保存默认配置
              </button>
            </div>

            <h3 style={{ ...styles.subTitle, marginTop: 24 }}>Embedding 模型（向量化）</h3>
            <p className="qb-config-hint">
              用于 Experience / Memory 等落库前的文本向量化。默认走 OpenAI-compatible
              Embeddings API（如 <code>text-embedding-3-small</code>）。API Key / Base URL
              留空时复用上方默认 LLM 凭证，再回退 <code>OPENAI_API_KEY</code>。
            </p>
            <div style={styles.form}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--qb-body-fg)",
                }}
              >
                <input
                  type="checkbox"
                  checked={embeddingEnabled}
                  onChange={(e) => setEmbeddingEnabled(e.target.checked)}
                />
                启用 Embedding（关闭后召回降级为 keyword-only）
              </label>
              <input
                style={styles.input}
                value={embeddingModel}
                placeholder="模型名，如 text-embedding-3-small"
                onChange={(e) => setEmbeddingModel(e.target.value)}
              />
              <input
                style={styles.input}
                type="password"
                autoComplete="new-password"
                value={embeddingApiKey}
                placeholder={
                  embeddingApiKeyConfigured
                    ? "Embedding API Key 已配置；输入新值可替换（留空则复用默认 LLM Key）"
                    : "Embedding API Key（可选；留空复用默认 LLM / OPENAI_API_KEY）"
                }
                onChange={(e) => setEmbeddingApiKey(e.target.value)}
              />
              <input
                style={styles.input}
                value={embeddingBaseUrl}
                placeholder="Embedding Base URL（可选；留空复用默认 LLM）"
                onChange={(e) => setEmbeddingBaseUrl(e.target.value)}
              />
              <input
                style={styles.input}
                value={embeddingDimensions}
                placeholder="输出维度（可选，如 1536；仅部分模型支持）"
                onChange={(e) => setEmbeddingDimensions(e.target.value)}
              />
              {embeddingRuntimeHint ? (
                <p className="qb-config-hint qb-config-hint--tight" style={{ margin: 0 }}>
                  运行时：{embeddingRuntimeHint}
                </p>
              ) : null}
              {embeddingTestMsg ? (
                <p className="qb-config-hint qb-config-hint--tight" style={{ margin: 0 }}>
                  {embeddingTestMsg}
                </p>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="qb-btn-primary-brand"
                  disabled={embeddingBusy}
                  onClick={() => {
                    const dimRaw = embeddingDimensions.trim();
                    const dimParsed = dimRaw ? Number(dimRaw) : null;
                    if (dimRaw && (!Number.isFinite(dimParsed) || (dimParsed ?? 0) <= 0)) {
                      setEmbeddingTestMsg("维度必须是正整数");
                      return;
                    }
                    setEmbeddingBusy(true);
                    setEmbeddingTestMsg(null);
                    void saveModelConfig({
                      embedding: {
                        enabled: embeddingEnabled,
                        model: embeddingModel.trim() || "text-embedding-3-small",
                        ...(embeddingApiKey.trim()
                          ? { apiKey: embeddingApiKey.trim() }
                          : {}),
                        baseUrl: embeddingBaseUrl.trim() || undefined,
                        dimensions: dimParsed,
                      },
                    })
                      .then((saved) => {
                        setEmbeddingApiKey("");
                        setEmbeddingApiKeyConfigured(Boolean(saved.embedding?.apiKeyConfigured));
                        setEmbeddingEnabled(saved.embedding?.enabled ?? true);
                        setEmbeddingModel(saved.embedding?.model ?? "text-embedding-3-small");
                        setEmbeddingBaseUrl(saved.embedding?.baseUrl ?? "");
                        setEmbeddingDimensions(
                          saved.embedding?.dimensions != null
                            ? String(saved.embedding.dimensions)
                            : ""
                        );
                        const rt = saved.embedding?.runtime;
                        setEmbeddingRuntimeHint(
                          rt
                            ? rt.configured
                              ? `就绪 · ${rt.model ?? "?"} · dim=${rt.dimension ?? "?"} · source=${rt.source}`
                              : `未就绪 · source=${rt.source}`
                            : "已保存"
                        );
                        setEmbeddingTestMsg("Embedding 配置已保存");
                      })
                      .catch((err: unknown) => {
                        setEmbeddingTestMsg(
                          `保存失败：${err instanceof Error ? err.message : String(err)}`
                        );
                      })
                      .finally(() => setEmbeddingBusy(false));
                  }}
                >
                  保存 Embedding 配置
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={embeddingBusy}
                  onClick={() => {
                    setEmbeddingBusy(true);
                    setEmbeddingTestMsg(null);
                    void testEmbeddingModelConfig()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setEmbeddingTestMsg(
                            `探测成功：${res.data.model} · dim=${res.data.dimension} · ${res.data.latencyMs}ms · tokens=${res.data.tokensUsed}`
                          );
                        } else {
                          setEmbeddingTestMsg(`探测失败：${res.error ?? "unknown"}`);
                        }
                      })
                      .catch((err: unknown) => {
                        setEmbeddingTestMsg(
                          `探测失败：${err instanceof Error ? err.message : String(err)}`
                        );
                      })
                      .finally(() => setEmbeddingBusy(false));
                  }}
                >
                  测试 Embedding
                </button>
              </div>
            </div>

            <h3 style={{ ...styles.subTitle, marginTop: 24 }}>多 LLM Provider（per-Agent 路由）</h3>
            <p className="qb-config-hint">
              新增不同的模型 provider 后，可在 Agent 编辑页把指定 Agent 路由到不同模型
              （如 def-research 用 Claude、def-orchestrator 用 GPT）。任一 provider 失败
              会自动降级到上方的默认模型。
            </p>
            <LlmProvidersList />
          </>
        ) : null}
        {activeConfigSubPage === "datasources" ? (
          <>
            <h3 style={styles.subTitle}>数据源（qubit-data / qubit-news）</h3>
            <p className="qb-config-hint qb-config-hint--tight">
              在客户端填写后写入本机数据库（~/.quant-agent/db），启动时与保存后都会重新注入连接器；无需环境变量。
              <br />
              K 线数据源 <code style={{ fontSize: 11 }}>klinesDataSource</code>：默认「自动」为 A 股优先{" "}
              <strong>东方财富</strong>；配置 Wind 账号后 A 股可走 <strong>Wind</strong>；加密货币走 <strong>Binance</strong>；
              有 Tushare token 时 A 股日线可走 Tushare；美股等走 Yahoo。
            </p>
            <div style={{ ...styles.form, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <span style={{ whiteSpace: "nowrap" }}>K 线数据源</span>
                <select
                  style={styles.select}
                  value={klinesDataSource}
                  onChange={(e) =>
                    setKlinesDataSource(
                      e.target.value as
                        | "auto"
                        | "tushare_daily"
                        | "yahoo_chart"
                        | "eastmoney"
                        | "akshare"
                        | "akshare_tencent"
                        | "yfinance"
                        | "binance_crypto"
                        | "wind"
                        | "synthetic"
                    )
                  }
                >
                  <option value="auto">自动（A 股 → 东方财富 / 有 Wind 账号 → Wind；加密 → Binance；有 Tushare → 日线；其它 → Yahoo）</option>
                  <option value="eastmoney">东方财富（A 股日线 + 分钟/小时，免费）</option>
                  <option value="wind">Wind 万得（需本地终端 + WindPy）</option>
                  <option value="binance_crypto">Binance（加密货币 K 线 / 报价，公开 API）</option>
                  <option value="akshare">AKShare（A 股，需 Python: pip install akshare pandas）</option>
                  <option value="akshare_tencent">腾讯证券 / AKShare（日线独立备用源）</option>
                  <option value="yahoo_chart">Yahoo Finance Chart（TS 直连，免依赖）</option>
                  <option value="yfinance">yfinance（Python，含分红/财报/资产信息；pip install yfinance pandas）</option>
                  <option value="tushare_daily">Tushare 日线（需 token）</option>
                  <option value="synthetic">不拉外源（K 线为空，用于禁用行情）</option>
                </select>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <input
                  type="checkbox"
                  checked={cryptoUseTestnet}
                  onChange={(e) => setCryptoUseTestnet(e.target.checked)}
                />
                Binance 测试网
              </label>
              <input
                style={{ ...styles.input, minWidth: 200 }}
                type="password"
                autoComplete="off"
                value={tushareToken}
                onChange={(e) => setTushareToken(e.target.value)}
                placeholder="Tushare token（仅在选择 Tushare 或自动且有 token 时使用）"
              />
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <span style={{ whiteSpace: "nowrap" }}>行情网络</span>
                <select
                  style={styles.select}
                  value={marketDataNetworkMode}
                  onChange={(e) => setMarketDataNetworkMode(e.target.value as "auto" | "direct" | "proxy")}
                >
                  <option value="auto">自动（配置代理 → 环境代理 → 直连）</option>
                  <option value="direct">强制直连</option>
                  <option value="proxy">强制代理</option>
                </select>
              </label>
              <input
                style={{ ...styles.input, minWidth: 240 }}
                value={marketDataProxyUrl}
                onChange={(e) => setMarketDataProxyUrl(e.target.value)}
                placeholder="代理 URL，例如 http://127.0.0.1:7896"
              />
            </div>
            {(klinesDataSource === "wind" || klinesDataSource === "auto") ? (
              <div style={{ ...styles.form, flexWrap: "wrap", alignItems: "flex-end" }}>
                <input
                  style={{ ...styles.input, minWidth: 160 }}
                  value={windUsername}
                  onChange={(e) => setWindUsername(e.target.value)}
                  placeholder="Wind 账号（可选，终端已登录可留空）"
                  autoComplete="username"
                />
                <input
                  style={{ ...styles.input, minWidth: 160 }}
                  type="password"
                  value={windPassword}
                  onChange={(e) => setWindPassword(e.target.value)}
                  placeholder="Wind 密码（可选）"
                  autoComplete="current-password"
                />
                <input
                  style={{ ...styles.input, width: 100 }}
                  type="number"
                  min={10}
                  max={300}
                  value={windStartWaitSec}
                  onChange={(e) => setWindStartWaitSec(Number(e.target.value))}
                  placeholder="等待秒"
                  title="w.start 等待 Wind 终端响应的最长时间（秒）"
                />
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                  <input
                    type="checkbox"
                    checked={windAutoLogin}
                    onChange={(e) => setWindAutoLogin(e.target.checked)}
                  />
                  凭据自动登录
                </label>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void getWindSessionStatus()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "查询 Wind 登录态失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  {windSessionBusy ? "查询中…" : "查询登录态"}
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void loginWindSession({
                      username: windUsername.trim() || undefined,
                      password: windPassword.trim() || undefined,
                      startWaitSec: windStartWaitSec,
                    })
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "Wind 登录失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  登录 Wind
                </button>
                <button
                  type="button"
                  className="qb-btn-secondary"
                  disabled={windSessionBusy}
                  onClick={() => {
                    setWindSessionBusy(true);
                    setWindSessionError("");
                    void reconnectWindSession()
                      .then((res) => {
                        if (res.ok && res.data) {
                          setWindSession(res.data);
                        } else {
                          setWindSessionError(res.error ?? "Wind 重连失败");
                        }
                      })
                      .catch((e) => setWindSessionError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setWindSessionBusy(false));
                  }}
                >
                  重新连接
                </button>
                {windSession ? (
                  <span style={{ fontSize: 12, color: windSession.connected ? "var(--qb-success-fg, #0a0)" : "var(--qb-warn-fg, #a60)" }}>
                    {windSession.connected
                      ? `已连接${windSession.userId ? ` · ${windSession.userId}` : ""}`
                      : `未连接 · ${windSession.message}`}
                  </span>
                ) : null}
                {windSessionError ? (
                  <span style={{ fontSize: 12, color: "var(--qb-danger-fg, #c00)" }}>{windSessionError}</span>
                ) : null}
              </div>
            ) : null}
            <div style={{ ...styles.form, flexWrap: "wrap" }}>
              <input
                style={{ ...styles.input, minWidth: 200 }}
                value={newsApiBaseUrl}
                onChange={(e) => setNewsApiBaseUrl(e.target.value)}
                placeholder="新闻 API Base URL"
              />
              <input
                style={{ ...styles.input, minWidth: 160 }}
                type="password"
                autoComplete="off"
                value={newsApiKey}
                onChange={(e) => setNewsApiKey(e.target.value)}
                placeholder="API Key（可选）"
              />
              <input
                style={{ ...styles.input, width: 120 }}
                value={newsFetchPath}
                onChange={(e) => setNewsFetchPath(e.target.value)}
                placeholder="路径，默认 /"
              />
              <input
                style={{ ...styles.input, width: 100 }}
                type="number"
                value={newsTimeoutMs}
                onChange={(e) => setNewsTimeoutMs(Number(e.target.value))}
                placeholder="超时 ms"
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--qb-body-fg)" }}>
                <input
                  type="checkbox"
                  checked={newsSyntheticWhenEmpty}
                  onChange={(e) => setNewsSyntheticWhenEmpty(e.target.checked)}
                />
                空结果时回落 stub
              </label>
              <button
                className="qb-btn-primary-brand"
                onClick={() =>
                  void saveBuiltinConnectorConfig({
                    "qubit-data": {
                      klinesDataSource,
                      tushareToken: tushareToken.trim() || undefined,
                      windUsername: windUsername.trim() || undefined,
                      windPassword: windPassword.trim() || undefined,
                      windStartWaitSec,
                      windAutoLogin: windAutoLogin || undefined,
                      cryptoUseTestnet: cryptoUseTestnet || undefined,
                      marketDataNetworkMode,
                      marketDataProxyUrl: marketDataProxyUrl.trim() || undefined,
                    },
                    "qubit-news": {
                      newsApiBaseUrl: newsApiBaseUrl.trim() || undefined,
                      newsApiKey: newsApiKey.trim() || undefined,
                      newsFetchPath: newsFetchPath.trim() || "/",
                      newsTimeoutMs,
                      syntheticWhenEmpty: newsSyntheticWhenEmpty,
                    },
                  }).then(hydrateBuiltinConnectorForm)
                }
              >
                保存数据源配置
              </button>
            </div>
          </>
        ) : null}
        {activeConfigSubPage === "plugins" ? (
          <PluginsPanel
            projectId={currentProjectId}
            onOpenMcp={() => setConfigSubPage("mcp")}
            onOpenSkills={() => setConfigSubPage("skills")}
          />
        ) : null}
        {activeConfigSubPage === "mcp" ? (
          <>
            <h3 style={styles.subTitle}>已注册的 MCP</h3>
            <p className="qb-config-hint">
              保存并启用 Server 即可使用；默认自动覆盖全部工具（通配策略）。点击卡片打开<strong>高级 JSON 编辑</strong>，打开时会尝试探测连通性。
            </p>
            <div style={styles.meta}>
              <span>Server: {mcpServers.length}</span>
              <span>策略行: {mcpBindings.length}</span>
              <span>市场安装: {mcpMarketInstalls.length}</span>
            </div>
            <div style={styles.grid}>
              {mcpServers.length === 0 ? (
                <div style={{ ...styles.card, color: "var(--qb-main-meta)", fontSize: 13 }}>暂无 MCP，可从下方市场安装或使用「快速添加」。</div>
              ) : null}
              {mcpServers.map((row) => {
                const probe = mcpProbeByServer[row.name];
                const specOk = mcpConnectionSpecOk(row);
                const bindCount = mcpServerBindingCount.get(row.name) ?? 0;
                const shortMsg = (m?: string) => (!m ? "" : m.length > 56 ? `${m.slice(0, 56)}…` : m);
                const cfgPill =
                  !row.enabled
                    ? { bg: "var(--qb-pill-disabled-bg)", color: "var(--qb-pill-disabled-fg)", text: "配置：已禁用" }
                    : !specOk
                      ? {
                          bg: "var(--qb-pill-warn-bg)",
                          color: "var(--qb-pill-warn-fg)",
                          text: row.transport === "stdio" ? "配置：缺少 command" : "配置：缺少 url",
                        }
                      : { bg: "var(--qb-pill-ok-bg)", color: "var(--qb-pill-ok-fg)", text: "配置：就绪" };
                const reachPill =
                  probe?.status === "checking"
                    ? { bg: "var(--qb-pill-info-bg)", color: "var(--qb-pill-info-fg)", text: "连通：检测中…" }
                    : probe?.status === "ok"
                      ? {
                          bg: "var(--qb-pill-success-bg)",
                          color: "var(--qb-pill-success-fg)",
                          text: `连通：可用${probe.message ? ` · ${shortMsg(probe.message)}` : ""}`,
                        }
                      : probe?.status === "error"
                        ? {
                            bg: "var(--qb-pill-error-bg)",
                            color: "var(--qb-pill-error-fg)",
                            text: `连通：失败${probe.message ? ` · ${shortMsg(probe.message)}` : ""}`,
                          }
                        : specOk
                          ? { bg: "var(--qb-pill-muted-bg)", color: "var(--qb-pill-muted-fg)", text: "连通：打开卡片以检测" }
                          : { bg: "var(--qb-pill-muted-bg)", color: "var(--qb-pill-muted-fg)", text: "连通：待检测" };
                const dotColor =
                  probe?.status === "checking"
                    ? "#60a5fa"
                    : probe?.status === "ok"
                      ? "#22c55e"
                      : probe?.status === "error"
                        ? "#ef4444"
                        : !row.enabled
                          ? "#52525b"
                          : !specOk
                            ? "#f97316"
                            : "#eab308";
                const selected = focusedMcpServerId === row.id && mcpAdvancedEditorOpen;
                return (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => openMcpAdvancedEditor(row)}
                    title="点击打开高级 JSON 编辑"
                    style={{
                      ...styles.card,
                      ...styles.mcpCardBtn,
                      ...(selected ? styles.mcpCardBtnSelected : {}),
                    }}
                  >
                    <div style={styles.mcpCardTopRow}>
                      <span
                        style={{
                          ...styles.mcpStatusDot,
                          background: dotColor,
                          boxShadow:
                            probe?.status === "checking" ? "0 0 0 3px rgba(96,165,250,0.35)" : undefined,
                        }}
                        aria-hidden
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={styles.cardName}>{row.name}</div>
                        <div style={styles.cardDesc}>
                          {row.transport} · {row.enabled ? "启用" : "禁用"}
                          {bindCount > 0 ? ` · ${bindCount} 条策略` : ""}
                        </div>
                        <div style={styles.cardDesc}>
                          {row.projectId ? `项目: ${row.projectId.slice(0, 8)}…` : "作用域: 全局"}
                        </div>
                      </div>
                    </div>
                    <div style={styles.mcpCardPillRow}>
                      <span style={{ ...styles.mcpCardPill, background: cfgPill.bg, color: cfgPill.color }}>{cfgPill.text}</span>
                      <span style={{ ...styles.mcpCardPill, background: reachPill.bg, color: reachPill.color }}>
                        {reachPill.text}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>快速添加 MCP Server（表单）</summary>
              <div style={{ ...styles.form, paddingBottom: 10 }}>
                <input
                  style={styles.input}
                  value={newMcpServerName}
                  onChange={(e) => setNewMcpServerName(e.target.value)}
                  placeholder="server name"
                />
                <select
                  style={styles.select}
                  value={newMcpServerTransport}
                  onChange={(e) => setNewMcpServerTransport(e.target.value as "stdio" | "http" | "ws")}
                >
                  <option value="stdio">stdio</option>
                  <option value="http">http</option>
                  <option value="ws">ws</option>
                </select>
                <input
                  style={styles.input}
                  value={newMcpServerCommand}
                  onChange={(e) => setNewMcpServerCommand(e.target.value)}
                  placeholder="command (stdio)"
                />
                <input
                  style={styles.input}
                  value={newMcpServerUrl}
                  onChange={(e) => setNewMcpServerUrl(e.target.value)}
                  placeholder="url (http/ws)"
                />
                <button className="qb-btn-secondary" type="button" onClick={() => void upsertMcpServerNow()}>
                  保存 Server
                </button>
              </div>
            </details>

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>高级：超时 / 重试策略与快速测试（可选）</summary>
              <p className="qb-config-hint" style={{ marginTop: 0 }}>
                保存 Server 已自动启用全部工具。此处仅在需要按工具覆盖 timeout、或手动探测某个工具时使用；tool name 填 <code>*</code> 表示整 server 默认策略。
              </p>
              <div style={{ ...styles.form, paddingBottom: 10, flexWrap: "wrap" }}>
                <select
                  style={styles.select}
                  value={selectedMcpServer}
                  onChange={(e) => setSelectedMcpServer(e.target.value)}
                >
                  {mcpServers.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name} · {s.transport}
                    </option>
                  ))}
                </select>
                <input
                  style={styles.input}
                  value={mcpToolName}
                  onChange={(e) => setMcpToolName(e.target.value)}
                  placeholder="tool name 或 *"
                />
                <input
                  style={styles.input}
                  type="number"
                  value={mcpTimeoutMs}
                  onChange={(e) => setMcpTimeoutMs(Number(e.target.value))}
                  placeholder="timeout ms"
                />
                <button className="qb-btn-secondary" type="button" onClick={() => void saveMcpBindingNow()}>
                  保存策略
                </button>
                <button className="qb-btn-primary-brand" type="button" onClick={() => void testMcpNow()}>
                  测试 MCP
                </button>
              </div>
            </details>

            <h3 style={{ ...styles.subTitle, marginTop: 18 }}>MCP 市场</h3>
            <p className="qb-config-hint">
              来自开放注册表的条目；卡片展示目录中的<strong>能力声明</strong>（capabilities、默认工具、启动命令摘要）。市场列表<strong>分页加载</strong>（每页 {MCP_MARKET_PAGE_SIZE} 条），避免一次渲染数千卡片卡顿。「同步目录」从官方 Registry 拉取元数据（可能较慢）；「搜索/刷新」仅查询本地已同步目录。
            </p>

            <details className="qb-mcp-details" style={styles.mcpDetails}>
              <summary style={styles.mcpDetailsSummary}>目录源与鉴权</summary>
              <div style={{ ...styles.form, paddingBottom: 8, flexWrap: "wrap" }}>
                <input
                  style={styles.input}
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="source name"
                />
                <input
                  style={styles.input}
                  value={sourceBaseUrl}
                  onChange={(e) => setSourceBaseUrl(e.target.value)}
                  placeholder="source base url"
                />
                <select
                  style={styles.select}
                  value={sourceAuthType}
                  onChange={(e) => setSourceAuthType(e.target.value as "none" | "bearer" | "api_key")}
                >
                  <option value="none">none</option>
                  <option value="bearer">bearer</option>
                  <option value="api_key">api_key</option>
                </select>
                <input
                  style={styles.input}
                  value={sourceAuthRef}
                  onChange={(e) => setSourceAuthRef(e.target.value)}
                  placeholder="auth ref (optional)"
                />
                <button className="qb-btn-secondary" type="button" onClick={() => void saveSourceNow()}>
                  保存源
                </button>
              </div>
            </details>

            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10 }}>
              <select style={styles.select} value={selectedSourceId} onChange={(e) => setSelectedSourceId(e.target.value)}>
                {mcpSources.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.isDefault ? "default" : "custom"} · {item.enabled ? "enabled" : "disabled"}
                  </option>
                ))}
              </select>
              <input
                style={styles.input}
                value={marketQuery}
                onChange={(e) => setMarketQuery(e.target.value)}
                placeholder="搜索名称 / slug / 描述"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void searchMarketNow();
                }}
              />
              <button
                className="qb-btn-secondary"
                type="button"
                disabled={mcpMarketLoading}
                onClick={() => void syncSourceNowAction()}
              >
                {mcpMarketLoading ? "同步中…" : "同步目录"}
              </button>
              <button
                className="qb-btn-primary-brand"
                type="button"
                disabled={mcpMarketLoading}
                onClick={() => void searchMarketNow()}
              >
                {mcpMarketLoading ? "加载中…" : "搜索"}
              </button>
            </div>

            <div style={{ ...styles.meta, marginBottom: 8 }}>
              {mcpMarketLoading
                ? "正在加载市场列表…"
                : `共 ${mcpMarketTotal.toLocaleString()} 条 · 第 ${mcpMarketPage} / ${mcpMarketTotalPages} 页`}
            </div>

            <div className="qb-mcp-market-grid" style={styles.mcpMarketGrid}>
              {!mcpMarketLoading && mcpMarketItems.length === 0 ? (
                <div className="qb-mcp-market-card qb-mcp-market-card--empty" style={{ ...styles.mcpMarketCard, color: "var(--qb-main-meta)" }}>暂无目录项，请先同步注册表或检查网络。</div>
              ) : null}
              {mcpMarketItems.map((item) => {
                const caps = Array.isArray(item.defaultCapabilitiesJson)
                  ? item.defaultCapabilitiesJson.filter((x): x is string => typeof x === "string")
                  : [];
                const defaultTool = item.defaultToolName;
                const cmdPreview = item.command ?? "";
                const riskBorder =
                  item.riskLevel === "high" ? "#991b1b" : item.riskLevel === "medium" ? "#a16207" : "#166534";
                const selected = selectedCatalogId === item.id;
                return (
                  <div
                    key={item.id}
                    role="button"
                    className={`qb-mcp-market-card${selected ? " qb-mcp-market-card--selected" : ""}`}
                    tabIndex={0}
                    onClick={() => {
                      setSelectedCatalogId(item.id);
                      setCatalogServerName(item.slug.replace(/[^a-z0-9_-]/gi, "-"));
                      if (defaultTool) setMcpToolName(defaultTool);
                      const to = item.defaultTimeoutMs;
                      if (typeof to === "number" && Number.isFinite(to)) setMcpTimeoutMs(to);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedCatalogId(item.id);
                        setCatalogServerName(item.slug.replace(/[^a-z0-9_-]/gi, "-"));
                        if (defaultTool) setMcpToolName(defaultTool);
                        if (Number.isFinite(item.defaultTimeoutMs)) setMcpTimeoutMs(item.defaultTimeoutMs);
                      }
                    }}
                    style={{
                      ...styles.mcpMarketCard,
                      ...(selected ? {} : { borderColor: riskBorder }),
                    }}
                  >
                    <div style={styles.mcpMarketCardHeader}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="qb-mcp-market-card__title" style={{ ...styles.cardName, color: "var(--qb-body-fg)" }}>{item.name}</div>
                        <div className="qb-mcp-market-meta" style={styles.mcpMarketMeta}>
                          {item.provider} · v{item.version} · {item.transport}{" "}
                          <span
                            className="qb-mcp-market-risk"
                            style={{
                              ...styles.mcpMarketRisk,
                              background:
                                item.riskLevel === "high"
                                  ? "rgba(127,29,29,0.45)"
                                  : item.riskLevel === "medium"
                                    ? "rgba(133,77,14,0.45)"
                                    : "rgba(22,101,52,0.45)",
                            }}
                          >
                            风险 {item.riskLevel}
                          </span>
                        </div>
                      </div>
                    </div>
                    <p className="qb-mcp-market-desc" style={styles.mcpMarketDesc}>{item.description || "（无描述）"}</p>
                    <div style={styles.mcpMarketChips}>
                      {caps.length ? caps.map((c) => (
                        <span key={c} className="qb-mcp-market-chip" style={styles.mcpMarketChip}>
                          {c}
                        </span>
                      )) : (
                        <span className="qb-mcp-market-chip" style={{ ...styles.mcpMarketChip, opacity: 0.75 }}>未声明 capabilities</span>
                      )}
                      {defaultTool ? (
                        <span className="qb-mcp-market-chip" style={styles.mcpMarketChip}>默认工具: {defaultTool}</span>
                      ) : null}
                    </div>
                    {cmdPreview ? (
                      <div className="qb-mcp-market-cmd" style={styles.mcpMarketCmd} title={cmdPreview}>
                        {cmdPreview.length > 120 ? `${cmdPreview.slice(0, 120)}…` : cmdPreview}
                      </div>
                    ) : null}
                    <div style={styles.mcpMarketCardActions}>
                      <button
                        type="button"
                        className="qb-btn-primary-brand"
                        disabled={!currentProjectId}
                        onClick={(e) => {
                          e.stopPropagation();
                          void installMarketCatalogItem(item);
                        }}
                      >
                        安装到当前项目
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {mcpMarketTotalPages > 1 ? (
              <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 10, marginBottom: 4, alignItems: "center" }}>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={mcpMarketLoading || mcpMarketPage <= 1}
                  onClick={() => void loadMcpMarketPage(mcpMarketPage - 1)}
                >
                  上一页
                </button>
                <span style={styles.chatMeta}>
                  第 {mcpMarketPage} / {mcpMarketTotalPages} 页
                </span>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={mcpMarketLoading || mcpMarketPage >= mcpMarketTotalPages}
                  onClick={() => void loadMcpMarketPage(mcpMarketPage + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}

            <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 10 }}>
              <input
                style={styles.input}
                value={catalogServerName}
                onChange={(e) => setCatalogServerName(e.target.value)}
                placeholder="安装后的 server 名（可改）"
              />
              <button className="qb-btn-secondary" type="button" onClick={() => void installMarketItemNow()} disabled={!currentProjectId}>
                安装当前选中条目
              </button>
              <button className="qb-btn-primary-brand" type="button" onClick={() => void testProjectInstallNow()}>
                测试最近安装
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
              {mcpMarketInstalls.map((row) => (
                <div key={row.id} style={styles.form}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {row.serverName} · {row.installStatus}
                  </span>
                  <button
                    type="button"
                    className="qb-btn-secondary"
                    onClick={() => void uninstallMarketInstallNow(row.id)}
                    disabled={!currentProjectId}
                  >
                    卸载
                  </button>
                </div>
              ))}
            </div>

            <details style={{ ...styles.mcpDetails, marginTop: 14 }}>
              <summary style={styles.mcpDetailsSummary}>高级：诊断与原始 JSON</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--qb-main-meta)" }}>最近一次操作 / 测试结果</div>
                <pre className="qb-config-stream-box">{mcpTestOutput || "暂无输出"}</pre>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>注册表源 (mcpSources)</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpSources, null, 2)}</pre>
                </details>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>市场安装记录</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpMarketInstalls, null, 2)}</pre>
                </details>
                <details style={styles.mcpDetailsNested}>
                  <summary style={styles.mcpDetailsSummarySmall}>策略列表（含默认 *）</summary>
                  <pre className="qb-config-stream-box">{JSON.stringify(mcpBindings, null, 2)}</pre>
                </details>
              </div>
            </details>

            {mcpAdvancedEditorOpen && focusedMcpServerId ? (
              <div
                style={styles.mcpModalBackdrop}
                role="presentation"
                onClick={() => {
                  setMcpAdvancedEditorOpen(false);
                }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="mcp-adv-title"
                  style={styles.mcpModal}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div style={styles.mcpModalHeader}>
                    <h4 id="mcp-adv-title" style={{ margin: 0, fontSize: 15, color: "var(--qb-body-fg)" }}>
                      高级编辑 · {mcpServers.find((s) => s.id === focusedMcpServerId)?.name ?? ""}
                    </h4>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="qb-btn-secondary"
                        onClick={() => {
                          const row = mcpServers.find((s) => s.id === focusedMcpServerId);
                          if (!row) return;
                          void probeMcpServer(row, pickBindingForMcpServer(row.name));
                        }}
                      >
                        探测连通性
                      </button>
                      <button type="button" className="qb-btn-secondary" onClick={() => setMcpAdvancedEditorOpen(false)}>
                        关闭
                      </button>
                    </div>
                  </div>
                  <div style={styles.mcpModalBody}>
                    <p className="qb-config-hint qb-config-hint--tight">
                      编辑 <code style={{ fontSize: 11 }}>server</code> 与可选的 <code style={{ fontSize: 11 }}>binding</code>
                      。保存将调用 upsert 接口写入数据库。将 <code style={{ fontSize: 11 }}>binding</code> 设为{" "}
                      <code style={{ fontSize: 11 }}>null</code> 可仅更新 server（不删除已有绑定）。
                    </p>
                    {mcpAdvancedJsonError ? <div style={styles.errorBox}>{mcpAdvancedJsonError}</div> : null}
                    {(() => {
                      const row = mcpServers.find((s) => s.id === focusedMcpServerId);
                      const probe = row ? mcpProbeByServer[row.name] : undefined;
                      const showProbePanel =
                        probe?.status === "checking" ||
                        probe?.status === "ok" ||
                        probe?.status === "error" ||
                        Boolean(mcpTestOutput.trim());
                      if (!showProbePanel) return null;
                      const statusLabel =
                        probe?.status === "checking"
                          ? "检测中…"
                          : probe?.status === "ok"
                            ? "可用"
                            : probe?.status === "error"
                              ? "失败"
                              : "—";
                      const statusColor =
                        probe?.status === "checking"
                          ? "var(--qb-pill-info-fg, #93c5fd)"
                          : probe?.status === "ok"
                            ? "var(--qb-pill-success-fg, #86efac)"
                            : probe?.status === "error"
                              ? "var(--qb-pill-error-fg, #fca5a5)"
                              : "var(--qb-main-meta, #a1a1aa)";
                      const detailText =
                        mcpTestOutput.trim() || probe?.message?.trim() || "暂无详情";
                      return (
                        <div
                          style={{
                            ...styles.mcpProbePanel,
                            borderColor:
                              probe?.status === "error"
                                ? "var(--qb-config-error-border, #7f1d1d)"
                                : probe?.status === "ok"
                                  ? "var(--qb-pill-success-border, #14532d)"
                                  : "var(--qb-mcp-json-border, #27272a)",
                          }}
                        >
                          <div style={styles.mcpProbePanelHeader}>
                            <span style={{ fontWeight: 600, color: "var(--qb-body-fg)" }}>连通性探测</span>
                            <span style={{ color: statusColor, fontWeight: 600 }}>{statusLabel}</span>
                            {probe?.checkedAt ? (
                              <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
                                {new Date(probe.checkedAt).toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                          <pre style={styles.mcpProbeFullMsg}>{detailText}</pre>
                          {mcpTestOutput.trim() &&
                          probe?.message?.trim() &&
                          mcpTestOutput.trim() !== probe.message.trim() ? (
                            <>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "var(--qb-main-meta)",
                                  marginTop: 8,
                                  marginBottom: 4,
                                }}
                              >
                                原始响应
                              </div>
                              <pre style={styles.mcpProbeFullMsg}>{mcpTestOutput}</pre>
                            </>
                          ) : null}
                        </div>
                      );
                    })()}
                    <textarea
                      style={styles.mcpJsonTextarea}
                      value={mcpAdvancedJsonDraft}
                      onChange={(e) => setMcpAdvancedJsonDraft(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                  <div style={styles.mcpModalFooter}>
                    <button type="button" className="qb-btn-secondary" onClick={() => setMcpAdvancedEditorOpen(false)}>
                      取消
                    </button>
                    <button type="button" className="qb-btn-primary-brand" onClick={() => void saveMcpAdvancedJson()}>
                      保存 JSON
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {activeConfigSubPage === "skills" ? (
          <>
            <h3 style={styles.subTitle}>Skills 与市场</h3>
            <p className="qb-config-hint">
              默认使用{" "}
              <a href="https://skillsmp.com/docs/api" target="_blank" rel="noreferrer">
                SkillsMP
              </a>{" "}
              实时搜索（与 Claude Code / Codex 等生态兼容）。可选加载{" "}
              <a href="https://github.com/coolzwc/open-skill-market" target="_blank" rel="noreferrer">
                Open Skill Market
              </a>{" "}
              全量 <code>skills.json</code>（体积大、首次较慢）。MCP 目录默认对接 Anthropic 官方{" "}
              <a href="https://registry.modelcontextprotocol.io/docs" target="_blank" rel="noreferrer">
                MCP Registry
              </a>{" "}
              （<code>v0.1/servers</code>）。服务端可配置环境变量 <code>SKILLSMP_API_KEY</code> 提高 SkillsMP 配额。
            </p>
            <div style={styles.meta}>
              <span>Open 索引: {skillMarketStatus?.loaded ? "已加载" : "未加载"}</span>
              <span>Open 条目数: {skillMarketStatus?.skillCount ?? "—"}</span>
              <span>SkillsMP 缓存 id: {skillMarketStatus?.skillsmpCacheSize ?? 0}</span>
              <span>项目安装: {skillInstalls.length}</span>
            </div>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 12 }}>
              <button
                type="button"
                className="qb-btn-secondary"
                disabled={skillRefreshBusy}
                onClick={() => {
                  setSkillRefreshBusy(true);
                  void refreshSkillMarketRegistry({ provider: "skillsmp" })
                    .then(setSkillMarketStatus)
                    .finally(() => setSkillRefreshBusy(false));
                }}
              >
                {skillRefreshBusy ? "刷新中…" : "连通 SkillsMP"}
              </button>
              <button
                type="button"
                className="qb-btn-secondary"
                disabled={skillRefreshBusy}
                onClick={() => {
                  setSkillRefreshBusy(true);
                  void refreshSkillMarketRegistry({ provider: "open" })
                    .then(setSkillMarketStatus)
                    .finally(() => setSkillRefreshBusy(false));
                }}
              >
                加载 Open Skill Market 全量索引
              </button>
              <button
                type="button"
                className="qb-btn-ghost qb-btn--compact"
                onClick={() => void getSkillMarketStatus().then(setSkillMarketStatus)}
              >
                刷新状态
              </button>
            </div>
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>手工添加 Skill</h4>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillName}
                onChange={(e) => setManualSkillName(e.target.value)}
                placeholder="skill name / id"
              />
              <input
                style={{ ...styles.input, minWidth: 260, flex: "1 1 260px" }}
                value={manualSkillDescription}
                onChange={(e) => setManualSkillDescription(e.target.value)}
                placeholder="说明（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 220 }}
                value={manualSkillRepo}
                onChange={(e) => setManualSkillRepo(e.target.value)}
                placeholder="repo URL（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillPath}
                onChange={(e) => setManualSkillPath(e.target.value)}
                placeholder="repo path（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 220 }}
                value={manualSkillLocalPath}
                onChange={(e) => setManualSkillLocalPath(e.target.value)}
                placeholder="local path（可选）"
              />
              <input
                style={{ ...styles.input, minWidth: 180 }}
                value={manualSkillTags}
                onChange={(e) => setManualSkillTags(e.target.value)}
                placeholder="tags，逗号分隔"
              />
              <button
                type="button"
                className="qb-btn-primary-brand"
                disabled={!currentProjectId || !manualSkillName.trim()}
                onClick={() => void installManualSkillNow()}
              >
                添加到项目
              </button>
            </div>
            {manualSkillError ? <div style={styles.errorBox}>{manualSkillError}</div> : null}
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>搜索市场</h4>
            <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
              <label style={{ ...styles.chatMeta, display: "flex", alignItems: "center", gap: 6 }}>
                来源
                <select
                  value={skillMarketProvider}
                  onChange={(e) => setSkillMarketProvider(e.target.value as "skillsmp" | "open")}
                  style={{ ...styles.input, maxWidth: 200 }}
                >
                  <option value="skillsmp">SkillsMP（默认）</option>
                  <option value="open">Open Skill Market（本地索引）</option>
                </select>
              </label>
              <input
                style={{ ...styles.input, minWidth: 220, flex: "1 1 200px" }}
                value={skillSearchQ}
                onChange={(e) => setSkillSearchQ(e.target.value)}
                placeholder={
                  skillMarketProvider === "skillsmp"
                    ? "关键词（SkillsMP 实时搜索）"
                    : "关键词：名称、描述、仓库、标签…（需先加载全量索引）"
                }
              />
              <button
                type="button"
                className="qb-btn-primary-brand"
                disabled={skillSearchBusy}
                onClick={() => void searchSkillMarketNow()}
              >
                {skillSearchBusy ? "搜索中…" : "搜索"}
              </button>
            </div>
            <div style={{ ...styles.meta, marginBottom: 8 }}>
              {skillSearchBusy
                ? "正在搜索…"
                : skillSearchHits.length > 0 || skillMarketTotal > 0
                  ? `共 ${skillMarketTotal.toLocaleString()} 条 · 第 ${skillMarketPage} / ${skillMarketTotalPages} 页`
                  : "输入关键词后搜索"}
            </div>
            <div style={{ overflowX: "auto", marginBottom: 18 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                    <th style={{ padding: "6px 8px" }}>name</th>
                    <th style={{ padding: "6px 8px" }}>描述</th>
                    <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>★ Stars</th>
                    <th style={{ padding: "6px 8px" }}>仓库</th>
                    <th style={{ padding: "6px 8px" }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {skillSearchBusy ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                        加载中…
                      </td>
                    </tr>
                  ) : skillSearchHits.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                        无结果。SkillsMP 需网络可达；Open Skill Market 请先点击「加载全量索引」后再搜索。
                      </td>
                    </tr>
                  ) : (
                    /*
                     * 按 stars 降序展示。SkillsMP API 本身已按 stars 排序，但 Open Skill Market
                     * 的本地索引是任意顺序，统一在前端做一次排序，保证两种来源体验一致。
                     */
                    [...skillSearchHits]
                      .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
                      .map((row) => (
                        <tr key={row.id} style={{ borderTop: "1px solid #27272a", color: "var(--qb-body-fg)" }}>
                          <td style={{ padding: "8px", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
                            {row.name}
                          </td>
                          <td style={{ padding: "8px", maxWidth: 360 }}>
                            {row.description.length > 160 ? `${row.description.slice(0, 160)}…` : row.description}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              whiteSpace: "nowrap",
                              fontVariantNumeric: "tabular-nums",
                              color: row.stars != null ? "var(--qb-body-fg)" : "var(--qb-main-meta)",
                            }}
                            title={row.stars != null ? `GitHub stars: ${row.stars}` : "GitHub stars 未知"}
                          >
                            {row.stars != null ? row.stars.toLocaleString() : "—"}
                          </td>
                          <td style={{ padding: "8px", wordBreak: "break-all", maxWidth: 320 }}>
                            {row.repo ? (
                              <a
                                href={row.repo}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: "var(--qb-link, #60a5fa)" }}
                              >
                                {row.repo.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
                              </a>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              disabled={!currentProjectId}
                              title={!currentProjectId ? "需先加载工作区项目" : undefined}
                              onClick={() =>
                                currentProjectId &&
                                void installSkillFromMarket({
                                  projectId: currentProjectId,
                                  externalSkillId: row.id,
                                }).then(() =>
                                  listSkillMarketInstalls(currentProjectId).then(setSkillInstalls)
                                )
                              }
                            >
                              安装到项目
                            </button>
                          </td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
            {skillMarketTotalPages > 1 ? (
              <div style={{ ...styles.form, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={skillSearchBusy || skillMarketPage <= 1}
                  onClick={() => void loadSkillMarketPage(skillMarketPage - 1)}
                >
                  上一页
                </button>
                <span style={styles.chatMeta}>
                  第 {skillMarketPage} / {skillMarketTotalPages} 页
                </span>
                <button
                  type="button"
                  className="qb-btn-ghost qb-btn--compact"
                  disabled={skillSearchBusy || skillMarketPage >= skillMarketTotalPages}
                  onClick={() => void loadSkillMarketPage(skillMarketPage + 1)}
                >
                  下一页
                </button>
              </div>
            ) : null}
            <h4 style={{ ...styles.subTitle, fontSize: 14, margin: "14px 0 8px" }}>本项目已安装</h4>
            {!currentProjectId ? (
              <p className="qb-config-hint">加载配置后可按项目记录安装；请先进入配置中心触发加载。</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                      <th style={{ padding: "6px 8px" }}>skill_name</th>
                      <th style={{ padding: "6px 8px" }}>说明</th>
                      <th style={{ padding: "6px 8px" }}>来源</th>
                      <th style={{ padding: "6px 8px" }}>registry id</th>
                      <th style={{ padding: "6px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillInstalls.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                          尚未从市场安装任何技能。
                        </td>
                      </tr>
                    ) : (
                      skillInstalls.map((row) => (
                        <tr key={row.id} style={{ borderTop: "1px solid #27272a", color: "var(--qb-body-fg)" }}>
                          <td style={{ padding: "8px", fontFamily: "ui-monospace, monospace" }}>{row.skillName}</td>
                          <td style={{ padding: "8px", maxWidth: 280 }}>
                            {row.description.length > 120 ? `${row.description.slice(0, 120)}…` : row.description}
                          </td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            {/* 直接复用 OriginBadge 的 SkillsMP / Open Skill Market 预设；其它 registry 名也能兜底渲染 */}
                            <OriginBadge origin={row.registry} style={{ marginLeft: 0 }} />
                          </td>
                          <td style={{ padding: "8px", wordBreak: "break-all", fontSize: 11 }}>{row.externalSkillId}</td>
                          <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              onClick={() => void navigator.clipboard.writeText(row.skillName)}
                            >
                              复制 name
                            </button>
                            <button
                              type="button"
                              className="qb-btn-secondary qb-btn--compact"
                              disabled={
                                !definitions.find((b) => b.definition.id === skillAppendDefinitionId)?.draft
                              }
                              title={
                                !definitions.find((b) => b.definition.id === skillAppendDefinitionId)?.draft
                                  ? "请先在 Agent 页为该定义保存草稿"
                                  : undefined
                              }
                              onClick={() => {
                                const defId = skillAppendDefinitionId;
                                if (!defId) return;
                                const bundle = definitions.find((b) => b.definition.id === defId);
                                if (!bundle?.draft) return;
                                void appendAgentDraftSkills(defId, [row.skillName])
                                  .then(() => listAgentDefinitions())
                                  .then(setDefinitions);
                              }}
                            >
                              追加到草稿
                            </button>
                            <button
                              type="button"
                              className="qb-btn-ghost qb-btn--compact"
                              onClick={() =>
                                void deleteSkillMarketInstall(currentProjectId, row.id).then(() =>
                                  listSkillMarketInstalls(currentProjectId).then(setSkillInstalls)
                                )
                              }
                            >
                              移除
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ ...styles.form, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--qb-main-meta)" }}>追加到 Agent 草稿时选择：</span>
              {definitions.length === 0 ? (
                <span className="qb-config-hint">无 Agent 定义</span>
              ) : (
                <select
                  style={styles.select}
                  value={skillAppendDefinitionId}
                  onChange={(e) => setSkillAppendDefinitionId(e.target.value)}
                >
                  {definitions.map((b) => (
                    <option key={b.definition.id} value={b.definition.id}>
                      {b.profile?.displayName?.trim() || b.definition.name} · {b.definition.role}
                      {b.draft ? "" : "（无草稿）"}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                margin: "20px 0 8px",
              }}
            >
              <h4 style={{ ...styles.subTitle, fontSize: 14, margin: 0 }}>
                归纳与演化（agent_skill）
              </h4>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--qb-main-meta)",
                }}
              >
                <input
                  type="checkbox"
                  checked={skillLibraryIncludeArchived}
                  onChange={(e) => setSkillLibraryIncludeArchived(e.target.checked)}
                />
                显示已归档
              </label>
            </div>
            <p className="qb-config-hint" style={{ margin: "0 0 8px" }}>
              Agent 在执行复杂任务后由 curator 沉淀的程序性记忆，以及 evolver
              基于 baseline 突变得到的演化版本（类 Hermes / GEPA 机制）。pending_review
              的演化产物需要审批后才会转 active。
            </p>
            {!currentProjectId ? (
              <p className="qb-config-hint">加载配置后可按项目记录归纳；请先进入配置中心触发加载。</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                      <th style={{ padding: "6px 8px" }}>name</th>
                      <th style={{ padding: "6px 8px" }}>描述</th>
                      <th style={{ padding: "6px 8px" }}>来源</th>
                      <th style={{ padding: "6px 8px" }}>状态</th>
                      <th style={{ padding: "6px 8px" }}>version</th>
                      <th style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>使用 / 成功</th>
                      <th style={{ padding: "6px 8px" }}>最近使用</th>
                      <th style={{ padding: "6px 8px" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillLibrary.length === 0 ? (
                      <tr>
                        <td colSpan={8} style={{ padding: 12, color: "var(--qb-main-meta)" }}>
                          暂无 agent_skill 记录。等待 Agent 在工作流里触发 curator/evolver，或在
                          运维脚本里执行 `bun run src/scripts/run-skill-curator.ts`。
                        </td>
                      </tr>
                    ) : (
                      skillLibrary.map((s) => {
                        const reviewing = s.state === "pending_review";
                        return (
                          <tr
                            key={s.id}
                            style={{
                              borderTop: "1px solid #27272a",
                              color: "var(--qb-body-fg)",
                              opacity: s.state === "archived" ? 0.55 : 1,
                            }}
                          >
                            <td
                              style={{
                                padding: "8px",
                                fontFamily: "ui-monospace, monospace",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {s.pinned ? "★ " : ""}
                              {s.name}
                            </td>
                            <td style={{ padding: "8px", maxWidth: 320 }}>
                              {s.description.length > 140
                                ? `${s.description.slice(0, 140)}…`
                                : s.description}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <OriginBadge origin={s.source} style={{ marginLeft: 0 }} />
                            </td>
                            <td
                              style={{
                                padding: "8px",
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
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{s.version}</td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              {s.useCount} / {s.successCount}
                              {s.failCount > 0 ? (
                                <span style={{ color: "#fca5a5" }}> · 失败 {s.failCount}</span>
                              ) : null}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                whiteSpace: "nowrap",
                                color: "var(--qb-main-meta)",
                              }}
                            >
                              {s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "—"}
                            </td>
                            <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                              <button
                                type="button"
                                className="qb-btn-ghost qb-btn--compact"
                                onClick={() => {
                                  const preview = s.bodyMd?.slice(0, 4000) || "(empty)";
                                  window.alert(`# ${s.name}\n\n${preview}`);
                                }}
                              >
                                查看
                              </button>
                              <button
                                type="button"
                                className="qb-btn-ghost qb-btn--compact"
                                onClick={() =>
                                  void patchAgentSkill(s.id, { pinned: !s.pinned })
                                    .then(() =>
                                      listSkillLibrary(currentProjectId, {
                                        includeArchived: skillLibraryIncludeArchived,
                                      })
                                    )
                                    .then(setSkillLibrary)
                                }
                              >
                                {s.pinned ? "取消置顶" : "置顶"}
                              </button>
                              {reviewing ? (
                                <button
                                  type="button"
                                  className="qb-btn-secondary qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "active" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
                                >
                                  审批通过
                                </button>
                              ) : null}
                              {s.state !== "archived" ? (
                                <button
                                  type="button"
                                  className="qb-btn-ghost qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "archived" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
                                >
                                  归档
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="qb-btn-ghost qb-btn--compact"
                                  onClick={() =>
                                    void patchAgentSkill(s.id, { state: "active" })
                                      .then(() =>
                                        listSkillLibrary(currentProjectId, {
                                          includeArchived: skillLibraryIncludeArchived,
                                        })
                                      )
                                      .then(setSkillLibrary)
                                  }
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
            )}
          </>
        ) : null}
        {activeConfigSubPage === "schedule" ? (
          <ScheduledJobsPanel workspaceId={currentWorkspaceId || undefined} projectId={currentProjectId || null} />
        ) : null}
        {activeConfigSubPage === "runtime" ? (
          <>
            <h3 style={styles.subTitle}>系统运行时</h3>
            <p className="qb-config-hint">
              展示 Python 沙箱（code.run_python 与 qlib/signal/backtest 算子共用）的解释器路径和关键依赖。
              红灯时沙箱会 fail-fast 拒绝执行；黄灯（可选依赖缺失）只影响部分高级能力。
            </p>
            <PythonRuntimeCard />
          </>
        ) : null}
        {activeConfigSubPage === "providers" ? <ProvidersPanel /> : null}
        {activeConfigSubPage === "env" ? <EnvironmentPanel /> : null}
        {activeConfigSubPage === "integration" ? (
          <IntegrationCenterPanel
            workspaceId={currentWorkspaceId || undefined}
            projectId={currentProjectId || null}
          />
        ) : null}
        {activeConfigSubPage === "agent" ? (
          <ConfigAgentPanel
            definitions={definitions}
            selectedDefinitionId={selectedDefinitionId}
            onSelectDefinitionId={setSelectedDefinitionId}
            onResetAgentSelectionRef={() => {
              prevAgentDefId.current = "";
            }}
            onReloadAll={() => void loadConfig()}
            onPreferAgentAfterReload={(id) => {
              preferAgentDefinitionIdRef.current = id;
            }}
            onOpenMcpSubPage={setConfigSubPage}
            agentUiTab={agentUiTab}
            setAgentUiTab={setAgentUiTab}
            selectedBundle={selectedBundle}
            agentPack={agentPack}
            agentMemoryStats={agentMemoryStats}
            draftPrompt={draftPrompt}
            setDraftPrompt={setDraftPrompt}
            draftSoul={draftSoul}
            setDraftSoul={setDraftSoul}
            draftPromptTemplateRef={draftPromptTemplateRef}
            setDraftPromptTemplateRef={setDraftPromptTemplateRef}
            draftLlmProvider={draftLlmProvider}
            setDraftLlmProvider={setDraftLlmProvider}
            draftNote={draftNote}
            setDraftNote={setDraftNote}
            draftPromptMode={draftPromptMode}
            setDraftPromptMode={setDraftPromptMode}
            draftMemoryNamespace={draftMemoryNamespace}
            setDraftMemoryNamespace={setDraftMemoryNamespace}
            draftConfigRootUri={draftConfigRootUri}
            setDraftConfigRootUri={setDraftConfigRootUri}
            draftMcpServerNames={draftMcpServerNames}
            setDraftMcpServerNames={setDraftMcpServerNames}
            draftDisplayName={draftDisplayName}
            setDraftDisplayName={setDraftDisplayName}
            draftDescription={draftDescription}
            setDraftDescription={setDraftDescription}
            draftTools={draftTools}
            setDraftTools={setDraftTools}
            draftMaxIterations={draftMaxIterations}
            setDraftMaxIterations={setDraftMaxIterations}
            draftSkills={draftSkills}
            setDraftSkills={setDraftSkills}
            draftSubscriptions={draftSubscriptions}
            setDraftSubscriptions={setDraftSubscriptions}
            skillInstalls={skillInstalls}
            knownToolPool={knownToolPool}
            fileSoulMd={fileSoulMd}
            setFileSoulMd={setFileSoulMd}
            filePromptMd={filePromptMd}
            setFilePromptMd={setFilePromptMd}
            fileAgentMd={fileAgentMd}
            setFileAgentMd={setFileAgentMd}
            fileUserMd={fileUserMd}
            setFileUserMd={setFileUserMd}
            fileMemoryMd={fileMemoryMd}
            setFileMemoryMd={setFileMemoryMd}
            mcpServers={mcpServers}
            mcpBindings={mcpBindings}
            currentProjectId={currentProjectId}
            pickBindingForMcpServer={pickBindingForMcpServer}
            mcpServerBindingCount={mcpServerBindingCount}
          />
        ) : null}
      </div>
    </div>
  );
};

