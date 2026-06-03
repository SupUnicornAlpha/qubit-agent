import type { CSSProperties, FC, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";

/**
 * 自实现的"竖向拖拽"容器。
 *
 * 为什么不用原生 `resize: vertical`：
 *  - Tauri 的 WebKit 在某些 dark theme 下根本不画 handle；
 *  - flex 父级在重新布局时常把 `height` 覆盖掉；
 *  - 无法跨进程持久化用户的偏好高度。
 *
 * 因此用一个 6px 高的 absolute 拖拽条 + window-level mousemove/mouseup 事件，
 * 行为和体验都跟 IDE 面板一致。可选 `storageKey` 持久化到 localStorage。
 */
export type ResizableYProps = {
  defaultHeight: number;
  minHeight?: number;
  maxHeight?: number;
  storageKey?: string;
  style?: CSSProperties;
  className?: string;
  /**
   * Extra `data-*` / aria attributes to spread on the outer wrapper.
   * 用来让主题 CSS 可以通过 `[data-qb-*]` 选择器精确命中这层容器。
   */
  wrapperData?: Record<string, string>;
  children: ReactNode;
};

export const ResizableY: FC<ResizableYProps> = ({
  defaultHeight,
  minHeight = 120,
  maxHeight = 2000,
  storageKey,
  style,
  className,
  wrapperData,
  children,
}) => {
  const { t } = useTranslation();
  const [height, setHeight] = useState<number>(() => {
    if (storageKey && typeof window !== "undefined") {
      const raw = window.localStorage.getItem(storageKey);
      const n = Number(raw);
      if (Number.isFinite(n) && n >= minHeight) return Math.min(n, maxHeight);
    }
    return defaultHeight;
  });

  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { startY: e.clientY, startH: heightRef.current };
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
    },
    []
  );

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      let nh = d.startH + (ev.clientY - d.startY);
      if (nh < minHeight) nh = minHeight;
      if (nh > maxHeight) nh = maxHeight;
      setHeight(nh);
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (storageKey && typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, String(heightRef.current));
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [minHeight, maxHeight, storageKey]);

  return (
    <div
      className={className}
      {...wrapperData}
      style={{
        ...style,
        height,
        flexShrink: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {children}
      <div
        onMouseDown={onMouseDown}
        title={t("team.resizableY.dragTitle")}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 8,
          cursor: "ns-resize",
          zIndex: 5,
          background:
            "linear-gradient(to bottom, transparent 0%, transparent 40%, rgba(120,120,140,0.18) 50%, rgba(120,120,140,0.35) 70%, transparent 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: 1,
            transform: "translateX(-50%)",
            width: 36,
            height: 3,
            borderRadius: 2,
            background: "rgba(161,161,170,0.5)",
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
};
