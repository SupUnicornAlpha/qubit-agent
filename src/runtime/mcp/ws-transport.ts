import type { JsonRpcResponse } from "./jsonrpc-ndjson";

export async function callMcpWsTool(input: {
  wsUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(input.wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("MCP WebSocket timeout"));
    }, input.timeoutMs ?? 60_000);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: input.toolName,
            arguments: input.arguments ?? {},
          },
        })
      );
    });

    ws.addEventListener("message", (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as JsonRpcResponse;
        if (raw.id !== undefined && String(raw.id) !== String(id)) return;
        if (raw.error) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(raw.error.message));
          return;
        }
        clearTimeout(timer);
        ws.close();
        resolve(raw.result);
      } catch (e) {
        clearTimeout(timer);
        ws.close();
        reject(e instanceof Error ? e : new Error("MCP WS parse error"));
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("MCP WebSocket error"));
    });
  });
}
