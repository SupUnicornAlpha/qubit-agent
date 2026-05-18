import { isTauriEnv } from "../api/tauri";

export function normalizeExternalHref(raw: string): string {
  const u = raw.trim();
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Open http(s) links in the system browser (Tauri) or a new tab (web). */
export async function openExternalUrl(raw: string): Promise<void> {
  const href = normalizeExternalHref(raw);
  if (!href) return;

  if (isTauriEnv()) {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(href);
      return;
    } catch (e) {
      console.warn("[openExternalUrl] Tauri shell.open failed:", e);
    }
  }

  const opened = window.open(href, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.assign(href);
  }
}
