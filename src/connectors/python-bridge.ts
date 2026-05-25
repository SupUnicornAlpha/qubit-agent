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

/** P0-4：单笔 _call 等 stdout 响应的最长时间。 30s 对所有 connector 都足够。 */
const PYTHON_CALL_TIMEOUT_MS = 30_000;

export class PythonConnectorBridgeImpl extends BaseConnector {
  readonly meta;
  protected readonly scriptPath: string;
  protected readonly connectorName: string;

  private process: ReturnType<typeof Bun.spawn> | null = null;
  private pendingRequests = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /**
   * P0-4：跟踪子进程退出 promise；exit 时把所有还挂着的 pending request 全 reject，
   * 不让任何一笔 _call 因为子进程崩了而永远 pending（旧实现的最大 wedged 源）。
   */
  private exitWatcher: Promise<void> | null = null;

  private readonly pythonBin: string;
  private readonly cwd: string | undefined;

  constructor(opts: {
    scriptPath: string;
    connectorName: string;
    meta: typeof BaseConnector.prototype.meta;
    pythonBin?: string;
    cwd?: string;
  }) {
    super();
    this.scriptPath = opts.scriptPath;
    this.connectorName = opts.connectorName;
    this.meta = opts.meta;
    this.pythonBin = opts.pythonBin ?? process.env["QUBIT_PYTHON"] ?? "python3";
    this.cwd = opts.cwd;
  }

  protected async onInit(config: ConnectorConfig): Promise<void> {
    this.process = Bun.spawn(
      [this.pythonBin, this.scriptPath, "--connector", this.connectorName],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: this.cwd,
      }
    );

    this._pipeStderr();
    this._readStdout();
    this._watchExit();

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
      /** shutdown 超时不要再阻塞，子进程可能已经退出；catch 后强 kill */
      await this._call("shutdown", {}).catch(() => undefined);
    } finally {
      this.process?.kill();
      this.process = null;
      this._rejectAllPending(new Error("connector shutdown"));
    }
  }

  private _call<T>(method: string, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();

      /**
       * P0-4：所有 _call 都强加 timeout。超时后从 pendingRequests 移除，让后续
       * stdout 即使迟来也找不到 entry（被 #_readStdout 忽略），不会重复 resolve。
       */
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(
            new Error(
              `python-bridge[${this.connectorName}] ${method} timed out after ${PYTHON_CALL_TIMEOUT_MS}ms (subprocess likely hung)`
            )
          );
        }
      }, PYTHON_CALL_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const request: JsonRpcRequest = { id, method, params };
      const line = JSON.stringify(request) + "\n";
      try {
        this.process?.stdin?.write(line);
      } catch (err) {
        /** stdin 写挂（pipe 关闭）也立刻 reject，不要等 timeout */
        if (this.pendingRequests.delete(id)) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  }

  /**
   * P0-4：子进程崩 / 退出时把所有还 pending 的 _call 全部 reject。
   * 等同 pendingRequests 的"安全网"——只要子进程死了，没有任何一笔会永远卡住。
   */
  private _watchExit(): void {
    const proc = this.process;
    if (!proc) return;
    const exited = proc.exited;
    if (!exited) return;
    this.exitWatcher = exited.then((code) => {
      const reason = new Error(
        `python-bridge[${this.connectorName}] subprocess exited unexpectedly (code=${code ?? "null"})`
      );
      this._rejectAllPending(reason);
    });
  }

  private _rejectAllPending(err: Error): void {
    if (this.pendingRequests.size === 0) return;
    const entries = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();
    for (const [, p] of entries) {
      clearTimeout(p.timer);
      p.reject(err);
    }
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
              clearTimeout(pending.timer);
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
