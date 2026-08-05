/**
 * Vite 下 Monaco worker 入口（避免默认 CDN / 错 worker）。
 * 须在加载 Editor 前执行。
 */
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (_: unknown, label: string) => Worker;
    };
  }
}

export function ensureMonacoEnvironment(): void {
  if (typeof window === "undefined") return;
  if (window.MonacoEnvironment) return;
  window.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === "json") return new jsonWorker();
      if (label === "typescript" || label === "javascript") return new tsWorker();
      return new editorWorker();
    },
  };
}
