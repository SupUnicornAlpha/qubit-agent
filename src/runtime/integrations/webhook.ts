import type {
  IIntegrationAdapter,
  ParsedInboundMessage,
  SendInput,
  SendResult,
  WebhookVerifyContext,
  WebhookVerifyResult,
} from "./types";
import { fetchWithTimeout, IM_WEBHOOK_TIMEOUT_MS } from "../../util/fetch-with-timeout";

/**
 * 通用 outbound Webhook：
 * - send: meta.url(必填) + meta.method(默认 POST) + meta.headers(可选 KV)
 *   secret 可选；若提供则放入 Authorization: Bearer <secret>。
 *   body 为 {"text": "..."}，若 meta.template === "raw_text" 则发送纯文本。
 * - inbound：默认放行任何 POST，rawPayload 写入日志，text 字段尝试自动抽取。
 */

export const webhookAdapter: IIntegrationAdapter = {
  kind: "webhook",
  displayName: "Generic Webhook",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const meta = ctx.meta ?? {};
    const url =
      typeof meta.url === "string"
        ? String(meta.url)
        : typeof meta.webhookUrl === "string"
          ? String(meta.webhookUrl)
          : ctx.externalChatId; // fallback：直接把 externalChatId 当 URL
    if (!url)
      return { ok: false, errorMessage: "missing webhook url (meta.url or externalChatId)" };

    const method = typeof meta.method === "string" ? String(meta.method).toUpperCase() : "POST";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (meta.headers && typeof meta.headers === "object") {
      for (const [k, v] of Object.entries(meta.headers as Record<string, unknown>)) {
        if (typeof v === "string") headers[k] = v;
      }
    }
    if (ctx.secret) headers.Authorization = `Bearer ${ctx.secret}`;

    const isRawText = meta.template === "raw_text";
    const init: RequestInit = {
      method,
      headers: isRawText ? { ...headers, "Content-Type": "text/plain" } : headers,
      body: isRawText ? text : JSON.stringify({ text }),
    };
    const res = await fetchWithTimeout(url, init, IM_WEBHOOK_TIMEOUT_MS);
    const raw = await res.text().catch(() => "");
    let payload: unknown = raw;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw */
    }
    const result: SendResult = { ok: res.ok, payload };
    if (!res.ok) result.errorMessage = raw || `HTTP ${res.status}`;
    return result;
  },

  verifyWebhook(_ctx: WebhookVerifyContext): WebhookVerifyResult {
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const text =
      typeof payload?.text === "string"
        ? (payload.text as string).trim()
        : typeof payload?.content === "string"
          ? (payload.content as string).trim()
          : typeof payload?.message === "string"
            ? (payload.message as string).trim()
            : "";
    const chatId =
      typeof payload?.chatId === "string"
        ? payload.chatId
        : typeof payload?.channel === "string"
          ? payload.channel
          : "webhook";
    if (!text) return null;
    const result: ParsedInboundMessage = { externalChatId: chatId, text, rawPayload: body };
    if (payload?.id != null) result.externalMessageId = String(payload.id);
    return result;
  },
};
