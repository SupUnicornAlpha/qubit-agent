/**
 * EnvDepsTab —— 依赖状态 + 一键 install / uninstall。
 *
 * 数据模型来自 GET /api/v1/environment/status 的 python / npm 两个 diff
 * 子树。每行显示：[包, 期望版本, 已装版本, 状态 dot, 操作按钮]。
 *
 * 操作按钮的本地状态：busy / installed / failed —— 这些是 *本会话*
 * 的乐观更新，长期 SoT 仍然是后端 env_install_log（Tab3 显示）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EnvironmentStatus,
  type EnvKind,
  type ExpectedPackage,
  type InstalledPackage,
  type PackageDiff,
  getEnvironmentStatus,
  installEnvPackage,
  uninstallEnvPackage,
} from "../../api/backend";
import {
  baseTable,
  card,
  code,
  row,
  STATUS_COLOR,
  statusDot,
  tableHeaderRow,
  tableTd,
  tableTh,
  tableTrBordered,
} from "./styles";

type RowState = "idle" | "busy" | "ok" | "fail";

type DepRow = {
  key: string;
  expected?: ExpectedPackage;
  installed?: InstalledPackage;
  /** "satisfied" | "missing" | "mismatch" | "orphan" */
  bucket: "satisfied" | "missing" | "mismatch" | "orphan";
};

function bucketize(diff: PackageDiff): DepRow[] {
  const rows: DepRow[] = [];
  for (const e of diff.satisfied) {
    rows.push({
      key: `${e.kind}:${e.name}`,
      expected: e,
      installed: diff.installed.find((i) => i.name.toLowerCase() === e.name.toLowerCase()),
      bucket: "satisfied",
    });
  }
  for (const m of diff.versionMismatch) {
    rows.push({
      key: `${m.expected.kind}:${m.expected.name}`,
      expected: m.expected,
      installed: m.installed,
      bucket: "mismatch",
    });
  }
  for (const e of diff.missing) {
    rows.push({ key: `${e.kind}:${e.name}`, expected: e, bucket: "missing" });
  }
  for (const o of diff.orphan) {
    rows.push({ key: `orphan:${o.name}`, installed: o, bucket: "orphan" });
  }
  return rows;
}

function severityForRow(r: DepRow): keyof typeof STATUS_COLOR {
  if (r.bucket === "satisfied") return "green";
  if (r.bucket === "mismatch") return "yellow";
  if (r.bucket === "orphan") return "gray";
  // missing
  return r.expected?.optional ? "yellow" : "red";
}

interface KindSectionProps {
  kind: EnvKind;
  diff: PackageDiff;
  rowStates: Record<string, RowState>;
  rowMessages: Record<string, string>;
  onAction: (
    kind: EnvKind,
    op: "install" | "uninstall",
    pkg: { name: string; versionSpec?: string | null }
  ) => Promise<void>;
}

