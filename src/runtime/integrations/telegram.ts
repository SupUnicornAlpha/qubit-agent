import type {
  IIntegrationAdapter,
  ParsedInboundMessage,
  SendInput,
  SendResult,
  WebhookVerifyContext,
  WebhookVerifyResult,
} from "./types";

const TELEGRAM_API = "https://api.telegram.org";

export const telegramAdapter: IIntegrationAdapter = {
  kind: "telegram",
  displayName: "Telegram Bot",
  docsUrl: "https://core.telegram.org/bots/api",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const token = (ctx.secret || process.env.QUBIT_TELEGRAM_BOT_TOKEN || "").trim();
    if (!token)
      return {
        ok: false,
        errorMessage: "missing telegram bot token (secretRef / QUBIT_TELEGRAM_BOT_TOKEN)",
      };
    if (!ctx.externalChatId) return { ok: false, errorMessage: "missing telegram chat_id" };

    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ctx.externalChatId, text }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const messageId = payload?.result?.message_id;
    const result: SendResult = { ok: res.ok, payload };
    if (typeof messageId === "number" || typeof messageId === "string") {
      result.externalMessageId = String(messageId);
    }
    if (!res.ok) result.errorMessage = JSON.stringify(payload);
    return result;
  },

  verifyWebhook({ headers, secret }: WebhookVerifyContext): WebhookVerifyResult {
    if (!secret) return { ok: true };
    const provided = headers["x-telegram-bot-api-secret-token"] ?? "";
    if (provided !== secret) return { ok: false, reason: "invalid telegram webhook secret" };
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const message = payload.message ?? payload.edited_message;
    const text = typeof message?.text === "string" ? (message.text as string).trim() : "";
    const chatId = message?.chat?.id ? String(message.chat.id) : "";
    if (!text || !chatId) return null;
    const result: ParsedInboundMessage = { externalChatId: chatId, text, rawPayload: body };
    if (message?.message_id != null) result.externalMessageId = String(message.message_id);
    if (message?.from?.id != null) result.externalUserId = String(message.from.id);
    return result;
  },
};
