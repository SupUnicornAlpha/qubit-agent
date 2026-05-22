/**
 * Python 沙箱/算子运行时健康卡片
 *
 * 三态：
 *   ✓ ok                    —— 必需 + 可选依赖都装齐
 *   ⚠ ok 但缺可选依赖       —— 必需齐、scipy 等可选缺失，沙箱可用但部分能力受限
 *   ✗ 必需依赖或解释器缺失  —— 沙箱直接 fail-fast，code.run_python 会立刻返回错误
 *
 * UI 设计目标：
 *   - 一眼看出当前 Python 解释器路径和来源（venv / 系统 / 显式 QUBIT_PYTHON）
 *   - 每个依赖独立一行，显示版本号或具体错误
 *   - 一键复制官方修复命令（bun src/cli.ts bootstrap）
 */
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  type SystemPythonHealthReport,
  getSystemPythonHealth,
} from "../../api/backend";

const STATUS_COLOR = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
} as const;

function deriveSeverity(report: SystemPythonHealthReport | null): keyof typeof STATUS_COLOR {
  if (!report) return "yellow";
  if (!report.ok) return "red";
  const optionalMissing = report.dependencies.some((d) => !d.available && !d.required);
  return optionalMissing ? "yellow" : "green";
}

function binKindLabel(kind: SystemPythonHealthReport["binKind"]): string {
  if (kind === "venv") return "venv（项目数据目录）";
  if (kind === "explicit") return "QUBIT_PYTHON（显式指定）";
  return "系统 python3";
}

const card: CSSProperties = {
  border: "1px solid var(--qb-main-input-border, #3f3f46)",
  borderRadius: 8,
  padding: 12,
  background: "var(--qb-main-input-bg, #18181b)",
  marginBottom: 14,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 6,
  fontSize: 12,
};

const code: CSSProperties = {
  fontFamily: "ui-monospace, monospace",
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 4,
  background: "rgba(255,255,255,0.04)",
};

export const PythonRuntimeCard: FC = () => {
  const [report, setReport] = useState<SystemPythonHealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async (force: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await getSystemPythonHealth(force);
      setReport(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const severity = deriveSeverity(report);
  const dot = (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        backgroundColor: STATUS_COLOR[severity],
      }}
    />
  );

  return (
    <div style={card}>
      <div style={{ ...row, marginBottom: 10 }}>
        {dot}
        <strong style={{ fontSize: 13 }}>Python 沙箱运行时</strong>
        <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
          {report?.checkedAt ? `检测于 ${new Date(report.checkedAt).toLocaleString()}` : "未检测"}
        </span>
        <button
          type="button"
          className="qb-btn-ghost qb-btn--compact"
          onClick={() => void refresh(true)}
          disabled={busy}
          style={{ marginLeft: "auto" }}
        >
          {busy ? "检测中…" : "重新检测"}
        </button>
      </div>

      {err ? (
        <p style={{ margin: 0, fontSize: 12, color: STATUS_COLOR.red }}>请求失败：{err}</p>
      ) : !report ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--qb-main-meta)" }}>加载中…</p>
      ) : (
        <>
          <div style={row}>
            <span style={{ color: "var(--qb-main-meta)" }}>解释器</span>
            <span style={code}>{report.binPath}</span>
            <span style={{ color: "var(--qb-main-meta)" }}>
              · {binKindLabel(report.binKind)}
              {report.pythonVersion ? ` · Python ${report.pythonVersion}` : ""}
            </span>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--qb-main-meta)" }}>
                <th style={{ padding: "4px 6px" }}>依赖</th>
                <th style={{ padding: "4px 6px" }}>类型</th>
                <th style={{ padding: "4px 6px" }}>状态</th>
                <th style={{ padding: "4px 6px" }}>详情</th>
              </tr>
            </thead>
            <tbody>
              {report.dependencies.map((d) => (
                <tr key={d.name} style={{ borderTop: "1px solid #27272a" }}>
                  <td style={{ padding: "4px 6px", fontFamily: "ui-monospace, monospace" }}>
                    {d.name}
                  </td>
                  <td style={{ padding: "4px 6px", color: "var(--qb-main-meta)" }}>
                    {d.required ? "必需" : "可选"}
                  </td>
                  <td
                    style={{
                      padding: "4px 6px",
                      color: d.available
                        ? STATUS_COLOR.green
                        : d.required
                          ? STATUS_COLOR.red
                          : STATUS_COLOR.yellow,
                    }}
                  >
                    {d.available ? "已安装" : "未安装"}
                  </td>
                  <td style={{ padding: "4px 6px", color: "var(--qb-main-meta)" }}>
                    {d.available ? (d.version ?? "—") : (d.error ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.hint ? (
            <div
              style={{
                marginTop: 10,
                padding: 8,
                borderRadius: 6,
                background:
                  severity === "red"
                    ? "rgba(239,68,68,0.08)"
                    : severity === "yellow"
                      ? "rgba(234,179,8,0.08)"
                      : "rgba(34,197,94,0.08)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {report.hint}
              {!report.ok ? (
                <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="qb-btn-ghost qb-btn--compact"
                    onClick={() => void navigator.clipboard.writeText("bun src/cli.ts bootstrap")}
                  >
                    复制：bun src/cli.ts bootstrap
                  </button>
                  <button
                    type="button"
                    className="qb-btn-ghost qb-btn--compact"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        `${report.binPath.replace(/\/python3?$/, "/pip")} install -r python_connectors/requirements.txt`
                      )
                    }
                  >
                    复制：pip install -r requirements.txt
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
