/**
 * 外部 Provider 共用的 HTTP 小客户端（fail-closed）。
 */
import type { ProviderRef } from "../types";

export type HttpProviderConfig = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export function readHttpProviderConfig(ref: ProviderRef): HttpProviderConfig | null {
  const raw = ref.config ?? {};
  const baseUrl =
    typeof raw.baseUrl === "string"
      ? raw.baseUrl.trim()
      : typeof raw.endpoint === "string"
        ? raw.endpoint.trim()
        : "";
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    timeoutMs:
      typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : 8000,
    headers:
      raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)
        ? (raw.headers as Record<string, string>)
        : undefined,
  };
}

export async function httpJson<T>(
  cfg: HttpProviderConfig,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(cfg.headers ?? {}),
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as T;
  } finally {
    clearTimeout(timer);
  }
}
