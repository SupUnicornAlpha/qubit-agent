import { describe, expect, test } from "bun:test";
import {
  MAX_CHAT_IMAGE_ATTACHMENTS,
  parseChatImageAttachments,
  readChatImageAttachments,
  toCoreImageAttachments,
} from "../image-attachments";

const PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+S1gYGQAAAABJRU5ErkJggg==";

describe("chat image attachments", () => {
  test("validates and normalizes a browser image Data URL", () => {
    const attachments = parseChatImageAttachments([
      { kind: "image", dataUrl: PIXEL_PNG, mediaType: "image/png", name: " chart.png " },
    ]);

    expect(attachments).toEqual([
      { kind: "image", dataUrl: PIXEL_PNG, mediaType: "image/png", name: "chart.png" },
    ]);
    expect(toCoreImageAttachments(attachments)).toEqual([
      { kind: "image_data", data_url: PIXEL_PNG, media_type: "image/png" },
    ]);
  });

  test("rejects non-image and excessive attachment input", () => {
    expect(() =>
      parseChatImageAttachments([{ dataUrl: "data:text/plain;base64,SGVsbG8=" }])
    ).toThrow("PNG, JPEG, WebP, or GIF");
    expect(() =>
      parseChatImageAttachments(
        Array.from({ length: MAX_CHAT_IMAGE_ATTACHMENTS + 1 }, () => ({ dataUrl: PIXEL_PNG }))
      )
    ).toThrow("at most");
  });

  test("treats corrupt historic persisted data as an empty image list", () => {
    expect(readChatImageAttachments("not json")).toEqual([]);
  });
});
