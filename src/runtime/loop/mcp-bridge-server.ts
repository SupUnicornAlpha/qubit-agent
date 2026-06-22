/**
 * Minimal MCP stdio server: forwards tool calls into QUBIT `dispatchMcpToolCall`.
 * Run: `bun run src/runtime/loop/mcp-bridge-server.ts` (or via `qubit-mcp-bridge.json` args).
 *
 * Env: `QUBIT_MCP_BRIDGE_PROJECT_ID` — required for scoped MCP resolution.
 */
import { Buffer } from "node:buffer";
import { getDb } from "../../db/sqlite/client";
import { dispatchMcpToolCall } from "../mcp/dispatcher";
import { negotiateServerProtocolVersion } from "../mcp/mcp-protocol";
import { isToolPermitted, parseToolPatternEnv } from "./mcp-bridge-guard";

/**
 * MCP stdio 帧格式。当前 MCP 规范的 stdio 传输是 **换行分隔 JSON**（一行一条
 * JSON-RPC 消息，消息内不含裸换行）——Claude Code / Codex 均用此格式。
 * 早期/部分实现用 LSP 式 `Content-Length:` 头分帧。
 *
 * 2026-06 复盘（WF 36df0380）：本桥原先**只**解析 Content-Length 帧，导致 Claude
 * 发来的换行分隔 `initialize` 永远匹配不上 → 桥不回包 → claude 标记 server=failed →
 * 该角色无工具可用、空转到 300s 超时被 SIGTERM → 回退 native。修复：默认按换行分隔
 * 读写，同时兼容 Content-Length（按客户端来帧镜像回包）。
 */
const framing = { contentLength: false };

function writeMcpMessage(obj: Record<string, unknown>): void {
  const body = JSON.stringify(obj);
  if (framing.contentLength) {
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    process.stdout.write(Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]));
    return;
  }
  // 换行分隔 JSON（MCP stdio 规范默认；Claude Code / Codex）。
  process.stdout.write(`${body}\n`);
}

/**
 * 从累积 buffer 中切出完整 MCP 消息（纯函数，便于单测）。
 * 自动识别帧格式：以 `Content-Length:` 开头 → LSP 帧（置 state.contentLength=true）；
 * 否则按换行分隔。返回解析出的消息与剩余未消费 buffer。无法 JSON.parse 的行被跳过。
 */
