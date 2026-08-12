import type { BuiltinToolHandler } from "./types";
import {
  decodeBoundedText,
  extractHtmlTitle,
  parsePublicHttpUrl,
  stripHtmlToText,
} from "./web-ssrf";

/** Bounded public-web reader with hostname-level SSRF protection. */
export const WEB_FETCH_HANDLER: BuiltinToolHandler = async (_ctx, params) => {
  const raw = String(params.url ?? params.uri ?? "").trim();
  const parsed = parsePublicHttpUrl(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, source: "web" };

  const maxChars = Math.min(Number(params.maxChars) || 20_000, 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(parsed.url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "qubit-agent/web.fetch" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    let text = decodeBoundedText(buffer);
    const title =
      /html/i.test(contentType) || /^\s*</.test(text) ? extractHtmlTitle(text) : undefined;
    if (/html/i.test(contentType) || /^\s*</.test(text)) {
      text = stripHtmlToText(text);
    }
    return {
      ok: response.ok,
      status: response.status,
      ...(title ? { title } : {}),
      finalUrl: response.url || parsed.url.toString(),
      contentType,
      bytes: buffer.byteLength,
      truncated: text.length > maxChars,
      text: text.slice(0, maxChars),
      source: "web",
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError" ? "timeout (15s)" : String(error);
    return { ok: false, error: `fetch failed: ${message}`, source: "web" };
  } finally {
    clearTimeout(timer);
  }
};
