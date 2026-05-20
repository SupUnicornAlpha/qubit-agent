import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import {
  COMMUNICATION_CHANNEL_KINDS,
  type CommunicationChannelKind,
  type communicationChannel,
  communicationMessageLog,
} from "../../db/sqlite/schema";
import { dingtalkAdapter } from "./dingtalk";
import { feishuAdapter } from "./feishu";
import { telegramAdapter } from "./telegram";
import type { IIntegrationAdapter, ParsedInboundMessage } from "./types";
import { webhookAdapter } from "./webhook";
import { wecomAdapter } from "./wecom";
import { whatsappAdapter } from "./whatsapp";

const adapters: Record<CommunicationChannelKind, IIntegrationAdapter> = {
  telegram: telegramAdapter,
  feishu: feishuAdapter,
  wecom: wecomAdapter,
  whatsapp: whatsappAdapter,
  dingtalk: dingtalkAdapter,
  webhook: webhookAdapter,
};

export function isSupportedIntegrationKind(kind: string): kind is CommunicationChannelKind {
  return (COMMUNICATION_CHANNEL_KINDS as readonly string[]).includes(kind);
}

export function getIntegrationAdapter(kind: CommunicationChannelKind): IIntegrationAdapter {
  return adapters[kind];
}

export interface AdapterDescriptor {
  kind: CommunicationChannelKind;
  displayName: string;
  docsUrl?: string | undefined;
}

export function listIntegrationAdapters(): AdapterDescriptor[] {
  return COMMUNICATION_CHANNEL_KINDS.map((kind) => {
    const adapter = adapters[kind];
    const item: AdapterDescriptor = { kind, displayName: adapter.displayName };
    if (adapter.docsUrl) item.docsUrl = adapter.docsUrl;
    return item;
  });
}

type ChannelRow = typeof communicationChannel.$inferSelect;

function readMeta(channel: ChannelRow): Record<string, unknown> {
  const raw = channel.metaJson as unknown;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface SendByChannelInput {
  channel: ChannelRow;
  text: string;
  extra?: Record<string, unknown> | undefined;
}

export interface SendByChannelResult {
  ok: boolean;
  externalMessageId?: string | undefined;
  payload?: unknown;
  errorMessage?: string | undefined;
  logId: string;
}

/** 统一发送：根据 channel.kind 选 adapter，并写入 communication_message_log。 */
export async function sendByChannel(input: SendByChannelInput): Promise<SendByChannelResult> {
  const { channel, text, extra } = input;
  if (!channel.enabled) {
    const logId = randomUUID();
    const db = await getDb();
    await db.insert(communicationMessageLog).values({
      id: logId,
      direction: "outbound",
      channelKind: channel.kind,
      channelId: channel.id,
      externalChatId: channel.externalChatId,
      payloadJson: { text, reason: "channel disabled" } as unknown as object,
      status: "failed",
      errorMessage: "channel disabled",
    });
    return { ok: false, errorMessage: "channel disabled", logId };
  }
  const adapter = adapters[channel.kind];
  const sendInput: import("./types").SendInput = {
    ctx: {
      channelId: channel.id,
      externalChatId: channel.externalChatId,
      meta: readMeta(channel),
      secret: channel.secretRef || "",
    },
    text,
  };
  if (extra) sendInput.extra = extra;
  const result = await adapter.send(sendInput);
  const db = await getDb();
  const logId = randomUUID();
  await db.insert(communicationMessageLog).values({
    id: logId,
    direction: "outbound",
    channelKind: channel.kind,
    channelId: channel.id,
    externalChatId: channel.externalChatId,
    externalMessageId: result.externalMessageId ?? null,
    payloadJson: (result.payload ?? { text }) as unknown as object,
    status: result.ok ? "success" : "failed",
    errorMessage: result.ok ? null : (result.errorMessage ?? "send failed"),
  });
  const out: SendByChannelResult = { ok: result.ok, payload: result.payload, logId };
  if (result.externalMessageId) out.externalMessageId = result.externalMessageId;
  if (result.errorMessage) out.errorMessage = result.errorMessage;
  return out;
}

export interface IngestInboundInput {
  channel: ChannelRow;
  body: unknown;
}

export function parseInboundFor(
  kind: CommunicationChannelKind,
  body: unknown
): ParsedInboundMessage | null {
  return adapters[kind].parseInbound(body);
}

export async function logInboundForChannel(
  channel: ChannelRow,
  body: unknown,
  parsed: ParsedInboundMessage | null
): Promise<string> {
  const logId = randomUUID();
  const db = await getDb();
  await db.insert(communicationMessageLog).values({
    id: logId,
    direction: "inbound",
    channelKind: channel.kind,
    channelId: channel.id,
    externalChatId: parsed?.externalChatId ?? channel.externalChatId,
    externalMessageId: parsed?.externalMessageId ?? null,
    payloadJson: body as unknown as object,
    status: "success",
  });
  return logId;
}
