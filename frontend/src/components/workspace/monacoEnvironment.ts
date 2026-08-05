/**
 * Vite 下 Monaco worker 入口（monaco-editor@0.56+ 走 package exports）。
 * 正确子路径：monaco-editor/editor/...（不要写 esm/vs/...，会被 exports 错映射）。
 */
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

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
