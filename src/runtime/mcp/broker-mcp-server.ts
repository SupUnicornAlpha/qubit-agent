/**
 * MCP stdio server for QUBIT broker operations via broker_account.
 * Run: `bun run src/runtime/mcp/broker-mcp-server.ts`
 */
import { Buffer } from "node:buffer";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  BROKER_PROVIDERS,
  isBrokerProvider,
  type BrokerProvider,
} from "../../types/broker";
import { checkBrokerAccountHealth } from "../execution/broker/broker-admin";
import {
  brokerCancelOrder,
  brokerGetBalances,
  brokerGetCapabilities,
  brokerGetFills,
  brokerGetMargin,
  brokerGetOpenOrders,
  brokerGetOrder,
  brokerGetPositions,
  brokerModifyOrder,
} from "../execution/broker/broker-service";
import { scanPositionReconciliation } from "../execution/position-reconciliation-service";
import { executeIntentLive, executeIntentPaper } from "../reia/intent-engine";
import { negotiateServerProtocolVersion } from "./mcp-protocol";

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
      if (!m) throw new Error(`broker-mcp: missing Content-Length: ${headerBlock.slice(0, 200)}`);
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (buf.length < bodyStart + len) break;
      const bodyText = dec.decode(buf.subarray(bodyStart, bodyStart + len));
      buf = buf.subarray(bodyStart + len);
      yield JSON.parse(bodyText) as Record<string, unknown>;
    }
  }
}

function providerFromArgs(args: Record<string, unknown>): BrokerProvider {
  if (args.provider == null) return "futu";
  if (!isBrokerProvider(args.provider)) {
    throw new Error(`unsupported broker provider: ${String(args.provider)}`);
  }
  return args.provider;
}

