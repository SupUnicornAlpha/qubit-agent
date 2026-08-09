/**
 * Team 中栏 — Strategy API V2（# @param Python + Manifest）编辑 / 编译 / 契约回测。
 * 按 sessionId + workflowRunId 隔离；父组件应在切换时用 key 强制 remount。
 */
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  backtestStrategyContractApi,
  compileStrategyContract,
  createStrategyScript,
  listStrategyScripts,
  updateStrategyScript,
} from "../../api/backend";
import type { IndicatorStrategyScriptRecord } from "../../api/types";
import { preferStrategyApiCode } from "../../lib/strategyApiCode";

const STARTER = `# @param period int 20 MA period range=5:100:5
# @param target_pct float 0.95 Target weight range=0.1:1.0:0.05

def initialize(context):
    g.symbol = "US:SPY"
    context.set_universe([g.symbol])
    context.subscribe(frequency="1d", fields=["open", "high", "low", "close", "volume"])
    context.set_warmup(60)
    context.set_benchmark("US:SPY")
    context.set_metadata(name="team_strategy_api")

def handle_data(context, data):
    period = int(context.params["period"])
    bars = get_history(period + 1, "1d", "close", g.symbol)
    if len(bars) < period:
        return
    price = float(bars["close"].iloc[-1])
    ma = float(bars["close"].tail(period).mean())
    pos = get_position(g.symbol)
    desired = float(context.params["target_pct"]) if price > ma else 0.0
    if desired > 0 and pos.amount <= 0:
        order_target_percent(g.symbol, desired, reason="ma_entry")
    elif desired == 0 and pos.amount > 0:
        order_target_percent(g.symbol, 0.0, reason="ma_exit")
`;

export type TeamStrategyContractPaneProps = {
  sessionId: string;
  workflowRunId: string;
};

const shell: CSSProperties = {
  flex: 1,
  minHeight: 420,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 10,
  border: "1px solid var(--qb-team-live-feed-border, #2a2a30)",
  borderRadius: 8,
  overflow: "hidden",
  background: "var(--qb-team-live-feed-bg, #08080a)",
};

const btn: CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #3f3f46",
  background: "#18181b",
  color: "#e4e4e7",
  cursor: "pointer",
};

function applyRow(
  row: IndicatorStrategyScriptRecord | null,
  setters: {
    setSelectedId: (id: string | null) => void;
    setName: (n: string) => void;
    setCode: (c: string) => void;
  }
) {
  if (!row) {
    setters.setSelectedId(null);
    setters.setName("team_strategy_api");
    setters.setCode(STARTER);
    return;
  }
  setters.setSelectedId(row.id);
  setters.setName(row.name);
  setters.setCode(preferStrategyApiCode(row) || STARTER);
}

