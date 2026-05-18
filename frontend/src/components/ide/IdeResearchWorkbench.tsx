import type { CSSProperties, FC, ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KlinePanel } from "../chart/KlinePanel";
import { useAppStore } from "../../store";
import { IdeBacktestDock } from "./IdeBacktestDock";
import { IdeLeftColumn } from "./IdeLeftColumn";
import { IdeQuickTradePanel } from "./IdeQuickTradePanel";
import { IdeWorkbenchToolbar } from "./IdeWorkbenchToolbar";

const MIN_IDE_LEFT_PCT = 22;
const MAX_IDE_LEFT_PCT = 68;

export const IdeResearchWorkbench: FC<{ renderChat: () => ReactNode }> = ({ renderChat }) => {
  const idePanels = useAppStore((s) => s.idePanels);
  const ideQuickTradeOpen = useAppStore((s) => s.ideQuickTradeOpen);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(42);
  const drag = useRef<{ startX: number; startPct: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const dx = e.clientX - d.startX;
      const deltaPct = (dx / rect.width) * 100;
      const next = Math.min(MAX_IDE_LEFT_PCT, Math.max(MIN_IDE_LEFT_PCT, d.startPct + deltaPct));
      setLeftPct(next);
    };
    const onUp = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const onGutterDown = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startPct: leftPct };
    e.preventDefault();
  }, [leftPct]);

  const showCenterContent = idePanels.chart || idePanels.backtest;

  return (
    <div data-qb-ide-workbench style={styles.root}>
      <IdeWorkbenchToolbar />
      <div ref={wrapRef} style={styles.mainRow}>
        {idePanels.left ? (
          <>
            <div style={{ ...styles.leftPane, flexBasis: `${leftPct}%` }}>
              <IdeLeftColumn renderChat={renderChat} />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整对话与 K 线宽度"
              onMouseDown={onGutterDown}
              style={styles.gutter}
            />
          </>
        ) : null}
        <div style={styles.rightPane}>
          <div style={styles.centerStack}>
            {showCenterContent ? (
              <>
                {idePanels.chart ? (
                  <div style={styles.chartArea}>
                    <KlinePanel embedded />
                  </div>
                ) : null}
                {idePanels.backtest ? <IdeBacktestDock /> : null}
              </>
            ) : (
              <div style={styles.emptyCenter}>
                已隐藏 K 线 / 回测。在上方工具栏打开「K线」或「回测」即可恢复。
              </div>
            )}
          </div>
          {ideQuickTradeOpen ? (
            <>
              <div style={styles.quickGutter} aria-hidden />
              <IdeQuickTradePanel />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
    background: "var(--qb-bg-root, #09090b)",
  },
  mainRow: {
    display: "flex",
    flexDirection: "row",
    flex: 1,
    minHeight: 0,
    width: "100%",
    overflow: "hidden",
  },
  leftPane: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  gutter: {
    width: 6,
    flexShrink: 0,
    cursor: "col-resize",
    background: "var(--qb-team-gutter-bg, #27272a)",
    alignSelf: "stretch",
  },
  rightPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "row",
    alignItems: "stretch",
  },
  centerStack: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  chartArea: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  emptyCenter: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    color: "var(--qb-main-meta, #71717a)",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 1.5,
  },
  quickGutter: {
    width: 1,
    flexShrink: 0,
    background: "var(--qb-ide-chrome-border, #27272a)",
    alignSelf: "stretch",
  },
};
