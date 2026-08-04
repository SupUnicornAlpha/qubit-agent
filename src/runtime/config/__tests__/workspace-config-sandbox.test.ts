import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeAgentDefinition } from "../../types";
import {
  type WorkspaceSandboxPolicy,
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
  mergeBuiltinAgentDefinitionsIntoUserFile,
  mergeBuiltinSandboxPoliciesIntoUserFile,
} from "../workspace-config";

const defs: RuntimeAgentDefinition[] = [
  {
    id: "def-market",
    role: "market_data",
    name: "行情",
    version: "1",
    systemPrompt: "",
    tools: ["fetch_price_data"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-orch",
    role: "orchestrator",
    name: "编排",
    version: "1",
    systemPrompt: "",
    tools: ["assign_task"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
];

describe("buildDefaultSandboxPoliciesFromDefinitions", () => {
  test("default-policy 包含 call_team_<role> 拓扑工具", () => {
    const policies = buildDefaultSandboxPoliciesFromDefinitions(defs);
    const p = policies[0];
    expect(p?.allowedTools).toContain("fetch_price_data");
    expect(p?.allowedTools).toContain("assign_task");
    expect(p?.allowedTools).toContain("update_plan");
    expect(p?.allowedTools).toContain("call_team_market_data");
    expect(p?.allowedTools).toContain("call_team_orchestrator");
  });
});

describe("mergeBuiltinAgentDefinitionsIntoUserFile", () => {
  test("upgrades an old builtin and replaces tools with curated seed surface", () => {
    const baseline = defs[0];
    if (!baseline) throw new Error("missing market baseline");
    const old = {
      ...baseline,
      version: "0.9.0",
      systemPrompt: "old prompt",
      tools: ["fetch_price_data", "user-tool", "fetch_ticks"],
    };
    const seed = {
      ...baseline,
      version: "2.3.0",
      systemPrompt: "realtime routing baseline",
      tools: ["fetch_price_data", "fetch_quote"],
    };
    const { definitions, mutated } = mergeBuiltinAgentDefinitionsIntoUserFile([old], [seed]);
    expect(mutated).toBe(true);
    expect(definitions[0]?.version).toBe("2.3.0");
    expect(definitions[0]?.systemPrompt).toBe("realtime routing baseline");
    // 精品面：版本升级时用 seed 工具面整体替换，不再 union 残留旧工具
    expect(definitions[0]?.tools).toEqual(["fetch_price_data", "fetch_quote"]);
  });

  test("same version but drifted tools are reset to seed surface", () => {
    const baseline = defs[0];
    if (!baseline) throw new Error("missing market baseline");
    const drifted = {
      ...baseline,
      version: baseline.version,
      tools: [...baseline.tools, "stale_legacy_tool"],
    };
    const { definitions, mutated } = mergeBuiltinAgentDefinitionsIntoUserFile([drifted], [baseline]);
    expect(mutated).toBe(true);
    expect(definitions[0]?.tools).toEqual([...baseline.tools].sort());
    expect(definitions[0]?.tools).not.toContain("stale_legacy_tool");
  });

  test("does not overwrite a custom definition outside the builtin seed", () => {
    const baseline = defs[0];
    if (!baseline) throw new Error("missing market baseline");
    const custom = { ...baseline, id: "user-market", version: "9.0.0" };
    const { definitions } = mergeBuiltinAgentDefinitionsIntoUserFile([custom], defs);
    expect(definitions.find((definition) => definition.id === "user-market")).toEqual(custom);
  });
});

/**
 * Round 8 复盘（2026-06-08）：`.qubit/sandbox.json` 在用户机上是历史快照，
 * SEED_AGENT_DEFINITIONS 新增 builtin tool（如 strategy.create_version）后，
 * 文件里的 default-policy.allowedTools 仍旧没有这些工具；GraphRunner 启动时
 * syncWorkspaceConfigToDb 会用文件覆盖 DB → sandbox_policy.allowed_tools_json
 * 退回旧值 → 评测里 strategy.create_version 永远 sandbox_blocked。
 *
 * mergeBuiltinSandboxPoliciesIntoUserFile 负责"软合并"：把 SEED policy 的
 * allowedTools / allowedMcpServers union 进 user 文件的同 id policy，user
 * 自加的额外项保留，其他 policy 完全不动。
 */
describe("mergeBuiltinSandboxPoliciesIntoUserFile", () => {
  const seedPolicy: WorkspaceSandboxPolicy = {
    id: "default-policy",
    name: "default-policy",
    description: "seed",
    allowedTools: ["a", "b", "c"],
    allowedMcpServers: ["mcp-1", "mcp-2"],
    allowedConnectors: [],
    allowedHosts: [],
    allowedFsPaths: [],
    maxToolCallMs: 30_000,
    maxIterationsPerRun: 20,
    maxOutputTokens: 4096,
    isolationLevel: "none",
    canWriteMemory: true,
    canReadLiveMarket: false,
    canSubmitOrder: false,
  };

  test("文件缺少 SEED 工具时 → 补齐 union 并 mutated=true", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      { ...seedPolicy, allowedTools: ["a"], allowedMcpServers: [] },
    ];
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [
      seedPolicy,
    ]);
    expect(mutated).toBe(true);
    const merged = policies.find((p) => p.id === "default-policy");
    expect(merged?.allowedTools.sort()).toEqual(["a", "b", "c"]);
    expect(merged?.allowedMcpServers.sort()).toEqual(["mcp-1", "mcp-2"]);
  });

  test("文件已包含全部 SEED 工具 → mutated=false 且 policies 不变", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      { ...seedPolicy, allowedTools: ["a", "b", "c", "user-extra"] },
    ];
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [
      seedPolicy,
    ]);
    expect(mutated).toBe(false);
    expect(policies[0]?.allowedTools.sort()).toEqual(["a", "b", "c", "user-extra"]);
  });

  test("user 在 default-policy 加的额外工具/MCP 必须保留", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      {
        ...seedPolicy,
        allowedTools: ["a", "user-private-tool"],
        allowedMcpServers: ["mcp-1", "user-mcp"],
      },
    ];
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [
      seedPolicy,
    ]);
    expect(mutated).toBe(true);
    const merged = policies.find((p) => p.id === "default-policy");
    expect(merged?.allowedTools.sort()).toEqual(["a", "b", "c", "user-private-tool"]);
    expect(merged?.allowedMcpServers.sort()).toEqual(["mcp-1", "mcp-2", "user-mcp"]);
  });

  test("user 自定义 policy（非 SEED id）完全不动", () => {
    const userPolicy: WorkspaceSandboxPolicy = {
      ...seedPolicy,
      id: "my-custom",
      name: "my-custom",
      allowedTools: ["only-user-tool"],
    };
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      { ...seedPolicy, allowedTools: ["a"] },
      userPolicy,
    ];
    const { policies } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [seedPolicy]);
    const custom = policies.find((p) => p.id === "my-custom");
    expect(custom?.allowedTools).toEqual(["only-user-tool"]);
  });

  test("文件里缺 SEED policy（如全新工作区）→ 整条 SEED policy 加入，mutated=true", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [];
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [
      seedPolicy,
    ]);
    expect(mutated).toBe(true);
    expect(policies.find((p) => p.id === "default-policy")?.allowedTools.sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("非 allowedTools/allowedMcpServers 字段（如 maxIterationsPerRun）尊重 user 文件值", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      { ...seedPolicy, allowedTools: ["a"], maxIterationsPerRun: 99 },
    ];
    const { policies } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [seedPolicy]);
    const merged = policies.find((p) => p.id === "default-policy");
    expect(merged?.maxIterationsPerRun).toBe(99);
  });

  test("将历史 default-policy 的 20 轮阈值迁移到新的 seed 默认值", () => {
    const fileSandbox: WorkspaceSandboxPolicy[] = [
      { ...seedPolicy, allowedTools: ["a"], maxIterationsPerRun: 20 },
    ];
    const upgradedSeed = { ...seedPolicy, maxIterationsPerRun: 64 };
    const { policies, mutated } = mergeBuiltinSandboxPoliciesIntoUserFile(fileSandbox, [
      upgradedSeed,
    ]);
    expect(mutated).toBe(true);
    expect(policies.find((policy) => policy.id === "default-policy")?.maxIterationsPerRun).toBe(64);
  });
});