const TOOLS = [
  {
    name: "broker_get_order",
    description: "Read the latest order state from the configured broker sidecar.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
        brokerOrderId: { type: "string" },
      },
      required: ["brokerOrderId"],
    },
  },
  {
    name: "broker_list_open_orders",
    description:
      "Read all current open broker orders. Check broker_capabilities.openOrders before relying on this endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
    },
  },
  {
    name: "broker_modify_order",
    description:
      "Modify an open broker order when the connector advertises support; never falls back to cancel-replace.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
        brokerOrderId: { type: "string" },
        limitPrice: { type: "number" },
        quantity: { type: "number", minimum: 0 },
      },
      required: ["brokerOrderId"],
    },
  },
  {
    name: "broker_health_check",
    description: "Check configured broker account health.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
      required: ["provider", "accountRef"],
    },
  },
  {
    name: "broker_get_balances",
    description: "Read cash/equity balances from the configured broker account.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
    },
  },
  {
    name: "broker_get_margin",
    description: "Read buying power and margin summary from the configured broker account.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
    },
  },
  {
    name: "broker_capabilities",
    description: "Read the normalized connector capability matrix before attempting a privileged operation.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
    },
  },
  {
    name: "broker_reconcile_positions",
    description: "Run read-only internal-vs-broker position reconciliation. Remediation remains approval-gated.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
      required: ["projectId", "provider"],
    },
  },
  {
    name: "broker_submit_order",
    description: "Execute an approved intent order via configured broker (requires intentOrderId).",
    inputSchema: {
      type: "object",
      properties: {
        intentOrderId: { type: "string" },
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
        paper: { type: "boolean" },
      },
      required: ["intentOrderId"],
    },
  },
  {
    name: "broker_cancel_order",
    description: "Cancel a broker order by brokerOrderId.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
        brokerOrderId: { type: "string" },
        intentOrderId: { type: "string" },
      },
      required: ["brokerOrderId"],
    },
  },
  {
    name: "broker_get_fills",
    description: "Get fills for a broker order.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
        brokerOrderId: { type: "string" },
      },
      required: ["brokerOrderId"],
    },
  },
  {
    name: "broker_get_positions",
    description: "List positions from the broker account.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: [...BROKER_PROVIDERS] },
        accountRef: { type: "string" },
      },
    },
  },
];

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "broker_health_check": {
      const provider = providerFromArgs(args);
      const accountRef = String(args.accountRef ?? "default");
      return checkBrokerAccountHealth({ provider, accountRef });
    }
    case "broker_submit_order": {
      const intentOrderId = String(args.intentOrderId ?? "");
      if (!intentOrderId) throw new Error("intentOrderId is required");
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      const paper = args.paper === true;
      return paper
        ? executeIntentPaper({ intentOrderId })
        : executeIntentLive({
            intentOrderId,
            provider,
            ...(accountRef !== undefined ? { accountRef } : {}),
          });
    }
    case "broker_cancel_order": {
      const provider = providerFromArgs(args);
      const brokerOrderId = String(args.brokerOrderId ?? "");
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      const intentOrderId = typeof args.intentOrderId === "string" ? args.intentOrderId : undefined;
      await brokerCancelOrder({
        provider,
        ...(accountRef !== undefined ? { accountRef } : {}),
        brokerOrderId,
        ...(intentOrderId !== undefined ? { intentOrderId } : {}),
      });
      return { ok: true };
    }
    case "broker_get_order": {
      const provider = providerFromArgs(args);
      const brokerOrderId = String(args.brokerOrderId ?? "");
      if (!brokerOrderId) throw new Error("brokerOrderId is required");
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetOrder({ provider, ...(accountRef !== undefined ? { accountRef } : {}), brokerOrderId });
    }
    case "broker_list_open_orders": {
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetOpenOrders({ provider, ...(accountRef !== undefined ? { accountRef } : {}) });
    }
    case "broker_modify_order": {
      const provider = providerFromArgs(args);
      const brokerOrderId = String(args.brokerOrderId ?? "");
      if (!brokerOrderId) throw new Error("brokerOrderId is required");
      const limitPrice = typeof args.limitPrice === "number" ? args.limitPrice : undefined;
      const quantity = typeof args.quantity === "number" ? args.quantity : undefined;
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerModifyOrder({
        provider,
        ...(accountRef !== undefined ? { accountRef } : {}),
        brokerOrderId,
        ...(limitPrice !== undefined ? { limitPrice } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      });
    }
    case "broker_get_fills": {
      const provider = providerFromArgs(args);
      const brokerOrderId = String(args.brokerOrderId ?? "");
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetFills({
        provider,
        ...(accountRef !== undefined ? { accountRef } : {}),
        brokerOrderId,
      });
    }
    case "broker_get_positions": {
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetPositions({
        provider,
        ...(accountRef !== undefined ? { accountRef } : {}),
      });
    }
    case "broker_get_balances": {
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetBalances({ provider, ...(accountRef !== undefined ? { accountRef } : {}) });
    }
    case "broker_get_margin": {
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetMargin({ provider, ...(accountRef !== undefined ? { accountRef } : {}) });
    }
    case "broker_capabilities": {
      const provider = providerFromArgs(args);
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return brokerGetCapabilities({ provider, ...(accountRef !== undefined ? { accountRef } : {}) });
    }
    case "broker_reconcile_positions": {
      const provider = providerFromArgs(args);
      const projectId = String(args.projectId ?? "");
      if (!projectId) throw new Error("projectId is required");
      const accountRef = typeof args.accountRef === "string" ? args.accountRef : undefined;
      return scanPositionReconciliation({
        projectId,
        provider,
        ...(accountRef !== undefined ? { accountRef } : {}),
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
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
        serverInfo: { name: "qubit-broker", version: "0.1.0" },
      },
    };
  }

  if (method === "notifications/initialized" || String(method).startsWith("notifications/")) {
    return null;
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const params = inbound.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const argsRaw = params.arguments;
    const args =
      argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    try {
      const out = await handleToolCall(name, args);
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out) }] },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { jsonrpc: "2.0", id, error: { code: -32000, message } };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `unknown method: ${String(method)}` },
  };
}

export async function runBrokerMcpMain(): Promise<void> {
  await runMigrations();
  for await (const msg of readMcpMessages()) {
    const res = await handleRequest(msg);
    if (res) writeMcpMessage(res);
  }
}

if (import.meta.main) {
  void runBrokerMcpMain().catch((e) => {
    console.error("[qubit-broker-mcp]", e);
    process.exit(1);
  });
}
