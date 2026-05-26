/**
 * 带超时的 fetch 封装。
 *
 * 背景（P0-4）：仓库里多处 connector / market 行情拉取都是裸 fetch，没有
 * AbortController。一旦上游 DNS 故障 / TCP 挂起 / 服务端不回 RST，那笔
 * fetch 永远 pending，把外层 ReAct 卡住 30s 后才被 sandbox 兜底，期间
 * UI 上只能看到 spinner，且后续相同链路会反复踩同样的坑。
 *
 * 用法：
 *   const res = await fetchWithTimeout(url, { headers: { ... } }, 15_000);
 *
 * - 默认 timeout=15s（行情类公开 API 12-15s 已远超 P95）
 * - 调用方自己的 AbortSignal 也支持：传 init.signal 时会和内部 controller `any` 合并
 * - 超时后抛 `FetchTimeoutError`，error.name='FetchTimeoutError'，便于上层做错误分类
 */

export class FetchTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * LLM 提供商专用超时（约 4 分钟）：
 * - Anthropic / Ollama 非流式响应在 60-180s 内常见，复杂推理可能更长
 * - 与 `Bun.serve` 的 `idleTimeout: 255s`（server.ts）对齐，超时优先在 fetch 层抛出
 * - 流式 API（OpenAI 走 SDK）不走此值；该常量给 gateway.ts 中的非流式 Anthropic / Ollama 用
 */
export const LLM_FETCH_TIMEOUT_MS = 240_000;

/**
 * IM webhook 推送 / 业务级 HTTP 调用专用超时（30s）：
 * - DingTalk / Feishu / WeCom / Telegram / WhatsApp / 自定义 Webhook
 * - 业务侧通常希望 IM 推送在合理时间内返回（30s 已远超 P95），失败后由
 *   integration 上层做重试/回包
 */
export const IM_WEBHOOK_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();

  /**
   * 如果调用方自己也传了 signal（如 RSS / Yahoo profile 已加的 12s 控制），
   * 任一信号触发都要 abort 内部 controller；否则只是丢弃外部 signal 就违反语义。
   */
  const externalSignal = init?.signal ?? undefined;
  let externalListener: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else {
      externalListener = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", externalListener, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new FetchTimeoutError(String(url), timeoutMs));
  }, timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } catch (err) {
    /**
     * AbortError 区分两种来源：
     *   - 我们的超时 timer → 重抛 FetchTimeoutError（带 url + timeoutMs）让上层分类
     *   - 外部 signal → 保留原 AbortError，让 caller 的 reason 透传
     */
    if (err instanceof Error && err.name === "AbortError") {
      const reason = controller.signal.reason;
      if (reason instanceof FetchTimeoutError) throw reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal && externalListener) {
      externalSignal.removeEventListener("abort", externalListener);
    }
  }
}
