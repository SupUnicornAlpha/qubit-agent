/** Shared URL / SSRF helpers for official internet builtins. */

export type ParsedPublicHttpUrl = { ok: true; url: URL } | { ok: false; error: string };

export function parsePublicHttpUrl(raw: string): ParsedPublicHttpUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "url is required" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: `invalid url: ${trimmed}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `unsupported scheme: ${url.protocol}（仅支持 http/https）` };
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedHostname(host)) {
    return { ok: false, error: `blocked host（loopback/内网/元数据地址）：${host}` };
  }
  return { ok: true, url };
}

export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    h === "metadata.google.internal" ||
    h.endsWith(".local") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith("fc") ||
    h.startsWith("fd")
  );
}

export function decodeBoundedText(buffer: ArrayBuffer, maxBytes = 2 * 1024 * 1024): string {
  return new TextDecoder().decode(buffer.slice(0, maxBytes));
}

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function stripHtmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function extractHtmlTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  const title = stripHtmlToText(m[1]).slice(0, 300);
  return title || undefined;
}
