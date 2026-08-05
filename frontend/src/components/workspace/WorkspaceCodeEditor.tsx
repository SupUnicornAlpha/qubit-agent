/**
 * Workspace 文件编辑器：Monaco 为主（02 U6/V8），加载失败则 Tokyo 降级。
 * flex 父级若仅有 minHeight，Monaco 的 height:100% 会解析为 0 → 黑屏无字；
 * 因此用 ResizeObserver 量宿主像素尺寸再传给 Editor。
 */
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import type { CSSProperties, FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  inferTokyoLanguage,
  type TokyoCodeLanguage,
} from "../../lib/tokyoSyntaxHighlight";
import { TokyoCodeEditor } from "../code/TokyoCodeEditor";
import { ensureMonacoEnvironment } from "./monacoEnvironment";

ensureMonacoEnvironment();
loader.config({ monaco });

function monacoLangFromPath(path: string): string {
  const ext = (path.includes(".") ? path.split(".").pop() : "")?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
      return "ini";
    case "sql":
      return "sql";
    case "csv":
    case "txt":
      return "plaintext";
    default:
      return "plaintext";
  }
}

function tokyoLangFromPath(path: string): TokyoCodeLanguage {
  const ext = path.includes(".") ? path.split(".").pop() : "";
  return inferTokyoLanguage(ext);
}

export const WorkspaceCodeEditor: FC<{
  value: string;
  onChange: (value: string) => void;
  path: string;
  readOnly?: boolean;
}> = ({ value, onChange, path, readOnly = false }) => {
  const [engine, setEngine] = useState<"monaco" | "tokyo">("monaco");
  const [monacoReady, setMonacoReady] = useState(false);
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const monacoLanguage = useMemo(() => monacoLangFromPath(path), [path]);
  const tokyoLanguage = useMemo(() => tokyoLangFromPath(path), [path]);

  useEffect(() => {
    let cancelled = false;
    void loader
      .init()
      .then(() => {
        if (!cancelled) setMonacoReady(true);
      })
      .catch(() => {
        if (!cancelled) setEngine("tokyo");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || engine !== "monaco") return;
    const apply = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      setHostSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, [engine, monacoReady]);

  const onMount: OnMount = (ed) => {
    ed.updateOptions({
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      tabSize: 2,
      renderLineHighlight: "line",
      padding: { top: 8, bottom: 8 },
      automaticLayout: true,
    });
  };

  if (engine === "tokyo") {
    return (
      <div style={styles.wrap} data-qb-editor-engine="tokyo">
        <div style={styles.badge}>Tokyo（Monaco 不可用时降级）</div>
        <TokyoCodeEditor
          value={value}
          onChange={onChange}
          language={tokyoLanguage}
          filename={path}
          readOnly={readOnly}
          flex={1}
          minHeight={360}
          maxHeight="100%"
        />
      </div>
    );
  }

  const editorH = hostSize.h > 0 ? hostSize.h : 360;
  const editorW = hostSize.w > 0 ? hostSize.w : undefined;

  return (
    <div style={styles.wrap} data-qb-editor-engine="monaco">
      <div style={styles.badge}>Monaco · {monacoLanguage}</div>
      {!monacoReady ? <div style={styles.loading}>编辑器加载中…</div> : null}
      <div ref={hostRef} style={styles.editorHost}>
        {monacoReady ? (
          <Editor
            height={editorH}
            width={editorW}
            theme="vs-dark"
            language={monacoLanguage}
            path={path}
            value={value}
            onChange={(v) => onChange(v ?? "")}
            onMount={onMount}
            loading={<div style={styles.loading}>Monaco…</div>}
            options={{
              readOnly,
              automaticLayout: true,
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              lineNumbers: "on",
            }}
            onValidate={() => undefined}
          />
        ) : null}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  wrap: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflow: "hidden",
  },
  badge: {
    flexShrink: 0,
    fontSize: 10,
    color: "#71717a",
    letterSpacing: "0.02em",
  },
  editorHost: {
    flex: 1,
    minHeight: 360,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid #2a2a30",
    background: "#1e1e1e",
  },
  loading: {
    fontSize: 12,
    color: "#a1a1aa",
    padding: "8px 0",
  },
};
