import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { alertEvent, communicationMessageLog, scheduledJob, scheduledJobRun } from "../../db/sqlite/schema";
import { runAutoExecution, type ScheduledExecutionPayload } from "../reia/auto-execution";
import { createAndDispatchWorkflow } from "./workflow-service";

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_TRIGGER_LOOKBACK_MINUTES = 30;

type TriggerSource = "news" | "event" | "kline";

interface TradingGateConfig {
  timezone: string;
  tradingDays: number[];
  tradingStart: string;
  tradingEnd: string;
}

interface TriggerGateConfig {
  triggerDriven: boolean;
  triggerSources: TriggerSource[];
  newsLookbackMinutes: number;
  eventLookbackMinutes: number;
  klineLookbackMinutes: number;
  klineKeywords: string[];
}

function floorToMinute(input: Date): Date {
  const d = new Date(input);
  d.setSeconds(0, 0);
  return d;
}

export function supportsCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  if (![hour, day, month, weekday].every((item) => item === "*")) return false;
  return minute === "*" || /^\*\/\d+$/.test(minute);
}

export function parseMinuteStep(expr: string): number {
  const minute = expr.trim().split(/\s+/)[0] ?? "*";
  if (minute === "*") return 1;
  const matched = minute.match(/^\*\/(\d+)$/);
  if (!matched) return 1;
  return Math.max(1, Number(matched[1]));
}

export function computeNextRunAt(cronExpr: string, from = new Date()): string {
  if (!supportsCronExpression(cronExpr)) {
    throw new Error("Only cron format `* * * * *` and `*/N * * * *` is supported for now.");
  }
  const step = parseMinuteStep(cronExpr);
  const base = floorToMinute(from);
  for (let i = 1; i <= 24 * 60; i += 1) {
    const candidate = new Date(base.getTime() + i * 60_000);
    if (candidate.getUTCMinutes() % step === 0) {
      return candidate.toISOString();
    }
  }
  return new Date(base.getTime() + 60_000).toISOString();
}

function parseScheduledPayload(raw: unknown): ScheduledExecutionPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const ticker = typeof payload["ticker"] === "string" ? payload["ticker"] : "";
  const direction = payload["direction"];
  const quantity = Number(payload["quantity"]);
  const targetPrice = Number(payload["targetPrice"]);
  if (!ticker || !["long", "short", "close"].includes(String(direction))) return null;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  return {
    ticker,
    direction: direction as "long" | "short" | "close",
    quantity,
    targetPrice,
    rationale: typeof payload["rationale"] === "string" ? payload["rationale"] : undefined,
    expectedReturn: Number.isFinite(Number(payload["expectedReturn"]))
      ? Number(payload["expectedReturn"])
      : undefined,
    expectedRisk: Number.isFinite(Number(payload["expectedRisk"])) ? Number(payload["expectedRisk"]) : undefined,
    brokerProvider: payload["brokerProvider"] === "ib" ? "ib" : "futu",
  };
}

function parseTradingGate(raw: unknown): TradingGateConfig {
  const payload = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const tradingDays =
    Array.isArray(payload["tradingDays"]) && payload["tradingDays"].every((v) => Number.isInteger(v))
      ? (payload["tradingDays"] as number[])
      : [1, 2, 3, 4, 5];
  const tradingStart = typeof payload["tradingStart"] === "string" ? payload["tradingStart"] : "09:30";
  const tradingEnd = typeof payload["tradingEnd"] === "string" ? payload["tradingEnd"] : "16:00";
  const timezone = typeof payload["timezone"] === "string" ? payload["timezone"] : "Asia/Shanghai";
  return { tradingDays, tradingStart, tradingEnd, timezone };
}

