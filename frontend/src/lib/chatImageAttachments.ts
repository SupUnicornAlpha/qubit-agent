import type { ChatImageAttachment } from "../api/types";

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageAttachmentFromFile(file: File): Promise<ChatImageAttachment> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
      reject(new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片"));
      return;
    }
    if (file.size > MAX_CHAT_IMAGE_BYTES) {
      reject(new Error("单张图片不能超过 5MB"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () =>
      resolve({
        kind: "image",
        dataUrl: String(reader.result),
        mediaType: file.type.toLowerCase() as ChatImageAttachment["mediaType"],
        ...(file.name ? { name: file.name.slice(0, 160) } : {}),
      });
    reader.readAsDataURL(file);
  });
}

export function clipboardImageFiles(clipboardData: DataTransfer): File[] {
  const directFiles = Array.from(clipboardData.files).filter((file) =>
    file.type.startsWith("image/")
  );
  if (directFiles.length > 0) return directFiles;
  return Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