function KindSection({ kind, diff, rowStates, rowMessages, onAction }: KindSectionProps) {
  const allRows = useMemo(() => bucketize(diff), [diff]);
  const primaryRows = useMemo(() => allRows.filter((r) => r.bucket !== "orphan"), [allRows]);
  const orphanRows = useMemo(() => allRows.filter((r) => r.bucket === "orphan"), [allRows]);

  const renderRow = (r: DepRow) => {
    const sev = severityForRow(r);
    const name = r.expected?.name ?? r.installed?.name ?? "?";
    const display = r.expected?.displayName ?? name;
    const optional = r.expected?.optional ?? true;
    const busy = rowStates[r.key] === "busy";
    const failMsg = rowStates[r.key] === "fail" ? rowMessages[r.key] : undefined;

    return (
      <tr key={r.key} style={tableTrBordered}>
        <td style={{ ...tableTd, fontFamily: "ui-monospace, monospace" }}>
          <div style={{ fontWeight: 600 }}>{display}</div>
          <div style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>{name}</div>
        </td>
        <td style={{ ...tableTd, color: "var(--qb-main-meta)" }}>
          <span style={code}>{r.expected?.capability ?? "—"}</span>
        </td>
        <td style={tableTd}>
          {r.expected?.effectiveVersionSpec ? (
            <span style={code}>{r.expected.effectiveVersionSpec}</span>
          ) : (
            <span style={{ color: "var(--qb-main-meta)" }}>—</span>
          )}
        </td>
        <td style={tableTd}>
          {r.installed ? (
            <span style={code}>{r.installed.version}</span>
          ) : (
            <span style={{ color: STATUS_COLOR.red }}>未装</span>
          )}
        </td>
        <td style={tableTd}>
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <span style={statusDot(sev)} />
            {labelForBucket(r.bucket, optional)}
          </span>
          {failMsg ? (
            <div style={{ color: STATUS_COLOR.red, fontSize: 11, marginTop: 2 }}>{failMsg}</div>
          ) : null}
        </td>
        <td style={{ ...tableTd, whiteSpace: "nowrap" }}>
          <RowActions
            row={r}
            busy={busy}
            onAction={(op, pkg) => void onAction(kind, op, pkg)}
          />
        </td>
      </tr>
    );
  };

  const tableHead = (
    <thead>
      <tr style={tableHeaderRow}>
        <th style={tableTh}>包</th>
        <th style={tableTh}>能力</th>
        <th style={tableTh}>期望</th>
        <th style={tableTh}>已装</th>
        <th style={tableTh}>状态</th>
        <th style={tableTh}>操作</th>
      </tr>
    </thead>
  );

  return (
    <div style={card}>
      <div style={{ ...row, marginBottom: 10, justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>
          {kind === "python" ? "Python (pip)" : "MCP npm (mcp-bin)"}
        </strong>
        <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
          满足 {diff.satisfied.length} · 缺失 {diff.missing.length} · 不匹配{" "}
          {diff.versionMismatch.length} · 孤儿 {diff.orphan.length}
        </span>
      </div>

      {primaryRows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12, color: "var(--qb-main-meta)" }}>
          无任何 {kind} 期望项；可在「期望清单」tab 添加。
        </p>
      ) : (
        <table style={baseTable}>
          {tableHead}
          <tbody>{primaryRows.map(renderRow)}</tbody>
        </table>
      )}

      {orphanRows.length > 0 ? (
        <details style={{ marginTop: 12 }}>
          <summary
            style={{
              cursor: "pointer",
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--qb-main-meta)",
              userSelect: "none",
              borderTop: "1px dashed var(--qb-border, rgba(0,0,0,0.12))",
            }}
          >
            孤儿包（已装但不在期望清单内）· {orphanRows.length}
            <span style={{ marginLeft: 8, fontSize: 11 }}>
              通常是依赖的依赖（传递依赖），无需手动处理；点击展开查看 / 卸载
            </span>
          </summary>
          <table style={{ ...baseTable, marginTop: 8 }}>
            {tableHead}
            <tbody>{orphanRows.map(renderRow)}</tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function labelForBucket(b: DepRow["bucket"], optional: boolean): string {
  switch (b) {
    case "satisfied":
      return "满足";
    case "mismatch":
      return "版本不匹配";
    case "missing":
      return optional ? "可选未装" : "必需未装";
    case "orphan":
      return "孤儿包";
  }
}

function RowActions({
  row,
  busy,
  onAction,
}: {
  /** kind 隐式来自 row.expected.kind / row.installed 上下文，这里不需要显式传 */
  row: DepRow;
  busy: boolean;
  onAction: (op: "install" | "uninstall", pkg: { name: string; versionSpec?: string | null }) => void;
}) {
  if (row.bucket === "orphan") {
    return (
      <button
        type="button"
        className="qb-btn-ghost qb-btn--compact"
        disabled={busy}
        onClick={() => onAction("uninstall", { name: row.installed!.name })}
      >
        {busy ? "卸载中…" : "卸载"}
      </button>
    );
  }
  const exp = row.expected!;
  if (row.bucket === "satisfied") {
    return (
      <button
        type="button"
        className="qb-btn-ghost qb-btn--compact"
        disabled={busy}
        onClick={() => onAction("uninstall", { name: exp.name })}
      >
        {busy ? "卸载中…" : "卸载"}
      </button>
    );
  }
  // missing or mismatch
  return (
    <button
      type="button"
      className="qb-btn-ghost qb-btn--compact"
      disabled={busy}
      onClick={() => onAction("install", { name: exp.name, versionSpec: exp.effectiveVersionSpec })}
    >
      {busy ? "安装中…" : row.bucket === "mismatch" ? "升级 / 重装" : "安装"}
    </button>
  );
}

export function EnvDepsTab() {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await getEnvironmentStatus());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAction = useCallback(
    async (
      kind: EnvKind,
      op: "install" | "uninstall",
      pkg: { name: string; versionSpec?: string | null }
    ) => {
      const key = `${kind}:${pkg.name}`;
      setRowStates((s) => ({ ...s, [key]: "busy" }));
      setRowMessages((s) => {
        const next = { ...s };
        delete next[key];
        return next;
      });
      try {
        if (op === "install") {
          await installEnvPackage(kind, pkg.name, pkg.versionSpec ?? undefined);
        } else {
          await uninstallEnvPackage(kind, pkg.name);
        }
        // 后端是异步任务；此时 logId 已写入。短轮询 status 直到行状态变化。
        await pollUntilSettled(kind, pkg.name, 60_000);
        await refresh();
        setRowStates((s) => ({ ...s, [key]: "ok" }));
      } catch (e) {
        setRowStates((s) => ({ ...s, [key]: "fail" }));
        setRowMessages((s) => ({ ...s, [key]: (e as Error).message }));
      }
    },
    [refresh]
  );

  const ok = status?.ok ?? "warn";
  const sev: keyof typeof STATUS_COLOR =
    ok === "ok" ? "green" : ok === "warn" ? "yellow" : "red";

  return (
    <div>
      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ ...row, marginBottom: 0 }}>
          <span style={statusDot(sev)} />
          <strong style={{ fontSize: 13 }}>{status?.summary ?? "加载中…"}</strong>
          {status ? (
            <span style={{ color: "var(--qb-main-meta)", fontSize: 11 }}>
              · 解释器 <span style={code}>{status.pythonBin}</span> · 检测于{" "}
              {new Date(status.generatedAt).toLocaleString()}
            </span>
          ) : null}
          <button
            type="button"
            className="qb-btn-ghost qb-btn--compact"
            onClick={() => void refresh()}
            disabled={busy}
            style={{ marginLeft: "auto" }}
          >
            {busy ? "检测中…" : "重新检测"}
          </button>
        </div>
        {err ? (
          <p style={{ color: STATUS_COLOR.red, fontSize: 12, margin: "8px 0 0 0" }}>
            请求失败：{err}
          </p>
        ) : null}
      </div>

      {status ? (
        <>
          <KindSection
            kind="python"
            diff={status.python}
            rowStates={rowStates}
            rowMessages={rowMessages}
            onAction={onAction}
          />
          <KindSection
            kind="npm"
            diff={status.npm}
            rowStates={rowStates}
            rowMessages={rowMessages}
            onAction={onAction}
          />
          <ConnectorProbeCard probes={status.connectors} />
        </>
      ) : null}
    </div>
  );
}