export function takeMcpMessages(
  buf: Buffer,
  state: { contentLength: boolean }
): { msgs: Record<string, unknown>[]; rest: Buffer } {
  const msgs: Record<string, unknown>[] = [];
  let b = buf;
  while (b.length > 0) {
    // 跳过前导空白 / 换行
    let start = 0;
    while (
      start < b.length &&
      (b[start] === 0x0a || b[start] === 0x0d || b[start] === 0x20 || b[start] === 0x09)
    ) {
      start += 1;
    }
    if (start >= b.length) {
      b = Buffer.alloc(0);
      break;
    }
    const head = b
      .subarray(start, Math.min(start + 15, b.length))
      .toString("latin1")
      .toLowerCase();
    if (head.startsWith("content-length:")) {
      state.contentLength = true;
      const sep = b.indexOf("\r\n\r\n", start);
      if (sep < 0) {
        b = b.subarray(start);
        break;
      }
      const headerBlock = b.subarray(start, sep).toString("utf8");
      const m = /content-length:\s*(\d+)/i.exec(headerBlock);
      const bodyStart = sep + 4;
      if (!m) {
        b = b.subarray(bodyStart);
        continue;
      }
      const len = Number(m[1]);
      if (b.length < bodyStart + len) {
        b = b.subarray(start);
        break;
      }
      const bodyText = b.subarray(bodyStart, bodyStart + len).toString("utf8");
      b = b.subarray(bodyStart + len);
      try {
        msgs.push(JSON.parse(bodyText) as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    } else {
      // 换行分隔：取到下一个 \n
      const nl = b.indexOf(0x0a, start);
      if (nl < 0) {
        b = b.subarray(start);
        break;
      }
      const lineText = b.subarray(start, nl).toString("utf8").trim();
      b = b.subarray(nl + 1);
      if (lineText) {
        try {
          msgs.push(JSON.parse(lineText) as Record<string, unknown>);
        } catch {
          /* skip non-JSON line */
        }
      }
    }
  }
  return { msgs, rest: b };
}

async function* readMcpMessages(): AsyncGenerator<Record<string, unknown>> {
  let buf = Buffer.alloc(0);
  for await (const chunk of Bun.stdin.stream()) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    const { msgs, rest } = takeMcpMessages(buf, framing);
    buf = rest;
    for (const m of msgs) yield m;
  }
}

function toolCallQubitMcp() {
  return {
    name: "call_qubit_mcp",
    description:
      "Invoke an MCP tool configured inside QUBIT (same servers/bindings as the desktop app). " +
      "Use serverName and toolName from your QUBIT MCP bindings.",
    inputSchema: {
      type: "object",
      properties: {
        serverName: { type: "string", description: "MCP server name in QUBIT" },
        toolName: { type: "string", description: "Tool name on that server" },
        arguments: { type: "object", additionalProperties: true, description: "Tool arguments" },
      },
      required: ["serverName", "toolName"],
    },
  };
}

async function handleRequest(
  msg: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const inbound = msg as { method?: string; id?: unknown; params?: Record<string, unknown> };
  const method = inbound.method;
  const id = inbound.id;

  if (method === "initialize") {
    const params = inbound.params ?? {};
    const negotiated = negotiateServerProtocolVersion(params.protocolVersion);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: "qubit-mcp-bridge", version: "0.1.0" },
      },
    };
  }

  if (method === "notifications/initialized" || String(method).startsWith("notifications/")) {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: [toolCallQubitMcp()] },
    };
  }

  if (method === "tools/call") {
    const params = inbound.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const argsRaw = params.arguments;
    const args =
      argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    const projectId = process.env.QUBIT_MCP_BRIDGE_PROJECT_ID ?? "";

    if (name !== "call_qubit_mcp") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      };
    }
    if (!projectId) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "QUBIT_MCP_BRIDGE_PROJECT_ID is not set" },
      };
    }

    const serverName = typeof args.serverName === "string" ? args.serverName : "";
    const toolName = typeof args.toolName === "string" ? args.toolName : "";
    const toolArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};

    if (!serverName || !toolName) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "serverName and toolName are required" },
      };
    }

    const argSize = JSON.stringify(toolArgs).length;
    if (argSize > 512_000) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "arguments too large" },
      };
    }

    /**
     * 治理红线（docs/CLI_AGENT_PROJECTION_DESIGN.md §5）：高危工具（下单 / 实盘 /
     * 划转）默认拒绝，外部 CLI 经桥不可触达；可选按角色 allow 白名单收紧。
     * allow/deny 由 reasoner 通过 env 注入（见 cli-role-reasoner.ts）。
     */
    const permit = isToolPermitted({
      serverName,
      toolName,
      allow: parseToolPatternEnv(process.env.QUBIT_MCP_BRIDGE_ALLOW),
      deny: parseToolPatternEnv(process.env.QUBIT_MCP_BRIDGE_DENY),
    });
    if (!permit.ok) {
      const role = process.env.QUBIT_MCP_BRIDGE_ROLE ?? "";
      console.warn(`[qubit-mcp-bridge] blocked tool call (role=${role}): ${permit.reason}`);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `tool call blocked: ${permit.reason}` },
      };
    }

    await getDb();
    try {
      const out = await dispatchMcpToolCall({
        serverName,
        toolName,
        arguments: toolArgs,
        projectId,
      });
      const text = JSON.stringify(out);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: text.slice(0, 2_000_000) }],
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method: ${String(method)}` },
  };
}

export async function runMcpBridgeMain(): Promise<void> {
  for await (const msg of readMcpMessages()) {
    const res = await handleRequest(msg);
    if (res) writeMcpMessage(res);
  }
}

if (import.meta.main) {
  void runMcpBridgeMain().catch((e) => {
    console.error("[qubit-mcp-bridge]", e);
    process.exit(1);
  });
}