function parseTriggerGate(raw: unknown): TriggerGateConfig {
  const payload = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const triggerDriven =
    typeof payload["triggerDriven"] === "boolean" ? Boolean(payload["triggerDriven"]) : true;
  const sources = Array.isArray(payload["triggerSources"])
    ? payload["triggerSources"].filter((s): s is TriggerSource =>
        ["news", "event", "kline"].includes(String(s))
      )
    : (["news", "event", "kline"] as TriggerSource[]);
  return {
    triggerDriven,
    triggerSources: sources.length ? sources : ["news", "event", "kline"],
    newsLookbackMinutes: Math.max(
      1,
      Number(payload["newsLookbackMinutes"] ?? DEFAULT_TRIGGER_LOOKBACK_MINUTES)
    ),
    eventLookbackMinutes: Math.max(
      1,
      Number(payload["eventLookbackMinutes"] ?? DEFAULT_TRIGGER_LOOKBACK_MINUTES)
    ),
    klineLookbackMinutes: Math.max(
      1,
      Number(payload["klineLookbackMinutes"] ?? DEFAULT_TRIGGER_LOOKBACK_MINUTES)
    ),
    klineKeywords: Array.isArray(payload["klineKeywords"])
      ? payload["klineKeywords"].map(String).filter(Boolean)
      : ["kline", "price_break", "volatility_spike", "candlestick"],
  };
}

function parseHmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((v) => Number(v));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  return Math.max(0, Math.min(23, h)) * 60 + Math.max(0, Math.min(59, m));
}

function isInTradingWindow(now: Date, gate: TradingGateConfig): boolean {
  const local = new Date(now.toLocaleString("en-US", { timeZone: gate.timezone }));
  const weekday = local.getDay();
  if (!gate.tradingDays.includes(weekday)) return false;
  const minutes = local.getHours() * 60 + local.getMinutes();
  const start = parseHmToMinutes(gate.tradingStart);
  const end = parseHmToMinutes(gate.tradingEnd);
  if (start <= end) return minutes >= start && minutes <= end;
  // Handle night sessions crossing midnight.
  return minutes >= start || minutes <= end;
}

async function isTriggerMatched(
  now: Date,
  gate: TriggerGateConfig,
  payload: Record<string, unknown>
): Promise<{ matched: boolean; reason: string }> {
  if (!gate.triggerDriven) return { matched: true, reason: "triggerDriven disabled" };
  const db = await getDb();
  const nowMs = now.getTime();

  if (gate.triggerSources.includes("news")) {
    const since = new Date(nowMs - gate.newsLookbackMinutes * 60_000).toISOString();
    const rows = await db
      .select()
      .from(communicationMessageLog)
      .where(and(eq(communicationMessageLog.direction, "inbound"), gte(communicationMessageLog.createdAt, since)))
      .orderBy(desc(communicationMessageLog.createdAt))
      .limit(1);
    if (rows[0]) return { matched: true, reason: "news trigger matched" };
  }

  if (gate.triggerSources.includes("event")) {
    const since = new Date(nowMs - gate.eventLookbackMinutes * 60_000).toISOString();
    const rows = await db
      .select()
      .from(alertEvent)
      .where(gte(alertEvent.createdAt, since))
      .orderBy(desc(alertEvent.createdAt))
      .limit(1);
    if (rows[0]) return { matched: true, reason: "event trigger matched" };
  }

  if (gate.triggerSources.includes("kline")) {
    const since = new Date(nowMs - gate.klineLookbackMinutes * 60_000).toISOString();
    const rows = await db
      .select()
      .from(alertEvent)
      .where(gte(alertEvent.createdAt, since))
      .orderBy(desc(alertEvent.createdAt))
      .limit(20);
    const keywords = gate.klineKeywords.map((s) => s.toLowerCase());
    const matched = rows.some((row) => {
      const haystack = `${row.alertType} ${row.title} ${JSON.stringify(row.detailsJson ?? {})}`.toLowerCase();
      return keywords.some((k) => haystack.includes(k));
    });
    if (matched) return { matched: true, reason: "kline trigger matched" };
  }

  const ticker = typeof payload["ticker"] === "string" ? payload["ticker"] : "";
  return {
    matched: false,
    reason: ticker
      ? `no trigger signal within lookback for ${ticker}`
      : "no trigger signal within lookback window",
  };
}

