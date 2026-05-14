/**
 * Minimal MCP stdio server: forwards tool calls into QUBIT `dispatchMcpToolCall`.
 * Run: `bun run src/runtime/loop/mcp-bridge-server.ts` (or via `qubit-mcp-bridge.json` args).
 *
 * Env: `QUBIT_MCP_BRIDGE_PROJECT_ID` — required for scoped MCP resolution.
 */
import { Buffer } from "node:buffer";
import { getDb } from "../../db/sqlite/client";
import { dispatchMcpToolCall } from "../mcp/dispatcher";

const PROTOCOL_VERSION = "2024-11-05";

function writeMcpMessage(obj: Record<string, unknown>): void {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
  const out = Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]);
  process.stdout.write(out);
}

async function* readMcpMessages(): AsyncGenerator<Record<string, unknown>> {
  const dec = new TextDecoder();
  let buf = Buffer.alloc(0);
  for await (const chunk of Bun.stdin.stream()) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (true) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) break;
      const headerBlock = dec.decode(buf.subarray(0, sep));
      const m = /Content-Length:\s*(\d+)/i.exec(headerBlock);
      if (!m) {
        throw new Error(
          `mcp-bridge: missing Content-Length in header: ${headerBlock.slice(0, 200)}`
        );
      }
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (buf.length < bodyStart + len) break;
      const bodyText = dec.decode(buf.subarray(bodyStart, bodyStart + len));
      buf = buf.subarray(bodyStart + len);
      yield JSON.parse(bodyText) as Record<string, unknown>;
    }
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
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
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
