import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelTraderOrder,
  ensureTraderSession,
  placeTraderOrder,
  pollTraderFeed,
  runTraderCommand,
  type TraderAgentMessageEvent,
  type TraderDriverEvent,
  type TraderFeedEvent,
  type TraderSessionContext,
} from "../api/backend";
import { useAppStore } from "../store";

const SEEN_KEY = "qubit-trader-feed-seen-v1";

function loadSince(): string {
  try {
    return sessionStorage.getItem(SEEN_KEY) ?? new Date(Date.now() - 60_000).toISOString();
  } catch {
    return new Date(Date.now() - 60_000).toISOString();
  }
}

function persistSince(iso: string) {
  try {
    sessionStorage.setItem(SEEN_KEY, iso);
  } catch {
    /* ignore */
  }
}

function ingestFeedEvent(
  ev: TraderFeedEvent,
  handlers: {
    pushTraderAgentLog: ReturnType<typeof useAppStore.getState>["pushTraderAgentLog"];
    pushTraderMarker: ReturnType<typeof useAppStore.getState>["pushTraderMarker"];
  }
) {
  if (ev.type === "strategy_log") {
    const p = ev.payload;
    const isBuy = ev.message === "buy_signal_executed";

    const barTime = typeof p.barTime === "string" ? p.barTime : undefined;
    const orderIntentId = typeof p.orderIntentId === "string" ? p.orderIntentId : undefined;
    const price = typeof p.price === "number" ? p.price : undefined;
    handlers.pushTraderMarker({
      side: isBuy ? "buy" : "sell",
      text: isBuy ? `策略买入${price != null ? ` @${price}` : ""}` : `策略卖出${price != null ? ` @${price}` : ""}`,
      source: "strategy",
      barTime,
      orderIntentId,
    });
    handlers.pushTraderAgentLog({
      kind: "strategy",
      title: isBuy ? "策略信号 · 买入已提交" : "策略信号 · 卖出已提交",
      body: `runtime=${ev.runtimeId.slice(0, 8)}…\norderIntent=${orderIntentId ?? "—"}\nbarTime=${barTime ?? "—"}`,
    });
    return;
  }

  if (ev.type === "order") {
    const side = ev.side === "sell" ? "sell" : "buy";
    handlers.pushTraderMarker({
      side,
      text: `${side === "buy" ? "买入" : "卖出"} ${ev.qty} · ${ev.status}`,
      source: "agent",
      orderIntentId: ev.orderIntentId,
    });
    handlers.pushTraderAgentLog({
      kind: "decision",
      title: `订单 · ${ev.status}`,
      body: `${ev.side} ${ev.symbol} × ${ev.qty}\nintent=${ev.orderIntentId}`,
    });
  }
}

function ingestDriver(
  ev: TraderDriverEvent,
  pushTraderDriver: ReturnType<typeof useAppStore.getState>["pushTraderDriver"]
) {
  pushTraderDriver({
    id: ev.id,
    ts: Date.parse(ev.ts) || Date.now(),
    driverKind: ev.driverKind,
    title: ev.title,
    body: ev.detail,
  });
}

function ingestAgentMessage(
  ev: TraderAgentMessageEvent,
  pushTraderAgentMessage: ReturnType<typeof useAppStore.getState>["pushTraderAgentMessage"]
) {
  const body = [
    `${ev.senderRole} → ${ev.receiverRole ?? "广播"}`,
    ev.summary,
    `workflow=${ev.workflowRunId.slice(0, 8)}…`,
  ].join("\n");
  pushTraderAgentMessage({
    id: ev.id,
    ts: Date.parse(ev.ts) || Date.now(),
    messageType: ev.messageType,
    senderRole: ev.senderRole,
    receiverRole: ev.receiverRole,
    workflowRunId: ev.workflowRunId,
    summary: ev.summary,
    body,
  });
}