async function evaluateJobGate(job: typeof scheduledJob.$inferSelect): Promise<{ allowed: boolean; reason: string }> {
  const now = new Date();
  const payload = (job.payloadJson ?? {}) as Record<string, unknown>;
  const tradingGate = parseTradingGate(payload);
  if (!isInTradingWindow(now, tradingGate)) {
    return { allowed: false, reason: "outside trading window" };
  }
  const trigger = parseTriggerGate(payload);
  const match = await isTriggerMatched(now, trigger, payload);
  if (!match.matched) return { allowed: false, reason: match.reason };
  return { allowed: true, reason: match.reason };
}

async function runJob(job: typeof scheduledJob.$inferSelect, triggerAtIso: string): Promise<void> {
  const db = await getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();
  await db.insert(scheduledJobRun).values({
    id: runId,
    jobId: job.id,
    triggerAt: triggerAtIso,
    status: "running",
    startedAt: now,
  });

  try {
    const payload = (job.payloadJson ?? {}) as Record<string, unknown>;
    const goal =
      typeof payload["goal"] === "string" && payload["goal"].trim()
        ? String(payload["goal"])
        : `Scheduled job ${job.name} @ ${triggerAtIso}`;
    const mode = (payload["mode"] as "research" | "backtest" | "simulation" | "live") ?? "research";

    const created = await createAndDispatchWorkflow({
      projectId: job.projectId,
      sessionId: job.sessionId ?? undefined,
      source: "api",
      goal,
      mode,
      taskType: "scheduled_workflow_start",
      params: { scheduledJobId: job.id, triggerAt: triggerAtIso },
    });

    let intentOrderId: string | undefined;
    let executionReportId: string | undefined;
    const execPayload = parseScheduledPayload(job.payloadJson);
    if (execPayload) {
      const auto = await runAutoExecution({
        workflowRunId: created.data.id,
        executionMode: job.executionMode,
        payload: execPayload,
      });
      intentOrderId = auto.intentOrderId;
      executionReportId = auto.executionReportId;
    }

    await db
      .update(scheduledJobRun)
      .set({
        status: "success",
        workflowRunId: created.data.id,
        intentOrderId,
        executionReportId,
        endedAt: new Date().toISOString(),
      })
      .where(eq(scheduledJobRun.id, runId));
    await db
      .update(scheduledJob)
      .set({
        lastRunAt: triggerAtIso,
        nextRunAt: computeNextRunAt(job.cronExpr, new Date(triggerAtIso)),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(scheduledJob.id, job.id));
  } catch (error) {
    await db
      .update(scheduledJobRun)
      .set({
        status: "failed",
        errorMessage: (error as Error).message,
        endedAt: new Date().toISOString(),
      })
      .where(eq(scheduledJobRun.id, runId));
    await db
      .update(scheduledJob)
      .set({
        nextRunAt: computeNextRunAt(job.cronExpr, new Date(triggerAtIso)),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(scheduledJob.id, job.id));
  }
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const db = await getDb();
      const nowIso = now.toISOString();
      const dueJobs = await db
        .select()
        .from(scheduledJob)
        .where(and(eq(scheduledJob.enabled, true), lte(scheduledJob.nextRunAt, nowIso)))
        .orderBy(asc(scheduledJob.nextRunAt));
      for (const job of dueJobs) {
        const gate = await evaluateJobGate(job);
        if (!gate.allowed) {
          await db.insert(scheduledJobRun).values({
            id: randomUUID(),
            jobId: job.id,
            triggerAt: nowIso,
            status: "skipped",
            errorMessage: gate.reason,
            startedAt: nowIso,
            endedAt: nowIso,
          });
          await db
            .update(scheduledJob)
            .set({
              nextRunAt: computeNextRunAt(job.cronExpr, now),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(scheduledJob.id, job.id));
          continue;
        }
        await runJob(job, nowIso);
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, DEFAULT_TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const workflowScheduler = new WorkflowScheduler();
