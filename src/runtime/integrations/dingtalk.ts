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
 * 钉钉 / DingTalk：
 * - 自定义群机器人（推荐 MVP）：meta.webhookUrl + secret（启用签名时必填）。
 *   POST {"msgtype":"text","text":{"content":"..."}}
 *   带签名时 URL 追加 timestamp/sign。
 *
 * - 应用消息：meta.openApiBase + meta.agentId + secret(=access_token)
 *   externalChatId 解释为 userid_list / 部门 ID。
 *
 * - inbound: 钉钉机器人 outgoing 消息走签名校验：timestamp+secret 签名 == sign。
 */

function dingTalkSign(timestampMs: number, secret: string): string {
  const stringToSign = `${timestampMs}\n${secret}`;
  return createHmac("sha256", secret).update(stringToSign).digest("base64");
}

export const dingtalkAdapter: IIntegrationAdapter = {
  kind: "dingtalk",
  displayName: "DingTalk",
  docsUrl: "https://open.dingtalk.com/document/orgapp/custom-robot-access",

  async send({ ctx, text }: SendInput): Promise<SendResult> {
    const meta = ctx.meta ?? {};
    const webhookUrl =
      typeof meta.webhookUrl === "string"
        ? String(meta.webhookUrl)
        : typeof meta.webhook_url === "string"
          ? String(meta.webhook_url)
          : "";

    if (webhookUrl) {
      let target = webhookUrl;
      if (ctx.secret) {
        const ts = Date.now();
        const sign = encodeURIComponent(dingTalkSign(ts, ctx.secret));
        target += `${target.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
      }
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
      const okFlag = res.ok && (payload?.errcode === 0 || payload?.errcode === undefined);
      const result: SendResult = { ok: okFlag, payload };
      if (!okFlag) result.errorMessage = JSON.stringify(payload);
      return result;
    }

    // 应用消息（默认走开放平台 v1.0）
    const base =
      typeof meta.openApiBase === "string" ? String(meta.openApiBase) : "https://oapi.dingtalk.com";
    const agentId = meta.agentId != null ? String(meta.agentId) : "";
    if (!ctx.secret)
      return { ok: false, errorMessage: "missing dingtalk access_token (secretRef)" };
    if (!agentId) return { ok: false, errorMessage: "missing meta.agentId" };
    if (!ctx.externalChatId)
      return { ok: false, errorMessage: "missing userid_list (externalChatId)" };
    const url = `${base}/topapi/message/corpconversation/asyncsend_v2?access_token=${encodeURIComponent(ctx.secret)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: Number(agentId),
        userid_list: ctx.externalChatId,
        msg: { msgtype: "text", text: { content: text } },
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    const okFlag = res.ok && payload?.errcode === 0;
    const result: SendResult = { ok: okFlag, payload };
    if (payload?.task_id) result.externalMessageId = String(payload.task_id);
    if (!okFlag) result.errorMessage = JSON.stringify(payload);
    return result;
  },

  verifyWebhook({ body, secret }: WebhookVerifyContext): WebhookVerifyResult {
    if (!secret) return { ok: true };
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const ts = payload?.timestamp != null ? Number(payload.timestamp) : Number.NaN;
    const provided = typeof payload?.sign === "string" ? payload.sign : "";
    if (!Number.isFinite(ts) || !provided) {
      // 部分场景（如自定义机器人 outgoing）签名放 header，由调用方在 router 里塞 body.{timestamp,sign}。
      return { ok: false, reason: "missing timestamp/sign in body" };
    }
    const expected = dingTalkSign(ts, secret);
    if (expected !== provided) return { ok: false, reason: "invalid dingtalk sign" };
    return { ok: true };
  },

  parseInbound(body: unknown): ParsedInboundMessage | null {
    const payload = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    const text =
      typeof payload?.text?.content === "string" ? (payload.text.content as string).trim() : "";
    const chatId =
      typeof payload?.conversationId === "string"
        ? payload.conversationId
        : typeof payload?.senderId === "string"
          ? payload.senderId
          : "";
    if (!text || !chatId) return null;
    const result: ParsedInboundMessage = { externalChatId: chatId, text, rawPayload: body };
    if (payload?.msgId != null) result.externalMessageId = String(payload.msgId);
    const userId =
      typeof payload?.senderStaffId === "string"
        ? payload.senderStaffId
        : typeof payload?.senderId === "string"
          ? payload.senderId
          : "";
    if (userId) result.externalUserId = userId;
    return result;
  },
};
