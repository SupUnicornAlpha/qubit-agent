/**
 * SvgLineChart — 轻量纯 SVG 多线图，量化工坊各 Tab 共用。
 *
 * - 不依赖任何图表库（recharts 已在依赖中但更重，这里覆盖 minimal 场景）
 * - 多条 series 自动归一化到同一 y 轴
 * - 支持基准线（baselineY 值，例如 capital / 0）
 * - hover 高亮：传入 onHoverIndex 回调（可选）
 */

import type { CSSProperties, FC } from "react";
import { useMemo } from "react";

export interface ChartSeries {
  name: string;
  color: string;
  points: { x: number | string; y: number | null }[];
  dashed?: boolean;
}

export interface SvgLineChartProps {
  series: ChartSeries[];
  /** 显示的标题 */
  title?: string;
  /** 高度，默认 220 */
  height?: number;
  /** baselineY 值（绘制虚线），例如初始 capital 或 IC=0 */
  baseline?: number;
  /** y 轴刻度个数（默认 4） */
  yTicks?: number;
  /** y 轴标签格式 */
  yFormatter?: (v: number) => string;
  /** x 轴显示首尾标签（true，默认 true） */
  showXEndpoints?: boolean;
  /** 是否显示 legend，默认 true */
  showLegend?: boolean;
}

const VIEW_W = 720;

export const SvgLineChart: FC<SvgLineChartProps> = ({
  series,
  title,
  height = 220,
  baseline,
  yTicks = 4,
  yFormatter = (v) => v.toFixed(2),
  showXEndpoints = true,
  showLegend = true,
}) => {
  const { paths, baselineY, yLabels, xFirst, xLast, allEmpty } = useMemo(() => {
    const padL = 48;
    const padR = 12;
    const padT = 14;
    const padB = 22;
    const innerW = VIEW_W - padL - padR;
    const innerH = height - padT - padB;

    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    let maxLen = 0;
    for (const s of series) {
      maxLen = Math.max(maxLen, s.points.length);
      for (const p of s.points) {
        if (p.y === null || !Number.isFinite(p.y)) continue;
        if (p.y < minV) minV = p.y;
        if (p.y > maxV) maxV = p.y;
      }
    }
    if (typeof baseline === "number") {
      minV = Math.min(minV, baseline);
      maxV = Math.max(maxV, baseline);
    }

    if (maxLen === 0 || !Number.isFinite(minV)) {
      return { paths: [], baselineY: undefined as number | undefined, yLabels: [], xFirst: "", xLast: "", allEmpty: true };
    }
    const range = Math.max(1e-9, maxV - minV);

    const toY = (v: number) => padT + (1 - (v - minV) / range) * innerH;
    const toX = (i: number, len: number) =>
      padL + (len <= 1 ? innerW / 2 : (i / (len - 1)) * innerW);

    const paths = series.map((s) => {
      const segs: string[] = [];
      let pen = false;
      for (let i = 0; i < s.points.length; i++) {
        const p = s.points[i]!;
        if (p.y === null || !Number.isFinite(p.y)) {
          pen = false;
          continue;
        }
        const x = toX(i, s.points.length);
        const y = toY(p.y);
        segs.push(`${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`);
        pen = true;
      }
      return { name: s.name, color: s.color, dashed: s.dashed, d: segs.join(" ") };
    });

    const baselineYNum =
      typeof baseline === "number" ? toY(baseline) : undefined;

    const yLabels: { y: number; label: string }[] = [];
    for (let i = 0; i <= yTicks; i++) {
      const v = minV + (i / yTicks) * range;
      yLabels.push({ y: toY(v), label: yFormatter(v) });
    }

    const firstS = series.find((s) => s.points.length > 0);
    const xFirst =
      firstS && firstS.points.length > 0
        ? String(firstS.points[0]!.x)
        : "";
    const xLast =
      firstS && firstS.points.length > 0
        ? String(firstS.points[firstS.points.length - 1]!.x)
        : "";

    return { paths, baselineY: baselineYNum, yLabels, xFirst, xLast, allEmpty: false };
  }, [series, baseline, height, yTicks, yFormatter]);

  return (
    <div style={styles.wrap}>
      {title ? <div style={styles.title}>{title}</div> : null}
      {allEmpty ? (
        <div style={styles.empty}>暂无数据</div>
      ) : (
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${VIEW_W} ${height}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
        >
          {yLabels.map((l, i) => (
            <g key={`y_${i}`}>
              <line
                x1={48}
                y1={l.y}
                x2={VIEW_W - 12}
                y2={l.y}
                stroke="var(--qb-border-subtle)"
                strokeOpacity={0.5}
                strokeDasharray={i === 0 || i === yLabels.length - 1 ? "" : "3 3"}
              />
              <text
                x={44}
                y={l.y + 3}
                fontSize="9"
                fill="var(--qb-text-muted)"
                textAnchor="end"
              >
                {l.label}
              </text>
            </g>
          ))}
          {typeof baselineY === "number" ? (
            <line
              x1={48}
              y1={baselineY}
              x2={VIEW_W - 12}
              y2={baselineY}
              stroke="var(--qb-border-subtle)"
              strokeWidth={1.25}
              strokeDasharray="4 4"
            />
          ) : null}
          {paths.map((p, idx) => (
            <path
              key={`p_${idx}`}
              d={p.d}
              fill="none"
              stroke={p.color}
              strokeWidth={1.4}
              strokeDasharray={p.dashed ? "4 4" : ""}
            />
          ))}
          {showXEndpoints ? (
            <>
              <text x={48} y={height - 4} fontSize="9" fill="var(--qb-text-muted)">
                {xFirst}
              </text>
              <text
                x={VIEW_W - 12}
                y={height - 4}
                fontSize="9"
                fill="var(--qb-text-muted)"
                textAnchor="end"
              >
                {xLast}
              </text>
            </>
          ) : null}
        </svg>
      )}
      {showLegend && series.length > 0 ? (
        <div style={styles.legend}>
          {series.map((s, i) => (
            <span key={`lg_${i}`} style={styles.legendItem}>
              <span
                style={{
                  ...styles.swatch,
                  background: s.color,
                  border: s.dashed ? `1px dashed ${s.color}` : "none",
                }}
              />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  wrap: {
    border: "1px solid var(--qb-border-subtle)",
    borderRadius: 6,
    padding: "8px 12px",
  },
  title: { fontSize: 11, color: "var(--qb-text-muted)", marginBottom: 4 },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 4,
    fontSize: 10,
    color: "var(--qb-text-muted)",
  },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 4 },
  swatch: { width: 10, height: 3, borderRadius: 1, display: "inline-block" },
  empty: {
    padding: "20px 0",
    textAlign: "center",
    color: "var(--qb-text-muted)",
    fontSize: 12,
  },
};

const palette = [
  "#3b82f6",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#a855f7",
  "#06b6d4",
  "#f97316",
  "#ec4899",
];
export function pickColor(index: number): string {
  return palette[index % palette.length]!;
}