export const TeamStrategyContractPane: FC<TeamStrategyContractPaneProps> = ({
  sessionId,
  workflowRunId,
}) => {
  const [scripts, setScripts] = useState<IndicatorStrategyScriptRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("team_strategy_api");
  const [code, setCode] = useState(STARTER);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [manifestSummary, setManifestSummary] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const loadGenRef = useRef(0);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const reload = useCallback(
    async (preferSelectId?: string | null) => {
      if (!sessionId || !workflowRunId) {
        setScripts([]);
        applyRow(null, { setSelectedId, setName, setCode });
        return;
      }
      const gen = ++loadGenRef.current;
      setLoading(true);
      setError(null);
      try {
        const rows = await listStrategyScripts(sessionId, { workflowRunId });
        if (gen !== loadGenRef.current) return;
        setScripts(rows);
        const want =
          preferSelectId !== undefined ? preferSelectId : selectedIdRef.current;
        const pick = want ? rows.find((r) => r.id === want) : undefined;
        if (pick) {
          applyRow(pick, { setSelectedId, setName, setCode });
        } else if (rows[0]) {
          applyRow(rows[0], { setSelectedId, setName, setCode });
        } else {
          // 该 workflow 无脚本：清空编辑器到空白草稿，勿保留上一个 workflow 的内容
          applyRow(null, { setSelectedId, setName, setCode });
          setManifestSummary(null);
        }
      } catch (e) {
        if (gen !== loadGenRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setScripts([]);
        applyRow(null, { setSelectedId, setName, setCode });
      } finally {
        if (gen === loadGenRef.current) setLoading(false);
      }
    },
    [sessionId, workflowRunId]
  );

  useEffect(() => {
    setManifestSummary(null);
    setInfo(null);
    setError(null);
    setScripts([]);
    applyRow(null, { setSelectedId, setName, setCode });
    void reload(null);
  }, [sessionId, workflowRunId, reload]);

  const selectScript = (row: IndicatorStrategyScriptRecord) => {
    applyRow(row, { setSelectedId, setName, setCode });
    setManifestSummary(null);
    setInfo(null);
    setError(null);
  };

  const onNew = () => {
    setSelectedId(null);
    setName(`strategy_api_${Date.now().toString(36).slice(-4)}`);
    setCode(STARTER);
    setManifestSummary(null);
    setInfo("新建草稿（未保存）");
    setError(null);
  };

  const onSave = async () => {
    if (!sessionId || !workflowRunId) {
      setError("需要会话与工作流");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      if (selectedId) {
        const updated = await updateStrategyScript(selectedId, {
          name: name.trim() || "strategy_api",
          ideCode: code,
          signalCode: code,
          workflowRunId,
        });
        setInfo(`已保存 ${updated.id.slice(0, 8)}…`);
        await reload(updated.id);
      } else {
        const created = await createStrategyScript(sessionId, {
          name: name.trim() || "strategy_api",
          ideCode: code,
          signalCode: code,
          workflowRunId,
          chartSnapshotJson: { strategyApiV2: true },
          purpose: "both",
        });
        setInfo(`已创建 ${created.id.slice(0, 8)}…`);
        await reload(created.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onCompile = async () => {
    setBusy("compile");
    setError(null);
    setInfo(null);
    try {
      const res = await compileStrategyContract(code, {
        sessionId,
        workflowRunId,
        scriptId: selectedId ?? undefined,
        name: name.trim() || undefined,
        persist: true,
      });
      if (!res.ok) {
        setError(res.error);
        setManifestSummary(null);
        return;
      }
      const u = res.manifest.universe.instruments
        .map((i) => i.instrumentId)
        .join(", ");
      setManifestSummary(
        `hash=${res.manifest.codeHash.slice(0, 10)}… · ${res.manifest.strategyType} · ${u || "—"} · params=${res.manifest.paramsSchema.length}`
      );
      setInfo(
        res.persisted
          ? `编译成功并落库${res.created ? "（新建）" : ""}`
          : `编译成功（未落库${res.persistReason ? `: ${res.persistReason}` : ""}）`
      );
      await reload(res.scriptId ?? selectedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onBacktest = async () => {
    setBusy("backtest");
    setError(null);
    try {
      const res = await backtestStrategyContractApi({ code, limit: 180 });
      if (!res.ok || !res.data) {
        setError(res.error ?? "backtest_failed");
        return;
      }
      const m = res.data.metrics;
      setInfo(
        `回测 ${res.data.primarySymbol} · ret ${m.totalReturnPct.toFixed(2)}% · MDD ${m.maxDrawdownPct.toFixed(2)}% · sharpe~${m.sharpeApprox.toFixed(2)} · trades ${m.tradeCount}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!sessionId || !workflowRunId) {
    return (
      <div style={shell}>
        <div style={{ fontSize: 13, color: "#a1a1aa" }}>
          请先选择已绑定会话的工作流，才能编辑 Strategy API 脚本。
        </div>
      </div>
    );
  }

  const wfShort =
    workflowRunId.length > 12
      ? `${workflowRunId.slice(0, 8)}…`
      : workflowRunId;

  return (
    <div style={shell}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 12, color: "#a1a1aa", marginRight: 4 }}>
          Strategy API · wf{" "}
          <code style={{ fontSize: 11, color: "#d4d4d8" }}>{wfShort}</code>
          {loading ? " · …" : ` · ${scripts.length} 脚本`}
        </span>
        <button type="button" style={btn} disabled={!!busy} onClick={() => void onNew()}>
          新建
        </button>
        <button type="button" style={btn} disabled={!!busy} onClick={() => void onSave()}>
          {busy === "save" ? "保存中…" : "保存"}
        </button>
        <button type="button" style={btn} disabled={!!busy} onClick={() => void onCompile()}>
          {busy === "compile" ? "编译中…" : "编译 Manifest"}
        </button>
        <button type="button" style={btn} disabled={!!busy} onClick={() => void onBacktest()}>
          {busy === "backtest" ? "回测中…" : "契约回测"}
        </button>
        <button
          type="button"
          style={btn}
          disabled={!!busy || loading}
          onClick={() => void reload(selectedId)}
        >
          刷新
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <div
          style={{
            width: 160,
            flexShrink: 0,
            overflow: "auto",
            borderRight: "1px solid #27272a",
            paddingRight: 6,
          }}
        >
          {scripts.length === 0 ? (
            <div style={{ fontSize: 11, color: "#71717a" }}>
              本工作流暂无脚本；可新建或等 Agent compile 落库
            </div>
          ) : (
            scripts.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => selectScript(s)}
                style={{
                  ...btn,
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: 6,
                  background: selectedId === s.id ? "#27272a" : "#18181b",
                  borderColor: selectedId === s.id ? "#52525b" : "#3f3f46",
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 11 }}>{s.name}</div>
                <div style={{ fontSize: 10, color: "#71717a" }}>{s.id.slice(0, 8)}…</div>
              </button>
            ))
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="脚本名"
            style={{
              fontSize: 12,
              padding: "6px 8px",
              borderRadius: 6,
              border: "1px solid #3f3f46",
              background: "#09090b",
              color: "#fafafa",
            }}
          />
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 280,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              lineHeight: 1.45,
              padding: 10,
              borderRadius: 6,
              border: "1px solid #3f3f46",
              background: "#09090b",
              color: "#e4e4e7",
              resize: "vertical",
            }}
          />
          {manifestSummary ? (
            <div style={{ fontSize: 11, color: "#a1a1aa" }}>Manifest · {manifestSummary}</div>
          ) : null}
          {info ? <div style={{ fontSize: 11, color: "#86efac" }}>{info}</div> : null}
          {error ? <div style={{ fontSize: 11, color: "#fca5a5" }}>{error}</div> : null}
        </div>
      </div>
    </div>
  );
};