/**
 * 集成测试：boot 阶段 ensureWorkspaceRuntimeConfigFiles 在 sandbox.json 已存在时
 * 自动把新增 builtin tool union 进 user 文件，是 Round 8 sandbox_blocked 问题
 * 的"最后一公里"修复点。
 */
describe("ensureWorkspaceRuntimeConfigFiles · sandbox.json union 行为", () => {
  let tmpRoot = "";

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "qubit-sandbox-merge-"));
    mkdirSync(join(tmpRoot, ".qubit"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const seedPolicy: WorkspaceSandboxPolicy = {
    id: "default-policy",
    name: "default-policy",
    description: "seed",
    allowedTools: ["legacy-tool", "strategy.create_version", "order.create_intent"],
    allowedMcpServers: [],
    allowedConnectors: [],
    allowedHosts: [],
    allowedFsPaths: [],
    maxToolCallMs: 30_000,
    maxIterationsPerRun: 20,
    maxOutputTokens: 4096,
    isolationLevel: "none",
    canWriteMemory: true,
    canReadLiveMarket: false,
    canSubmitOrder: false,
  };

  const minimumAgents = JSON.stringify({ definitions: [] });

  test("sandbox.json 旧文件缺新工具 → 启动时被 union 进文件", async () => {
    writeFileSync(join(tmpRoot, ".qubit", "agents.json"), minimumAgents);
    writeFileSync(
      join(tmpRoot, ".qubit", "sandbox.json"),
      JSON.stringify(
        {
          policies: [
            {
              ...seedPolicy,
              allowedTools: ["legacy-tool", "user-private-tool"], // 缺 strategy.create_version
            },
          ],
        },
        null,
        2
      )
    );

    await ensureWorkspaceRuntimeConfigFiles({
      rootDir: tmpRoot,
      definitions: [],
      policies: [seedPolicy],
    });

    const after = JSON.parse(readFileSync(join(tmpRoot, ".qubit", "sandbox.json"), "utf-8")) as {
      policies: WorkspaceSandboxPolicy[];
    };
    const dp = after.policies.find((p) => p.id === "default-policy");
    expect(dp?.allowedTools).toContain("strategy.create_version");
    expect(dp?.allowedTools).toContain("order.create_intent");
    expect(dp?.allowedTools).toContain("user-private-tool"); // user 自加项保留
  });

  test("agents.json 旧 builtin 会升级到 curated seed 工具面", async () => {
    writeFileSync(
      join(tmpRoot, ".qubit", "agents.json"),
      JSON.stringify({
        definitions: [
          {
            ...defs[0],
            version: "0.8.0",
            systemPrompt: "stale",
            tools: ["user-tool"],
          },
        ],
      })
    );
    writeFileSync(
      join(tmpRoot, ".qubit", "sandbox.json"),
      JSON.stringify({ policies: [seedPolicy] })
    );

    await ensureWorkspaceRuntimeConfigFiles({
      rootDir: tmpRoot,
      definitions: defs,
      policies: [seedPolicy],
    });

    const after = JSON.parse(readFileSync(join(tmpRoot, ".qubit", "agents.json"), "utf-8")) as {
      definitions: RuntimeAgentDefinition[];
    };
    const market = after.definitions.find((definition) => definition.id === "def-market");
    expect(market?.version).toBe("1");
    expect(market?.systemPrompt).toBe(defs[0]?.systemPrompt);
    expect(market?.tools).toEqual([...(defs[0]?.tools ?? [])].sort());
    expect(market?.tools).not.toContain("user-tool");
  });

  test("mergeBuiltinSandboxPolicies=false → 不做合并", async () => {
    writeFileSync(join(tmpRoot, ".qubit", "agents.json"), minimumAgents);
    writeFileSync(
      join(tmpRoot, ".qubit", "sandbox.json"),
      JSON.stringify(
        {
          policies: [{ ...seedPolicy, allowedTools: ["legacy-tool"] }],
        },
        null,
        2
      )
    );

    await ensureWorkspaceRuntimeConfigFiles({
      rootDir: tmpRoot,
      definitions: [],
      policies: [seedPolicy],
      mergeBuiltinSandboxPolicies: false,
    });

    const after = JSON.parse(readFileSync(join(tmpRoot, ".qubit", "sandbox.json"), "utf-8")) as {
      policies: WorkspaceSandboxPolicy[];
    };
    expect(after.policies[0]?.allowedTools).toEqual(["legacy-tool"]);
  });

  test("refresh=true 时整文件被覆盖，新工具直接进", async () => {
    writeFileSync(join(tmpRoot, ".qubit", "agents.json"), minimumAgents);
    writeFileSync(
      join(tmpRoot, ".qubit", "sandbox.json"),
      JSON.stringify(
        {
          policies: [{ ...seedPolicy, allowedTools: ["legacy-only"] }],
        },
        null,
        2
      )
    );

    await ensureWorkspaceRuntimeConfigFiles({
      rootDir: tmpRoot,
      definitions: [],
      policies: [seedPolicy],
      refresh: true,
    });

    const after = JSON.parse(readFileSync(join(tmpRoot, ".qubit", "sandbox.json"), "utf-8")) as {
      policies: WorkspaceSandboxPolicy[];
    };
    expect(after.policies[0]?.allowedTools).toEqual(seedPolicy.allowedTools);
  });
});
