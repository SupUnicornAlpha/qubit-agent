import type { CSSProperties, FC, TextareaHTMLAttributes } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  countLines,
  cursorLineCol,
  highlightTokyoCode,
  inferTokyoLanguage,
  type TokyoCodeLanguage,
} from "../../lib/tokyoSyntaxHighlight";

export interface TokyoCodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: TokyoCodeLanguage;
  filename?: string;
  readOnly?: boolean;
  showChrome?: boolean;
  showStatus?: boolean;
  flat?: boolean;
  minHeight?: number | string;
  maxHeight?: number | string;
  flex?: number | string;
  className?: string;
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "readOnly" | "className" | "style"
  >;
}

const LANG_LABEL: Record<TokyoCodeLanguage, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  plaintext: "Plain",
};

const LINE_HEIGHT_PX = 18;
const PAD_Y_PX = 20;

export const TokyoCodeEditor: FC<TokyoCodeEditorProps> = ({
  value,
  onChange,
  language = "python",
  filename,
  readOnly = false,
  showChrome = true,
  showStatus = true,
  flat = false,
  minHeight = 120,
  maxHeight,
  flex,
  className,
  textareaProps,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [viewportMin, setViewportMin] = useState(120);

  const lineCount = useMemo(() => countLines(value), [value]);
  const highlighted = useMemo(() => highlightTokyoCode(value || "", language), [value, language]);

  const gutterLines = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1),
    [lineCount]
  );

  const syncCursor = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    setCursor(cursorLineCol(value, el.selectionStart));
  }, [value]);

  const contentHeight = useMemo(
    () => Math.max(lineCount * LINE_HEIGHT_PX + PAD_Y_PX, viewportMin),
    [lineCount, viewportMin]
  );

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportMin(Math.max(el.clientHeight, 80));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const sc = scrollRef.current;
    const gutter = gutterRef.current;
    if (!sc || !gutter) return;
    gutter.scrollTop = sc.scrollTop;
  }, []);

  const focusTextarea = useCallback(() => {
    if (readOnly) return;
    textareaRef.current?.focus();
  }, [readOnly]);

  const rootStyle: CSSProperties = {
    flex: flex ?? undefined,
    minHeight,
    maxHeight,
  };

  return (
    <div
      className={`qb-tokyo-editor${flat ? " qb-tokyo-editor--flat" : ""}${className ? ` ${className}` : ""}`}
      style={rootStyle}
    >
      {showChrome ? (
        <div className="qb-tokyo-editor__chrome">
          <div className="qb-tokyo-editor__traffic" aria-hidden>
            <span className="qb-tokyo-editor__dot qb-tokyo-editor__dot--close" />
            <span className="qb-tokyo-editor__dot qb-tokyo-editor__dot--min" />
            <span className="qb-tokyo-editor__dot qb-tokyo-editor__dot--max" />
          </div>
          <div className="qb-tokyo-editor__title" title={filename}>
            {filename ?? "untitled"}
          </div>
          <span className="qb-tokyo-editor__lang">{LANG_LABEL[language]}</span>
        </div>
      ) : null}

      <div className="qb-tokyo-editor__body">
        <div ref={gutterRef} className="qb-tokyo-editor__gutter" aria-hidden>
          {gutterLines.map((n) => (
            <div
              key={n}
              className={`qb-tokyo-editor__gutter-line${n === cursor.line ? " qb-tokyo-editor__gutter-line--active" : ""}`}
            >
              {n}
            </div>
          ))}
        </div>
        <div
          ref={scrollRef}
          className="qb-tokyo-editor__scroll"
          onScroll={onScroll}
          onMouseDown={(e) => {
            if (readOnly) return;
            const t = e.target as HTMLElement;
            if (!t.closest("textarea")) focusTextarea();
          }}
        >
          <div className="qb-tokyo-editor__stack" style={{ minHeight: contentHeight }}>
            <pre
              className="qb-tokyo-editor__highlight"
              style={{ height: contentHeight }}
              aria-hidden
            >
              {highlighted}
            </pre>
            <textarea
              ref={textareaRef}
              className="qb-tokyo-editor__textarea"
              style={{ height: contentHeight }}
              value={value}
              readOnly={readOnly}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(e) => {
                onChange?.(e.target.value);
                syncCursor();
              }}
              onKeyUp={syncCursor}
              onClick={syncCursor}
              onSelect={syncCursor}
              {...textareaProps}
            />
          </div>
        </div>
      </div>

      {showStatus ? (
        <div className="qb-tokyo-editor__status">
          <span>
            Ln <strong>{cursor.line}</strong>, Col <strong>{cursor.col}</strong>
          </span>
          <span>{lineCount} lines</span>
          <span>UTF-8</span>
          <span>{LANG_LABEL[language]}</span>
        </div>
      ) : null}
    </div>
  );
};

export const TokyoCodeView: FC<{
  code: string;
  language?: TokyoCodeLanguage | string;
  filename?: string;
  minHeight?: number | string;
  maxHeight?: number | string;
  flex?: number | string;
  className?: string;
}> = ({ code, language, filename, minHeight = 80, maxHeight, flex, className }) => {
  const lang =
    typeof language === "string" && language in LANG_LABEL
      ? (language as TokyoCodeLanguage)
      : inferTokyoLanguage(typeof language === "string" ? language : undefined);

  return (
    <TokyoCodeEditor
      value={code}
      language={lang}
      filename={filename}
      readOnly
      showChrome
      showStatus={false}
      flat={false}
      minHeight={minHeight}
      maxHeight={maxHeight}
      flex={flex}
      className={className}
    />
  );
};
