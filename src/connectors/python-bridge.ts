import { randomUUID } from "node:crypto";
import type { ConnectorConfig } from "../types/connector";
import type { JsonRpcRequest, JsonRpcResponse } from "../types/connector";
import { BaseConnector } from "./base.connector";

/**
 * Concrete implementation of the Python sub-process JSON-RPC bridge.
 *
 * Protocol:
 *   stdin  → JSON-RPC Request  {"id":1,"method":"execute","params":{...}}
 *   stdout ← JSON-RPC Response {"id":1,"result":{...}}
 *   stderr ← log stream (ignored from protocol, forwarded to platform logger)
 */
export class PythonConnectorBridgeImpl extends BaseConnector {
  readonly meta;
  protected readonly scriptPath: string;
  protected readonly connectorName: string;

  private process: ReturnType<typeof Bun.spawn> | null = null;
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(opts: {
    scriptPath: string;
    connectorName: string;
    meta: typeof BaseConnector.prototype.meta;
  }) {
    super();
    this.scriptPath = opts.scriptPath;
    this.connectorName = opts.connectorName;
    this.meta = opts.meta;
  }

  protected async onInit(config: ConnectorConfig): Promise<void> {
    this.process = Bun.spawn(
      ["python", this.scriptPath, "--connector", this.connectorName],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    this._pipeStderr();
    this._readStdout();

    // Send init command
    await this._call("init", config);
  }

  protected async onHealthcheck() {
    const result = await this._call<{ healthy: boolean; message?: string }>(
      "healthcheck",
      {}
    );
    return {
      status: result.healthy ? ("healthy" as const) : ("unhealthy" as const),
      message: result.message,
    };
  }

  protected async onExecute<TOutput>(
    operation: string,
    payload: unknown
  ): Promise<TOutput> {
    return this._call<TOutput>("execute", { operation, payload });
  }

  protected async onShutdown(): Promise<void> {
    try {
      await this._call("shutdown", {});
    } finally {
      this.process?.kill();
      this.process = null;
    }
  }

  private _call<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      const request: JsonRpcRequest = { id, method, params };
      const line = JSON.stringify(request) + "\n";
      this.process?.stdin?.write(line);
    });
  }

  private _readStdout(): void {
    const proc = this.process;
    if (!proc?.stdout) return;

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response: JsonRpcResponse = JSON.parse(line);
            const pending = this.pendingRequests.get(String(response.id));
            if (pending) {
              this.pendingRequests.delete(String(response.id));
              if (response.error) {
                pending.reject(new Error(response.error.message));
              } else {
                pending.resolve(response.result);
              }
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    };

    pump().catch(console.error);
  }

  private _pipeStderr(): void {
    const proc = this.process;
    if (!proc?.stderr) return;

    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();

    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stderr.write(decoder.decode(value, { stream: true }));
      }
    };

    pump().catch(() => {});
  }
}
