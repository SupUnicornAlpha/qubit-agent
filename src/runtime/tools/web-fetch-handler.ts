import type { BuiltinToolHandler } from "./types";

/** Bounded public-web reader with hostname-level SSRF protection. */
export const WEB_FETCH_HANDLER: BuiltinToolHandler = async (_ctx, params) => {
  const raw = String(params.url ?? params.uri ?? "").trim();
  if (!raw) return { ok: false, error: "url is required" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `invalid url: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `unsupported scheme: ${url.protocol}（仅支持 http/https）` };
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "metadata.google.internal" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("fc") ||
    host.startsWith("fd");
  if (blocked) return { ok: false, error: `blocked host（loopback/内网/元数据地址）：${host}` };
  const maxChars = Math.min(Number(params.maxChars) || 20_000, 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "qubit-agent/web.fetch" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    let text = new TextDecoder().decode(buffer.slice(0, 2 * 1024 * 1024));
    if (/html/i.test(contentType) || /^\s*</.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      bytes: buffer.byteLength,
      truncated: text.length > maxChars,
      text: text.slice(0, maxChars),
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError" ? "timeout (15s)" : String(error);
    return { ok: false, error: `fetch failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
};
