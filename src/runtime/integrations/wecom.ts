import type {
  IIntegrationAdapter,
  ParsedInboundMessage,
  SendInput,
  SendResult,
  WebhookVerifyContext,
  WebhookVerifyResult,
} from "./types";

/**
 * 企业微信（WeCom / WeChat Work）：
 * - 群机器人（推荐 MVP）：meta.webhookUrl，无需 secret。
 *   POST {"msgtype":"text","text":{"content":"..."}}
 * - 应用消息：meta.corpId + meta.agentId + secret(=access_token)；
 *   POST {externalChatId 解释为 touser/toparty/totag}
 *
 * 入站事件：企业微信回调走 XML+AES（生产建议接 SDK）。这里只接 JSON 试连消息。
 */

const WECOM_DEFAULT_BASE = "https://qyapi.weixin.qq.com";

export const wecomAdapter: IIntegrationAdapter = {
  kind: "wecom",
  displayName: "WeCom (企业微信)",
  docsUrl: "https://developer.work.weixin.qq.com/document/path/91770",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const meta = ctx.meta ?? {};
    const webhookUrl =
      typeof meta.webhookUrl === "string"
        ? String(meta.webhookUrl)
        : typeof meta.webhook_url === "string"
          ? String(meta.webhook_url)
          : "";

    // 路线 1：群机器人
    if (webhookUrl) {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
      const okFlag = res.ok && payload?.errcode === 0;
      const result: SendResult = { ok: okFlag, payload };
      if (!okFlag) result.errorMessage = JSON.stringify(payload);
      return result;
    }

    // 路线 2：应用消息
    const base =
      typeof meta.openApiBase === "string" ? String(meta.openApiBase) : WECOM_DEFAULT_BASE;
    const agentId = meta.agentId != null ? String(meta.agentId) : "";
    if (!ctx.secret) return { ok: false, errorMessage: "missing wecom access_token (secretRef)" };
    if (!agentId) return { ok: false, errorMessage: "missing wecom agentId (meta.agentId)" };
    if (!ctx.externalChatId)
      return { ok: false, errorMessage: "missing touser/toparty (externalChatId)" };
    const url = `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(ctx.secret)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        touser: ctx.externalChatId,
        msgtype: "text",
        agentid: Number(agentId),
        text: { content: text },
        safe: 0,
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const okFlag = res.ok && payload?.errcode === 0;
    const result: SendResult = { ok: okFlag, payload };
    if (payload?.msgid) result.externalMessageId = String(payload.msgid);
    if (!okFlag) result.errorMessage = JSON.stringify(payload);
    return result;
  },

  verifyWebhook(_ctx: WebhookVerifyContext): WebhookVerifyResult {
    // 企业微信回调走 AES+签名，建议使用官方 SDK；这里默认放行以便对接调试。
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const text = typeof payload?.text === "string" ? (payload.text as string).trim() : "";
    const chatId =
      typeof payload?.chatId === "string"
        ? payload.chatId
        : typeof payload?.fromUserName === "string"
          ? payload.fromUserName
          : "";
    if (!text || !chatId) return null;
    const result: ParsedInboundMessage = { externalChatId: chatId, text, rawPayload: body };
    if (payload?.msgId != null) result.externalMessageId = String(payload.msgId);
    if (typeof payload?.fromUserName === "string") result.externalUserId = payload.fromUserName;
    return result;
  },
};
