/**
 * IM / Webhook 集成统一抽象。
 *
 * 每个 provider 实现 IIntegrationAdapter，对外暴露 send/verifyWebhook/parseInbound 三个钩子，
 * 由 dispatcher 根据 channel.kind 路由调用。
 */

import type { CommunicationChannelKind } from "../../db/sqlite/schema";

export type IntegrationKind = CommunicationChannelKind;

/** 用于 outbound 推送的目标。token 可来源于 channel.secretRef 或环境变量。 */
export interface OutboundContext {
  channelId?: string | undefined;
  /** 平台侧 chatId / open_id / mobile / webhook target */
  externalChatId: string;
  /** Provider 私有结构化参数（在 channel.metaJson 内）。 */
  meta: Record<string, unknown>;
  /** 通用凭证，含义由各 provider 决定（bot token / app secret / signing key 等）。 */
  secret: string;
}

export interface SendInput {
  ctx: OutboundContext;
  text: string;
  /** 富文本/卡片附加内容（provider 私有），可选。 */
  extra?: Record<string, unknown> | undefined;
}

export interface SendResult {
  ok: boolean;
  /** 平台侧返回的消息 ID，便于日志关联。 */
  externalMessageId?: string | undefined;
  /** 调试/审计：原始响应 */
  payload?: unknown;
  errorMessage?: string | undefined;
}

/** Webhook 入口签名校验上下文（不依赖具体 HTTP framework） */
export interface WebhookVerifyContext {
  headers: Record<string, string>;
  rawBody: string;
  body: unknown;
  /** 渠道侧配置的 secret（可空，意味着关闭校验） */
  secret?: string | undefined;
  /** Provider 私有 meta */
  meta?: Record<string, unknown> | undefined;
}

export interface WebhookVerifyResult {
  ok: boolean;
  reason?: string | undefined;
  /** 若 provider 要求 challenge 回包，由 adapter 返回。 */
  challengeResponse?: Record<string, unknown> | string | undefined;
}

export interface ParsedInboundMessage {
  /** 平台侧消息 ID */
  externalMessageId?: string | undefined;
  /** 平台侧 chat/会话 ID（与 channel.externalChatId 比对/创建用） */
  externalChatId: string;
  /** 平台侧用户 ID/手机号（可选） */
  externalUserId?: string | undefined;
  /** 文本（去 @bot 等前缀后的内容） */
  text: string;
  /** 原始 payload，写入 communication_message_log.payload_json */
  rawPayload: unknown;
}

export interface IIntegrationAdapter {
  kind: IntegrationKind;
  /** UI 展示名称 */
  displayName: string;
  /** UI 文档/帮助链接（可选） */
  docsUrl?: string;
  send(input: SendInput): Promise<SendResult>;
  /** 默认实现：直接 ok。各家若有签名/时间戳校验则覆盖。 */
  verifyWebhook(ctx: WebhookVerifyContext): Promise<WebhookVerifyResult> | WebhookVerifyResult;
  /** 默认实现：返回 null，意味着该 provider 不支持入站消息。 */
  parseInbound(body: unknown): ParsedInboundMessage | null;
}
