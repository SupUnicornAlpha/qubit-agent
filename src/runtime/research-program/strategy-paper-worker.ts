import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { researchStrategyEvent } from "../../db/sqlite/schema";
import { appendStrategyEvent, strategyEvents } from "./strategy-lifecycle";
import { strategyPaper } from "./strategy-paper";
/** Opt-in only. Definitions and cursors are durable; restart never invents an extra session. */
export class ResearchPaperWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick().catch((e) => console.warn("[ResearchPaper]", String(e))),
      15000
    );
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const definitions = (await getDb())
        .select()
        .from(researchStrategyEvent)
        .where(eq(researchStrategyEvent.kind, "paper_session"))
        .all();
      let submitted = 0;
      for (const definition of definitions) {
        if (submitted >= 10) break;
        const { projectId, versionId } = definition;
        const session = (await strategyPaper.list(projectId, versionId)).find(
          (s) => s.id === definition.id
        );
        if (
          !session ||
          session.status !== "running" ||
          !session.automatic ||
          session.attempts.some((a) => ["pending", "running"].includes(a.status))
        )
          continue;
        try {
          if (session.attempts[0] && session.attempts[0].status !== "completed")
            throw new Error(`模拟停止：${session.attempts[0].error ?? session.attempts[0].status}`);
          await strategyPaper.advance(projectId, versionId, session.id, {
            expectedCursor: session.cursor,
            idempotencyKey: `auto:${session.id}:${session.cursor ?? "start"}`,
            bars: 20,
          });
          submitted++;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (
            message.includes("没有新的日线") ||
            message.includes("cursor_conflict") ||
            message.includes("already_reserved")
          )
            continue;
          const events = await strategyEvents(projectId, versionId);
          await appendStrategyEvent(
            projectId,
            versionId,
            "paper_status",
            { sessionId: session.id, status: "paused", automatic: false, reason: message },
            events[0]?.sequence ?? 0
          ).catch(() => undefined);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
export const researchPaperWorker = new ResearchPaperWorker();
