import { getToolCatalogMap, resolveToolAlias } from "./tool-catalog";
import { isBuiltinTool } from "./builtin-tools";
import { resolveConnectorForTool } from "./tool-routes";
import type { LlmToolCallRequest, LlmToolDefinition } from "../llm/gateway";
import type { ToolCatalogEntry } from "./types";

/**
 * 每个 MCP server 在 prompt 块里展示的真实工具清单。
 * 入参可以是字符串（旧用法，仅 server 名）或对象（推荐，含 tools 清单），
 * tool-call-format 在拼装 prompt 时分支处理。
 */
export type McpServerPromptHint =
  | string
  | {
      name: string;
      tools?: Array<{ name: string; desc?: string }>;
    };

export type ParsedToolCall =
  | {
      kind: "tool";
      toolName: string;
      params: Record<string, unknown>;
      mcp?: {
        serverName: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
    }
  | { kind: "none"; summary?: string }
  | { kind: "parse_error"; message: string };

const CATEGORY_HINTS: Record<string, string[]> = {
  orchestration: ["派发", "专家", "团队", "计划", "步骤", "协作", "agent", "team", "plan"],
  market: ["行情", "价格", "k线", "成交量", "quote", "price", "market", "kline"],
  research: ["研究", "因子", "指标", "估值", "筛选", "股票", "factor", "research", "valuation"],
  backtest: ["回测", "策略", "oos", "walk-forward", "backtest", "strategy"],
  trading: ["交易", "订单", "买入", "卖出", "止盈", "止损", "仓位", "order", "trade"],
  risk: ["风险", "回撤", "var", "集中度", "流动性", "risk"],
  sentiment: ["新闻", "舆情", "事件", "情绪", "news", "sentiment"],
  macro: ["宏观", "利率", "政策", "通胀", "macro"],
  memory: ["记忆", "经验", "skill", "memory"],
  audit: ["审计", "报告", "血缘", "audit", "lineage"],
  exec: ["网页", "代码", "命令", "文件", "web", "exec", "cli"],
};

function toolRelevanceScore(
  name: string,
  query: string,
  entry: ToolCatalogEntry
): number {
  let score = query.includes(name.toLowerCase()) ? 20 : 0;
  const normalizedName = name.toLowerCase().replace(/[._-]/g, " ");
  for (const token of normalizedName.split(/\s+/).filter(Boolean)) {
    if (query.includes(token)) score += 4;
  }
  for (const hint of CATEGORY_HINTS[entry.category ?? "orchestration"] ?? []) {
    if (query.includes(hint)) score += 2;
  }
  return score;
}

/**
 * 只向模型暴露与当前目标最相关的工具；授权集合本身不变，因此不会删除已有能力。
 * 编排、计划与 MCP 路由工具始终保留，剩余槽位按任务关键词和工具类别排序。
 */
export function selectRelevantToolsForPrompt(
  availableTools: string[],
  queryText: string,
  maxTools = 16
): string[] {
  const unique = [...new Set(availableTools.filter(Boolean))];
  if (unique.length <= maxTools) return unique;
  const catalog = getToolCatalogMap();
  const query = queryText.toLowerCase();
  const always = new Set(
    unique.filter(
      (name) =>
        name === "assign_task" ||
        name === "update_plan" ||
        name === "call_mcp" ||
        name.startsWith("call_team_")
      )
  );
  const effectiveMax = Math.max(1, maxTools, always.size);
  const ranked = unique
    .filter((name) => !always.has(name))
    .map((name, index) => ({
      name,
      index,
      score: toolRelevanceScore(
        name,
        query,
        catalog.get(name) ?? {
          name,
          kind: "builtin",
          description: "",
          category: "orchestration",
        }
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return [...always, ...ranked.map((item) => item.name)].slice(0, effectiveMax);
}

export function buildNativeQubitToolDefinition(tools: string[]): LlmToolDefinition | null {
  const unique = [...new Set(tools.filter(Boolean))];
  if (unique.length === 0) return null;
  const catalog = getToolCatalogMap();
  const descriptions = unique
    .map((name) => {
      const description = catalog.get(name)?.description ?? "";
      return `${name}: ${description.slice(0, 120)}`;
    })
    .join("\n");
  return {
    name: "qubit_action",
    description:
      "选择并调用一个 QUBIT 已授权工具。一次只调用一个；若无需工具，直接返回文字，不要调用本函数。\n" +
      descriptions,
    parameters: {
      type: "object",
      properties: {
        tool: { type: "string", enum: unique },
        params: {
          type: "object",
          description: "该工具的业务参数；不要传 workflowRunId/projectId。",
          additionalProperties: true,
        },
      },
      required: ["tool", "params"],
      additionalProperties: false,
    },
  };
}

export function nativeToolCallToSentinel(
  call: LlmToolCallRequest,
  availableTools: string[]
): string | null {
  if (call.name !== "qubit_action") return null;
  const tool = typeof call.args["tool"] === "string" ? call.args["tool"] : "";
  if (!isAllowedTool(tool, availableTools)) return null;
  const params =
    call.args["params"] && typeof call.args["params"] === "object" && !Array.isArray(call.args["params"])
      ? (call.args["params"] as Record<string, unknown>)
      : {};
  return `<TOOL_CALL>\n${JSON.stringify({ tool, params })}\n</TOOL_CALL>`;
}

/** 构建注入 LLM 的「可用工具」说明块（缺口 A） */
export function buildAgentToolsPromptBlock(params: {
  tools: string[];
  /** 原生 function/tool calling 已启用时，只注入简短规则，schema 由 gateway 传递。 */
  nativeToolCalling?: boolean;
  /**
   * MCP server 列表。
   * - 旧用法：`["mathjs", "mcp-financex"]` —— 仅注入 server 名，LLM 需自己猜工具
   * - 推荐：`[{name:"mcp-financex", tools:[{name:"get_quote", desc:"..."}, ...]}]`
   *   —— 注入真实工具清单，LLM 不再瞎喊不存在的工具名
   */
  mcpServers?: Array<McpServerPromptHint>;
}): string {
  const tools = params.tools.filter((t) => typeof t === "string" && t.trim().length > 0);
  if (tools.length === 0 && (params.mcpServers?.length ?? 0) === 0) {
    return "";
  }

  const catalog = getToolCatalogMap();
  if (params.nativeToolCalling) {
    return [
      "## 工具调用",
      "本轮已启用原生结构化工具调用。需要工具时调用 `qubit_action`，一次只选一个工具；无需工具时直接给出结论。",
      "不得编造执行结果；工具失败后遵守 observation.recovery，禁止无变化重复调用。",
    ].join("\n");
  }
  const lines: string[] = [
    "## 可用工具（本轮已授权）",
    "回复末尾必须输出**且仅输出一个**工具调用块。**首选** sentinel 格式（最稳）：",
    "<TOOL_CALL>",
    '{"tool":"<工具名>","params":{...}}',
    "</TOOL_CALL>",
    "也接受 fenced JSON 作为兼容格式（解析器会先找 sentinel）：",
    "```json",
    '{"tool":"<工具名>","params":{...}}',
    "```",
    "若仅需文字结论、无需调用任何工具，输出：",
    "<TOOL_CALL>",
    '{"tool":"none","summary":"一句话说明为何不需要工具"}',
    "</TOOL_CALL>",
    "规则：",
    "- `tool` 必须是下列「工具名」之一，或 `none`；不要使用未列出的名称。",
    "- `params` 只填**业务参数**（如 `symbol` / `ticker` / `name` / `expression` 等）。",
    "- **不要填** `workflowRunId` / `projectId` / `project_id`——这些上下文参数由系统自动注入，你填的任何值都会被覆盖。",
    "- 不要编造工具执行结果；未调用工具前不得声称「已回测/已拉取行情」。",
    "- 一次只能调用一个工具；多个工具调用请分多轮。",
    "- 调用工具时，在 `<TOOL_CALL>` 之前**用一行写明**：`调用理由：<为何调用、预期得到什么>`（让用户看懂你的每一步）。",
    "",
  ];

  if (tools.length > 0) {
    lines.push("### 工具名列表");
    for (const name of tools) {
      const entry = catalog.get(name);
      const desc = entry?.description ?? "（自定义或未在目录登记）";
      const via =
        entry?.kind === "connector" && entry.connector
          ? `connector:${entry.connector}`
          : entry?.kind === "builtin"
            ? "builtin"
            : isBuiltinTool(name) || resolveConnectorForTool(name)
              ? "runtime"
              : "custom";
      lines.push(`- **${name}**（${via}）：${desc}`);
    }
    lines.push("");
  }

  /** 同时接受 string[] 与 {name,tools}[] 两种形态；做归一化便于后续渲染 */
  const mcps: Array<{ name: string; tools?: Array<{ name: string; desc?: string }> }> = (
    params.mcpServers ?? []
  )
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim() ? { name: entry.trim() } : null;
      }
      const name = entry?.name?.trim() ?? "";
      if (!name) return null;
      const tools = Array.isArray(entry?.tools)
        ? entry.tools.filter((t) => typeof t?.name === "string" && t.name.trim().length > 0)
        : undefined;
      return tools && tools.length > 0 ? { name, tools } : { name };
    })
    .filter((s): s is { name: string; tools?: Array<{ name: string; desc?: string }> } => s != null);

  if (mcps.length > 0) {
    lines.push("### MCP 服务（本工作流当前真实可用，强约束）");
    lines.push(
      "⚠️ **以下是本轮唯一被启用的 MCP server 列表**。即便 system prompt 中提到其它 server 名（如历史 seed 的示例），**也禁止调用**——未在此列表的 server 一律会返回 `mcp server not found or disabled`，浪费一轮 reason。"
    );
    for (const server of mcps) {
      lines.push(`- **${server.name}**：使用工具名 \`call_mcp\`，params 示例：`);
      lines.push(
        `  \`{"tool":"call_mcp","params":{"serverName":"${server.name}","mcpTool":"<工具名>","arguments":{}}}\``
      );
      /**
       * 当 capabilities_json.tools 注入了真实工具清单（如 mcp-financex），
       * 把每个工具名 + 简要描述列出，**严禁 LLM 调用未列出的工具名**。
       * 历史 bug：LLM 凭训练记忆把 mcp-financex 的工具喊成 `get_financials` /
       * `list_available_tools`（这两个都不存在），server 抛 "Unknown tool"
       * 直接断分析师推理一轮（WF 44ca3acf 实测 2 次）。
       */
      if (server.tools && server.tools.length > 0) {
        lines.push(`  - **${server.name} 真实工具清单**（仅可调用以下 \`mcpTool\` 名，不要瞎猜）:`);
        for (const t of server.tools) {
          lines.push(`    - \`${t.name}\`${t.desc ? `：${t.desc}` : ""}`);
        }
      }
    }
    lines.push(
      "- 或使用 `mcp:<serverName>:<toolName>` 作为 tool 名，params 为 arguments 对象。",
      ""
    );
  } else {
    /**
     * 0 个 MCP server 时也必须显式告知 LLM，否则 deepseek/glm 等模型会
     * 从 system_prompt 历史示例（mcp-financex / fsi-factset 等名字）里
     * "想象"出 server 并发起 call_mcp —— 数据库实测 5 次失败全是这种幻调。
     */
    lines.push(
      "### MCP 服务",
      "⚠️ **本轮没有任何 MCP server 启用**。**严禁使用** `call_mcp` 或 `mcp:*:*` 工具名，即便 system prompt 中提到 mcp-financex / fsi-factset / mathjs 等名字也不要尝试调用——会直接失败浪费一轮 reason。需要外部数据时，请使用上方「工具名列表」中的 builtin / connector 工具。",
      ""
    );
  }

  return lines.join("\n");
}

/** 与 LangGraph reason 节点一致：pack/DB 合并正文 + 工具/MCP 说明块 */
export function assembleAgentSystemPrompt(
  baseSystemPrompt: string,
  params: {
    tools: string[];
    mcpServers?: Array<McpServerPromptHint>;
    nativeToolCalling?: boolean;
  }
): { full: string; toolsBlock: string } {
  const toolsBlock = buildAgentToolsPromptBlock(params);
  const full = toolsBlock ? `${baseSystemPrompt}\n\n${toolsBlock}` : baseSystemPrompt;
  return { full, toolsBlock };
}

/**
 * 提取工具调用 JSON。优先级（高→低）：
 *   1. `<TOOL_CALL>…</TOOL_CALL>` sentinel —— 取**最后一个**，最稳，不会与 reasoning 中
 *      的示例 JSON 冲突
 *   2. fenced ```json …``` —— 取**最后一个**含 `"tool"` 的代码块
 *   3. 启发式：扫描所有 `{…}`，取最后一个含 `"tool"` 的（兼容老模型）
 *
 * 注意：取 last 而非 first，是因为模型常先写示例再写真正的调用。
 */
function extractJsonToolBlock(text: string): string | null {
  // 1. sentinel
  const sentinels = [...text.matchAll(/<TOOL_CALL>\s*([\s\S]*?)\s*<\/TOOL_CALL>/gi)];
  if (sentinels.length > 0) {
    const inner = sentinels[sentinels.length - 1][1]?.trim();
    if (inner && inner.startsWith("{")) return inner;
  }

  // 2. fenced —— 取最后一个含 "tool" 的
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const inner = fences[i][1]?.trim();
    if (inner && inner.startsWith("{") && inner.includes('"tool"')) return inner;
  }

  // 3. 启发式
  const matches = [...text.matchAll(/\{[\s\S]*?\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i][0];
    if (candidate.includes('"tool"')) return candidate;
  }
  return null;
}

function extractMcpMeta(
  toolName: string,
  params: Record<string, unknown>
): { serverName: string; toolName: string; arguments: Record<string, unknown> } | undefined {
  if (toolName.startsWith("mcp:")) {
    const parts = toolName.split(":");
    if (parts.length >= 3) {
      return {
        serverName: parts[1] ?? "unknown",
        toolName: parts.slice(2).join(":"),
        arguments:
          params && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {},
      };
    }
  }
  const serverName =
    (typeof params["serverName"] === "string" ? params["serverName"] : undefined) ??
    (typeof params["server"] === "string" ? params["server"] : undefined);
  const mcpToolName =
    (typeof params["mcpTool"] === "string" ? params["mcpTool"] : undefined) ??
    (typeof params["toolName"] === "string" ? params["toolName"] : undefined) ??
    (typeof params["tool"] === "string" ? params["tool"] : undefined);
  const argumentsValue = params["arguments"];
  const argumentsObj =
    argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  if (serverName && mcpToolName) {
    return { serverName, toolName: mcpToolName, arguments: argumentsObj };
  }
  return undefined;
}

function isAllowedTool(toolName: string, availableTools: string[]): boolean {
  if (availableTools.includes(toolName)) return true;
  if (toolName === "call_mcp" && availableTools.includes("call_mcp")) return true;
  // Step 3：兼容 deprecated 别名 — 只要 replacedBy 在订阅里就放行（act 节点会做透明跳转）
  const alias = resolveToolAlias(toolName);
  if (alias.aliased && availableTools.includes(alias.resolved)) return true;
  if (toolName.startsWith("mcp:")) {
    return availableTools.some((t) => t === "call_mcp" || t.startsWith("mcp:"));
  }
  return false;
}

/**
 * 从 reason 文本解析工具调用（缺口 B）：仅接受 JSON，禁止回退到 availableTools[0]。
 */
export function parseToolCallFromReason(
  reasonText: string,
  availableTools: string[]
): ParsedToolCall {
  const trimmed = reasonText.trim();
  if (!trimmed) {
    return { kind: "parse_error", message: "reason 输出为空，无法解析工具调用" };
  }

  const jsonStr = extractJsonToolBlock(trimmed);
  if (!jsonStr) {
    if (availableTools.length === 0) {
      return { kind: "none", summary: "无授权工具，按纯文本响应处理" };
    }
    return {
      kind: "parse_error",
      message:
        "未找到合法的 JSON 工具调用块。请在回复末尾使用 ```json {\"tool\":\"...\",\"params\":{}} ``` 或 {\"tool\":\"none\"}",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return { kind: "parse_error", message: `工具调用 JSON 解析失败：${jsonStr.slice(0, 120)}` };
  }

  const toolName = typeof parsed["tool"] === "string" ? parsed["tool"].trim() : "";
  if (!toolName) {
    return { kind: "parse_error", message: 'JSON 中缺少 "tool" 字段' };
  }

  if (toolName === "none" || toolName === "finish" || toolName === "respond") {
    const summary =
      typeof parsed["summary"] === "string"
        ? parsed["summary"]
        : typeof parsed["message"] === "string"
          ? parsed["message"]
          : undefined;
    return { kind: "none", summary };
  }

  if (!isAllowedTool(toolName, availableTools)) {
    return {
      kind: "parse_error",
      message: `工具 "${toolName}" 不在本 Agent 授权列表中：${availableTools.join(", ") || "(空)"}`,
    };
  }

  const params = (parsed["params"] ?? parsed["parameters"] ?? {}) as Record<string, unknown>;
  const mcp =
    toolName === "call_mcp" || toolName.startsWith("mcp:")
      ? extractMcpMeta(toolName, params)
      : undefined;

  if ((toolName === "call_mcp" || toolName.startsWith("mcp:")) && !mcp) {
    return {
      kind: "parse_error",
      message:
        'call_mcp 需要 params：serverName + mcpTool（或 tool 名使用 mcp:<server>:<tool>）',
    };
  }

  return { kind: "tool", toolName, params, mcp };
}

/** sentinel 含前后换行一并吃掉，避免产生连续空行残留 */
const TOOL_CALL_SENTINEL_REGEX = /\n*<TOOL_CALL>[\s\S]*?<\/TOOL_CALL>\n*/gi;
const TOOL_CALL_OPEN_TAIL_REGEX = /\n*<TOOL_CALL>[\s\S]*$/i;
const JSON_TOOL_FENCE_REGEX = /\n*```(?:json)?\s*\{[\s\S]*?"tool"\s*:[\s\S]*?\}\s*```\n*/gi;

/**
 * 从 LLM 文本中剥掉所有 `<TOOL_CALL>...</TOOL_CALL>` sentinel 块、未闭合的尾部
 * sentinel，以及带 `"tool"` 字段的 fenced JSON 代码块，避免泄漏到用户可见消息。
 *
 * 仅用于"展示给用户"路径；工具解析必须使用原始文本。
 */
export function stripToolCallSentinels(text: string | null | undefined): string {
  if (!text) return "";
  let out = String(text);
  out = out.replace(TOOL_CALL_SENTINEL_REGEX, "\n");
  out = out.replace(TOOL_CALL_OPEN_TAIL_REGEX, "");
  out = out.replace(JSON_TOOL_FENCE_REGEX, "\n");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