export function useTraderAgentEngine(projectId: string | null, sessionId: string | null) {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const traderAgentConfig = useAppStore((s) => s.traderAgentConfig);
  const pushTraderAgentLog = useAppStore((s) => s.pushTraderAgentLog);
  const pushTraderMarker = useAppStore((s) => s.pushTraderMarker);
  const pushTraderDriver = useAppStore((s) => s.pushTraderDriver);
  const pushTraderAgentMessage = useAppStore((s) => s.pushTraderAgentMessage);
  const requestChartReload = useAppStore((s) => s.requestChartReload);

  const [session, setSession] = useState<TraderSessionContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const seenIds = useRef(new Set<string>());
  const sinceRef = useRef(loadSince());

  useEffect(() => {
    if (!projectId || !sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const ctx = await ensureTraderSession({ projectId, sessionId });
        if (!cancelled) {
          setSession(ctx);
          pushTraderAgentLog({
            kind: "info",
            title: ctx.created ? "交易上下文已创建" : "交易上下文已连接",
            body: `workflowRunId=${ctx.workflowRunId}\n单 workflow 模式：新事件以消息追加，过长时自动压缩。`,
          });
        }
      } catch (e) {
        pushTraderAgentLog({
          kind: "info",
          title: "交易会话初始化失败",
          body: `${e instanceof Error ? e.message : String(e)}\n请确认后端已重启并挂载 /api/v1/trader 路由。`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, sessionId, pushTraderAgentLog]);

  const pollOnce = useCallback(async () => {
    if (!sessionId || !session?.workflowRunId || !chartSpec.symbol.trim()) return;
    try {
      const { events, drivers, agentMessages, contextMessages, serverTime } = await pollTraderFeed({
        sessionId,
        workflowRunId: session.workflowRunId,
        symbol: chartSpec.symbol.trim(),
        exchange: chartSpec.exchange,
        since: sinceRef.current,
        includeNews: true,
      });
      for (const ev of events) {
        if (seenIds.current.has(ev.id)) continue;
        seenIds.current.add(ev.id);
        ingestFeedEvent(ev, { pushTraderAgentLog, pushTraderMarker });
      }
      for (const d of drivers) {
        if (seenIds.current.has(d.id)) continue;
        seenIds.current.add(d.id);
        ingestDriver(d, pushTraderDriver);
      }
      for (const m of agentMessages) {
        if (seenIds.current.has(m.id)) continue;
        seenIds.current.add(m.id);
        ingestAgentMessage(m, pushTraderAgentMessage);
      }
      for (const cm of contextMessages) {
        if (seenIds.current.has(cm.id)) continue;
        seenIds.current.add(cm.id);
        const kind =
          cm.role === "user"
            ? "user"
            : cm.role === "compressed"
              ? "ingest"
              : cm.kind.includes("order")
                ? "decision"
                : "ingest";
        pushTraderAgentLog({
          kind,
          title: cm.title,
          body: cm.body,
        });
      }
      sinceRef.current = serverTime;
      persistSince(serverTime);
      setLastPollAt(serverTime);
    } catch {
      /* silent poll */
    }
  }, [
    sessionId,
    session?.workflowRunId,
    chartSpec.symbol,
    chartSpec.exchange,
    pushTraderAgentLog,
    pushTraderMarker,
    pushTraderDriver,
    pushTraderAgentMessage,
  ]);

  useEffect(() => {
    if (!sessionId) return;
    void pollOnce();
    const ms =
      traderAgentConfig.triggerMode === "interval"
        ? Math.max(10, traderAgentConfig.intervalSec) * 1000
        : traderAgentConfig.triggerMode === "strategy_signal"
          ? 8000
          : 12000;
    const t = window.setInterval(() => void pollOnce(), ms);
    return () => window.clearInterval(t);
  }, [sessionId, traderAgentConfig.triggerMode, traderAgentConfig.intervalSec, pollOnce]);

  const placeOrder = useCallback(
    async (input: {
      side: "buy" | "sell";
      qty: number;
      orderType?: "market" | "limit";
      price?: number | null;
      rationale?: string;
    }) => {
      if (!session?.workflowRunId) throw new Error("交易会话未就绪");
      setBusy(true);
      try {
        const spec = useAppStore.getState().chartSpec;
        pushTraderDriver({
          driverKind: "user_command",
          title: "用户驱动 · 快捷交易",
          body: `${input.side} ${input.qty} · ${spec.symbol}`,
        });
        const data = await placeTraderOrder({
          workflowRunId: session.workflowRunId,
          symbol: spec.symbol.trim(),
          exchange: spec.exchange,
          side: input.side,
          qty: input.qty,
          price: input.price,
          orderType: input.orderType ?? "market",
          timeframe: spec.timeframe,
          rationale: input.rationale ?? `trader_ui:${input.side}`,
          executionMode: "paper",
        });
        if (data.riskOutcome === "block") {
          pushTraderAgentLog({
            kind: "decision",
            title: "风控拒绝",
            body: data.riskReason,
          });
          throw new Error(data.riskReason);
        }
        pushTraderMarker({
          side: input.side,
          text: `${input.side === "buy" ? "买入" : "卖出"} ${input.qty}`,
          source: "manual",
          orderIntentId: data.orderIntentId,
        });
        pushTraderAgentLog({
          kind: "user",
          title: input.side === "buy" ? "快捷交易 · 买入已提交" : "快捷交易 · 卖出已提交",
          body: `orderIntent=${data.orderIntentId}\nstatus=${data.riskOutcome}`,
        });
        requestChartReload();
        void pollOnce();
        return data;
      } finally {
        setBusy(false);
      }
    },
    [session, pushTraderAgentLog, pushTraderMarker, pushTraderDriver, requestChartReload, pollOnce]
  );

  const cancelOrder = useCallback(
    async (orderIntentId: string) => {
      setBusy(true);
      try {
        pushTraderDriver({
          driverKind: "user_command",
          title: "用户驱动 · 撤单",
          body: orderIntentId,
        });
        const data = await cancelTraderOrder({
          orderIntentId,
          workflowRunId: session?.workflowRunId,
        });
        pushTraderAgentLog({
          kind: "user",
          title: data.cancelled ? "撤单成功" : "撤单未执行",
          body: data.detail,
        });
        void pollOnce();
        return data;
      } finally {
        setBusy(false);
      }
    },
    [pushTraderAgentLog, pushTraderDriver, pollOnce]
  );

  const runCommand = useCallback(
    async (text: string) => {
      if (!session?.workflowRunId || !sessionId) throw new Error("交易会话未就绪");
      const spec = useAppStore.getState().chartSpec;
      pushTraderDriver({
        driverKind: "user_command",
        title: "用户驱动 · 文本指令",
        body: text,
      });
      pushTraderAgentLog({ kind: "user", title: "用户指令", body: text });
      const { data, parsed } = await runTraderCommand({
        workflowRunId: session.workflowRunId,
        sessionId,
        symbol: spec.symbol.trim(),
        exchange: spec.exchange,
        timeframe: spec.timeframe,
        text,
        executionMode: "paper",
      });
      if (parsed.action === "ingest") {
        requestChartReload();
        return null;
      }
      if (data?.orderIntentId) {
        pushTraderMarker({
          side: parsed.action === "sell" ? "sell" : "buy",
          text: `指令 ${parsed.action} ${parsed.qty ?? ""}`,
          source: "agent",
          orderIntentId: data.orderIntentId,
        });
      }
      void pollOnce();
      return data;
    },
    [session, sessionId, pushTraderAgentLog, pushTraderMarker, pushTraderDriver, requestChartReload, pollOnce]
  );

  const runAgentCycle = useCallback(async () => {
    const spec = useAppStore.getState().chartSpec;
    pushTraderDriver({
      driverKind: "interval_poll",
      title: "定时轮询 · Agent 周期",
      body: `标的 ${spec.symbol} · 模式=${traderAgentConfig.triggerMode}`,
    });
    pushTraderAgentLog({
      kind: "ingest",
      title: "Agent 轮询周期",
      body: `拉取策略驱动、A2A 消息与成交决策…`,
    });
    requestChartReload();
    await pollOnce();
  }, [traderAgentConfig.triggerMode, pushTraderAgentLog, pushTraderDriver, requestChartReload, pollOnce]);

  return {
    session,
    busy,
    lastPollAt,
    placeOrder,
    cancelOrder,
    runCommand,
    runAgentCycle,
    pollOnce,
  };
}
