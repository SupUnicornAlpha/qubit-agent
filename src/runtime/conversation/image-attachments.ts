/** Safe, persisted image inputs for the chat composer. */
export const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

const ACCEPTED_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

export type ChatImageAttachment = {
  kind: "image";
  dataUrl: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name?: string;
};

function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Validate untrusted HTTP input before it is saved or forwarded to an LLM provider. */
export function parseChatImageAttachments(raw: unknown): ChatImageAttachment[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      return parseChatImageAttachments(JSON.parse(raw));
    } catch {
      throw new Error("attachments must be valid JSON");
    }
  }
  if (!Array.isArray(raw)) throw new Error("attachments must be an array");
  if (raw.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
    throw new Error(`at most ${MAX_CHAT_IMAGE_ATTACHMENTS} images may be attached`);
  }
  let totalBytes = 0;
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`attachment ${index + 1} must be an image object`);
    }
    const candidate = value as Record<string, unknown>;
    const dataUrl = typeof candidate.dataUrl === "string" ? candidate.dataUrl.trim() : "";
    const match = DATA_URL.exec(dataUrl);
    if (!match) {
      throw new Error(`attachment ${index + 1} must be a PNG, JPEG, WebP, or GIF data URL`);
    }
    const [, rawMediaType = "", base64 = ""] = match;
    const mediaType = rawMediaType.toLowerCase();
    const bytes = decodedByteLength(base64);
    totalBytes += bytes;
    if (!ACCEPTED_MEDIA_TYPES.has(mediaType) || bytes > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(`attachment ${index + 1} exceeds the supported image limit`);
    }
    if (totalBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
      throw new Error(
        `attached images exceed the ${MAX_CHAT_IMAGE_TOTAL_BYTES / 1024 / 1024}MB total limit`
      );
    }
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 160) : "";
    return {
      kind: "image" as const,
      dataUrl,
      mediaType: mediaType as ChatImageAttachment["mediaType"],
      ...(name ? { name } : {}),
    };
  });
}

/** Stored historic rows must not make the whole conversation unreadable if corrupt. */
export function readChatImageAttachments(raw: unknown): ChatImageAttachment[] {
  try {
    return parseChatImageAttachments(raw);
  } catch {
    return [];
  }
}

/** Convert browser-facing fields to Prime Protocol's snake_case attachment wire format. */
export function toCoreImageAttachments(
  attachments: ChatImageAttachment[]
): Array<Record<string, string>> {
  return attachments.map((attachment) => ({
    kind: "image_data",
    data_url: attachment.dataUrl,
    media_type: attachment.mediaType,
  }));
}