function ConnectorProbeCard({ probes }: { probes: EnvironmentStatus["connectors"] }) {
  if (probes.length === 0) return null;
  return (
    <div style={card}>
      <strong style={{ fontSize: 13 }}>Connector 健康自检</strong>
      <table style={{ ...baseTable, marginTop: 8 }}>
        <thead>
          <tr style={tableHeaderRow}>
            <th style={tableTh}>名称</th>
            <th style={tableTh}>类型</th>
            <th style={tableTh}>状态</th>
            <th style={tableTh}>延迟</th>
            <th style={tableTh}>消息</th>
          </tr>
        </thead>
        <tbody>
          {probes.map((p) => {
            const sev: keyof typeof STATUS_COLOR =
              p.status === "healthy"
                ? "green"
                : p.status === "degraded"
                  ? "yellow"
                  : "red";
            return (
              <tr key={p.name} style={tableTrBordered}>
                <td style={{ ...tableTd, fontFamily: "ui-monospace, monospace" }}>{p.name}</td>
                <td style={{ ...tableTd, color: "var(--qb-main-meta)" }}>{p.type}</td>
                <td style={tableTd}>
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <span style={statusDot(sev)} />
                    {p.status}
                  </span>
                </td>
                <td style={{ ...tableTd, color: "var(--qb-main-meta)" }}>
                  {p.latencyMs != null ? `${p.latencyMs}ms` : "—"}
                </td>
                <td style={{ ...tableTd, color: "var(--qb-main-meta)" }}>{p.message || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 短轮询 install-log：每 1.5s 拉一次该包最近一条记录，直到 status 不再
 * running 或超时。中途任何 error 都直接抛给调用方。
 */
async function pollUntilSettled(
  kind: EnvKind,
  packageName: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const { listEnvInstallLog } = await import("../../api/backend");
    const logs = await listEnvInstallLog({ kind, packageName, limit: 1 });
    const latest = logs[0];
    if (latest && latest.status !== "running") {
      if (latest.status === "success") return;
      throw new Error(latest.errorMessage ?? `install ${latest.status}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("install timed out (front-end poll); check 安装历史 tab");
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
}
