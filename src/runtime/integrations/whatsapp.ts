import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  IIntegrationAdapter,
  ParsedInboundMessage,
  SendInput,
  SendResult,
  WebhookVerifyContext,
  WebhookVerifyResult,
} from "./types";

/**
 * WhatsApp Cloud API (Meta Graph)：
 * - send: POST https://graph.facebook.com/{version}/{phoneNumberId}/messages
 *   ctx.secret = access_token；ctx.externalChatId = E.164 手机号；
 *   meta.phoneNumberId = WABA phone_number_id；meta.graphVersion = v20.0（默认）。
 *
 * - 接入 webhook 时 Meta 会先发 GET ?hub.mode=subscribe&hub.verify_token=xxx&hub.challenge=yyy，
 *   adapter 在 verifyWebhook 中根据 meta.verifyToken 校验 hub_verify_token，
 *   并要求路由把 challenge 直接回写 200。
 *
 * - inbound 走 GraphAPI 推送：{entry:[{changes:[{value:{messages:[{text:{body}}], contacts:[{wa_id}]}}]}]}
 */

const DEFAULT_GRAPH_VERSION = "v20.0";

function verifySignature(secret: string, rawBody: string, providedSig: string): boolean {
  if (!providedSig.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(providedSig);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const whatsappAdapter: IIntegrationAdapter = {
  kind: "whatsapp",
  displayName: "WhatsApp Cloud API",
  docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const meta = ctx.meta ?? {};
    if (!ctx.secret)
      return { ok: false, errorMessage: "missing whatsapp access_token (secretRef)" };
    if (!ctx.externalChatId)
      return { ok: false, errorMessage: "missing recipient phone (externalChatId, E.164)" };
    const phoneNumberId = meta.phoneNumberId != null ? String(meta.phoneNumberId) : "";
    if (!phoneNumberId) return { ok: false, errorMessage: "missing meta.phoneNumberId" };
    const version =
      typeof meta.graphVersion === "string" ? String(meta.graphVersion) : DEFAULT_GRAPH_VERSION;
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.secret}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: ctx.externalChatId,
        type: "text",
        text: { body: text, preview_url: false },
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const result: SendResult = { ok: res.ok, payload };
    if (Array.isArray(payload?.messages) && payload.messages[0]?.id) {
      result.externalMessageId = String(payload.messages[0].id);
    }
    if (!res.ok) result.errorMessage = JSON.stringify(payload);
    return result;
  },

  verifyWebhook({
    headers,
    rawBody,
    body,
    secret,
    meta,
  }: WebhookVerifyContext): WebhookVerifyResult {
    // 订阅握手（GET 也会进入这里，路由层负责把 query 当成 body 传入）
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    if (payload?.["hub.mode"] === "subscribe") {
      const verifyToken =
        typeof meta?.verifyToken === "string"
          ? String(meta.verifyToken)
          : typeof meta?.verify_token === "string"
            ? String(meta.verify_token)
            : "";
      if (verifyToken && payload?.["hub.verify_token"] !== verifyToken) {
        return { ok: false, reason: "invalid hub.verify_token" };
      }
      return {
        ok: true,
        challengeResponse:
          typeof payload?.["hub.challenge"] === "string" ||
          typeof payload?.["hub.challenge"] === "number"
            ? String(payload["hub.challenge"])
            : "",
      };
    }
    // 业务回调签名校验（X-Hub-Signature-256）
    const sig = headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"] ?? "";
    if (secret && sig) {
      if (!verifySignature(secret, rawBody, sig)) {
        return { ok: false, reason: "invalid x-hub-signature-256" };
      }
    }
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const value = payload?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return null;
    const text =
      typeof message?.text?.body === "string" ? (message.text.body as string).trim() : "";
    const from = typeof message?.from === "string" ? message.from : "";
    if (!text || !from) return null;
    const result: ParsedInboundMessage = {
      externalChatId: from,
      externalUserId: from,
      text,
      rawPayload: body,
    };
    if (typeof message?.id === "string") result.externalMessageId = message.id;
    return result;
  },
};
