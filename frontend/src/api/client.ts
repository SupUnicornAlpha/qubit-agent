const BACKEND_URL_KEY = "qubit_backend_url";
const DEFAULT_BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim() || "http://localhost:3000";

/** 后端根地址（不含路径）。若 localStorage 为空则默认 `localhost:3000`。 */
export function getBackendBaseUrl(): string {
  const raw = localStorage.getItem(BACKEND_URL_KEY)?.trim();
  const u = (raw && raw.length > 0 ? raw : DEFAULT_BACKEND_URL).replace(/\/+$/, "");
  return u.length > 0 ? u : DEFAULT_BACKEND_URL;
}

/**
 * 将「以 `/` 开头的 API 路径」与后端根地址合并。
 * 使用 WHATWG URL 规则：若根地址误配为 `http://host:3000/api/v1`，仍会得到 `http://host:3000/api/v1/market/klines`，
 * 而不会拼成 `.../api/v1/api/v1/...` 导致 404。
 */
export function backendFetchUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return new URL(p, `${getBackendBaseUrl()}/`).href;
}

export function setBackendBaseUrl(url: string): void {
  localStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/+$/, ""));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: initHeaders, ...restInit } = init ?? {};
  const res = await fetch(backendFetchUrl(path), {
    ...restInit,
    headers: {
      "Content-Type": "application/json",
      ...(initHeaders as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function httpGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

export async function httpPost<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...init,
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function httpPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function httpPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function httpDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

