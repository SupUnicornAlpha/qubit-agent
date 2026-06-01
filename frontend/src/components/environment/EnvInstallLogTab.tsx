/**
 * EnvInstallLogTab —— Tab 3「安装历史」。
 *
 * 默认展示最近 50 条；过滤 kind / packageName。短轮询：仅在
 * 当前列表内还有 status='running' 的行时，每 3s 自动 refresh，
 * 一旦没有 running，停止轮询，避免无谓 traffic。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type EnvInstallLogEntry,
  type EnvKind,
  listEnvInstallLog,
} from "../../api/backend";
import {
  baseTable,
  card,
  code,
  row,
  STATUS_COLOR,
  tableHeaderRow,
  tableTd,
  tableTh,
  tableTrBordered,
} from "./styles";

const POLL_INTERVAL_MS = 3_000;

export function EnvInstallLogTab() {
  const [logs, setLogs] = useState<EnvInstallLogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<EnvKind | "">("");
  const [pkgFilter, setPkgFilter] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await listEnvInstallLog({
        kind: kindFilter || undefined,
        packageName: pkgFilter.trim() || undefined,
        limit: 200,
      });
      setLogs(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [kindFilter, pkgFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 仅在仍有 running 行时持续轮询
  useEffect(() => {
    const hasRunning = logs.some((l) => l.status === "running");
    if (!hasRunning) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    timerRef.current = setTimeout(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [logs, refresh]);

  const stats = useMemo(() => {
    const r = { running: 0, success: 0, failed: 0, timeout: 0 };
    for (const l of logs) {
      r[l.status] = (r[l.status] ?? 0) + 1;
    }
    return r;
  }, [logs]);

  return (
    <div>
      <div style={card}>
        <div style={{ ...row, marginBottom: 0 }}>
          <strong style={{ fontSize: 13 }}>安装历史</strong>
          <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
            running {stats.running} · success {stats.success} · failed {stats.failed} ·
            timeout {stats.timeout}
          </span>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as EnvKind | "")}
          >
            <option value="">全部 kind</option>
            <option value="python">python</option>
            <option value="npm">npm</option>
          </select>
          <input
            placeholder="按包名过滤"
            value={pkgFilter}
            onChange={(e) => setPkgFilter(e.target.value)}
            style={{ width: 160 }}
          />
          <button
            type="button"
            className="qb-btn-ghost qb-btn--compact"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "刷新中…" : "刷新"}
          </button>
        </div>
        {err ? (
          <p style={{ color: STATUS_COLOR.red, fontSize: 12, margin: "8px 0 0 0" }}>
            请求失败：{err}
          </p>
        ) : null}
      </div>

      {logs.length === 0 ? (
        <div style={card}>
          <p style={{ margin: 0, fontSize: 12, color: "var(--qb-main-meta)" }}>
            暂无任何安装/卸载记录。
          </p>
        </div>
      ) : (
        <div style={card}>
          <table style={baseTable}>
            <thead>
              <tr style={tableHeaderRow}>
                <th style={tableTh}>时间</th>
                <th style={tableTh}>kind</th>
                <th style={tableTh}>操作</th>
                <th style={tableTh}>包</th>
                <th style={tableTh}>请求版本</th>
                <th style={tableTh}>已装版本</th>
                <th style={tableTh}>状态</th>
                <th style={tableTh}>触发方</th>
                <th style={tableTh}>错误信息</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => {
                const sev: keyof typeof STATUS_COLOR =
                  l.status === "success"
                    ? "green"
                    : l.status === "running"
                      ? "yellow"
                      : "red";
                return (
                  <tr key={l.id} style={tableTrBordered}>
                    <td style={{ ...tableTd, color: "var(--qb-main-meta)" }}>
                      {new Date(l.startedAt).toLocaleString()}
                      {l.finishedAt ? (
                        <div style={{ fontSize: 10 }}>
                          ⇣ {Math.max(0, Date.parse(l.finishedAt) - Date.parse(l.startedAt))}ms
                        </div>
                      ) : null}
                    </td>
                    <td style={tableTd}>{l.kind}</td>
                    <td style={tableTd}>{l.operation}</td>
                    <td style={{ ...tableTd, fontFamily: "ui-monospace, monospace" }}>
                      {l.packageName}
                    </td>
                    <td style={tableTd}>
                      {l.requestedVersion ? (
                        <span style={code}>{l.requestedVersion}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tableTd}>
                      {l.installedVersion ? (
                        <span style={code}>{l.installedVersion}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={tableTd}>
                      <span
                        style={{
                          color: STATUS_COLOR[sev],
                          fontWeight: 600,
                          fontSize: 11,
                        }}
                      >
                        {l.status}
                      </span>
                    </td>
                    <td style={{ ...tableTd, color: "var(--qb-main-meta)", fontSize: 11 }}>
                      {l.triggeredBy}
                    </td>
                    <td
                      style={{
                        ...tableTd,
                        color: STATUS_COLOR.red,
                        fontSize: 11,
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={l.errorMessage ?? undefined}
                    >
                      {l.errorMessage ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
