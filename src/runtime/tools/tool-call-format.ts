import { getToolCatalogMap } from "./tool-catalog";
import { isBuiltinTool } from "./builtin-tools";
import { resolveConnectorForTool } from "./tool-routes";

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

/** 构建注入 LLM 的「可用工具」说明块（缺口 A） */
export function buildAgentToolsPromptBlock(params: {
  tools: string[];
  mcpServers?: string[];
}): string {
  const tools = params.tools.filter((t) => typeof t === "string" && t.trim().length > 0);
  if (tools.length === 0 && (params.mcpServers?.length ?? 0) === 0) {
    return "";
  }

  const catalog = getToolCatalogMap();
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
    "- `params` 为对象；需要标的时传 `symbol` 或 `ticker`，需要工作流时传 `workflowRunId`。",
    "- 不要编造工具执行结果；未调用工具前不得声称「已回测/已拉取行情」。",
    "- 一次只能调用一个工具；多个工具调用请分多轮。",
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

  const mcps = (params.mcpServers ?? []).filter((s) => s.trim().length > 0);
  if (mcps.length > 0) {
    lines.push("### MCP 服务（白名单）");
    for (const server of mcps) {
      lines.push(`- **${server}**：使用工具名 \`call_mcp\`，params 示例：`);
      lines.push(
        `  \`{"tool":"call_mcp","params":{"serverName":"${server}","mcpTool":"<工具名>","arguments":{}}}\``
      );
    }
    lines.push(
      "- 或使用 `mcp:<serverName>:<toolName>` 作为 tool 名，params 为 arguments 对象。",
      ""
    );
  }

  return lines.join("\n");
}

/** 与 LangGraph reason 节点一致：pack/DB 合并正文 + 工具/MCP 说明块 */
export function assembleAgentSystemPrompt(
  baseSystemPrompt: string,
  params: { tools: string[]; mcpServers?: string[] }
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
