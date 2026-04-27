const BACKEND_URL_KEY = "qubit_backend_url";
const DEFAULT_BACKEND_URL = "http://localhost:3000";

export function getBackendBaseUrl(): string {
  return localStorage.getItem(BACKEND_URL_KEY) ?? DEFAULT_BACKEND_URL;
}

export function setBackendBaseUrl(url: string): void {
  localStorage.setItem(BACKEND_URL_KEY, url.trim().replace(/\/$/, ""));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getBackendBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
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

export async function httpPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

