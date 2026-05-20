import { createHmac } from "node:crypto";
import type {
  IIntegrationAdapter,
  ParsedInboundMessage,
  SendInput,
  SendResult,
  WebhookVerifyContext,
  WebhookVerifyResult,
} from "./types";

/**
 * 飞书（Lark）自定义机器人 / 应用消息：
 * - 自定义群机器人（推荐 MVP）：meta.webhookUrl + secret（可选，启用签名校验）。
 *   POST {"msg_type":"text","content":{"text":"..."}}（带签名时携带 timestamp+sign）
 * - 应用消息（v1）：meta.openApiBase（默认 https://open.feishu.cn）+ access_token，
 *   外发请求由调用方填好 secret=access_token、externalChatId=open_chat_id/user_id。
 *
 * Webhook：默认要求 url_verification challenge 回包。
 * Inbound：im.message.receive_v1 事件解析（v2）。
 */

const FEISHU_OPEN_API = "https://open.feishu.cn";

function feishuSign(timestampSec: number, secret: string): string {
  const stringToSign = `${timestampSec}\n${secret}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

export const feishuAdapter: IIntegrationAdapter = {
  kind: "feishu",
  displayName: "Feishu / Lark",
  docsUrl: "https://open.feishu.cn/document/client-docs/bot-v3",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const meta = ctx.meta ?? {};
    const webhookUrl =
      typeof meta.webhookUrl === "string"
        ? String(meta.webhookUrl)
        : typeof meta.webhook_url === "string"
          ? String(meta.webhook_url)
          : "";

    // 路线 1：自定义群机器人
    if (webhookUrl) {
      const body: Record<string, unknown> = {
        msg_type: "text",
        content: { text },
      };
      if (ctx.secret) {
        const ts = Math.floor(Date.now() / 1000);
        body.timestamp = String(ts);
        body.sign = feishuSign(ts, ctx.secret);
      }
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
      const okFlag =
        res.ok && (payload?.code === 0 || payload?.StatusCode === 0 || payload?.code === undefined);
      const result: SendResult = { ok: okFlag, payload };
      if (!okFlag) result.errorMessage = JSON.stringify(payload);
      return result;
    }

    // 路线 2：应用消息 (im/v1/messages)
    const base = typeof meta.openApiBase === "string" ? String(meta.openApiBase) : FEISHU_OPEN_API;
    if (!ctx.secret)
      return { ok: false, errorMessage: "missing feishu tenant_access_token (secretRef)" };
    if (!ctx.externalChatId)
      return { ok: false, errorMessage: "missing receive_id (open_chat_id/user_id)" };
    const receiveIdType =
      typeof meta.receiveIdType === "string" ? String(meta.receiveIdType) : "chat_id";
    const url = `${base}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${ctx.secret}`,
      },
      body: JSON.stringify({
        receive_id: ctx.externalChatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const okFlag = res.ok && payload?.code === 0;
    const result: SendResult = { ok: okFlag, payload };
    if (typeof payload?.data?.message_id === "string")
      result.externalMessageId = payload.data.message_id;
    if (!okFlag) result.errorMessage = JSON.stringify(payload);
    return result;
  },

  verifyWebhook({ body }: WebhookVerifyContext): WebhookVerifyResult {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    // url_verification challenge 由飞书事件订阅首次回握使用
    if (payload?.type === "url_verification" && typeof payload.challenge === "string") {
      return { ok: true, challengeResponse: { challenge: payload.challenge } };
    }
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const event = payload?.event;
    const message = event?.message;
    if (!message) return null;
    const chatId = typeof message.chat_id === "string" ? message.chat_id : "";
    if (!chatId) return null;
    let text = "";
    try {
      const parsed =
        typeof message.content === "string" ? JSON.parse(message.content) : message.content;
      text = typeof parsed?.text === "string" ? (parsed.text as string).trim() : "";
    } catch {
      /* ignore */
    }
    if (!text) return null;
    const result: ParsedInboundMessage = { externalChatId: chatId, text, rawPayload: body };
    if (typeof message.message_id === "string") result.externalMessageId = message.message_id;
    if (typeof event?.sender?.sender_id?.open_id === "string") {
      result.externalUserId = event.sender.sender_id.open_id;
    }
    return result;
  },
};
