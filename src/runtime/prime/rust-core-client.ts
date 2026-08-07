/**
 * HTTP JSON-RPC client for qubit-app-server (Rust Core).
 */

import {
  type AgentSpec,
  type CoreRuntime,
  type PrimeRuntimeEvent,
  type RuntimeHealth,
  type SessionSnapshot,
  type SessionView,
  PRIME_RPC,
} from "./types";

type JsonRpcOk = { jsonrpc: "2.0"; result: unknown; id: string | number | null };
type JsonRpcErr = {
  jsonrpc: "2.0";
  error: { code: number; message: string; data?: unknown };
  id: string | number | null;
};

export class RustCoreClient implements CoreRuntime {
  constructor(private readonly baseUrl: string) {}

  private async rpc<T>(method: string, params: unknown = {}): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/rpc`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`rust core HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as JsonRpcOk | JsonRpcErr;
    if ("error" in body && body.error) {
      throw new Error(`rust core RPC ${method}: ${body.error.message}`);
    }
    return (body as JsonRpcOk).result as T;
  }

  health(): Promise<RuntimeHealth> {
    return this.rpc(PRIME_RPC.RUNTIME_HEALTH, {});
  }

  listAgents(): Promise<{ agents: AgentSpec[] }> {
    return this.rpc(PRIME_RPC.AGENT_LIST, {});
  }

  async upsertAgent(spec: AgentSpec): Promise<void> {
    await this.rpc(PRIME_RPC.AGENT_UPSERT, spec);
  }

  createSession(req: {
    workspace_id?: string;
    agent_ref: string;
    interaction_mode?: SessionView["interaction_mode"];
    mode?: string;
  }): Promise<SessionView> {
    return this.rpc(PRIME_RPC.SESSION_CREATE, req);
  }

  getSession(sessionId: string): Promise<SessionView> {
    return this.rpc(PRIME_RPC.SESSION_GET, { session_id: sessionId });
  }

  setSessionMode(req: {
    session_id: string;
    interaction_mode: SessionView["interaction_mode"];
  }): Promise<SessionView> {
    return this.rpc(PRIME_RPC.SESSION_SET_MODE, req);
  }

  sessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    return this.rpc(PRIME_RPC.SESSION_SNAPSHOT, { session_id: sessionId });
  }

  startTurn(req: {
    session_id: string;
    input: { text: string; attachments?: unknown[]; client_meta?: unknown };
    idempotency_key: string;
    context?: import("./types").TurnContextOpts;
  }): Promise<{ turn_id: string }> {
    return this.rpc(PRIME_RPC.TURN_START, req);
  }

  async cancelTurn(req: { session_id: string; turn_id: string }): Promise<void> {
    await this.rpc(PRIME_RPC.TURN_CANCEL, req);
  }

  async failTurn(req: { session_id: string; turn_id: string }): Promise<void> {
    await this.rpc(PRIME_RPC.TURN_FAIL, req);
  }

  invokeAgent(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.rpc(PRIME_RPC.AGENT_INVOKE, req);
  }

  async ingestTrigger(
    req: Record<string, unknown>
  ): Promise<{ turn_id?: string | null }> {
    return this.rpc(PRIME_RPC.TRIGGER_INGEST, req);
  }

  async hitlRespond(req: {
    inbox_id: string;
    approved: boolean;
    selected_option_ids?: string[];
    free_form?: string;
    client_meta?: unknown;
  }): Promise<void> {
    await this.rpc(PRIME_RPC.HITL_RESPOND, req);
  }

  hitlInboxList(req: {
    workspace_id?: string;
    session_id?: string;
    pending_only?: boolean;
  } = {}): Promise<
    Array<{
      inbox_id: string;
      turn_id: string;
      session_id: string;
      status: string;
      prompt?: { title?: string; body?: string };
    }>
  > {
    return this.rpc(PRIME_RPC.HITL_INBOX_LIST, req);
  }

  /**
   * Prefer SSE `/events?turn_id=` when available; fall back to session.snapshot poll.
   * Hard wall-clock deadline (Promise.race) so a hung SSE body reader cannot empty-run.
   * Also detects zombie Acting: mid-flight turn while Core `active_turns === 0`.
   */
  async awaitTurnTerminal(
    sessionId: string,
    turnId: string,
    timeoutMs = 5000,
    onTick?: (snap: SessionSnapshot) => void | Promise<void>,
    onEvent?: (event: PrimeRuntimeEvent) => void | Promise<void>
  ): Promise<SessionSnapshot> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    const timeoutErr = () =>
      new Error(`timeout waiting for turn ${turnId}`);

    const hardTimeout = new Promise<never>((_, reject) => {
      const left = Math.max(0, deadline - Date.now());
      setTimeout(() => reject(timeoutErr()), left);
    });

    const zombieWatch = this.watchOrphanTurn(sessionId, turnId, deadline, onTick);

    const transport = (async () => {
      try {
        return await this.awaitTurnTerminalViaSse(
          sessionId,
          turnId,
          Math.max(0, deadline - Date.now()),
          onTick,
          onEvent
        );
      } catch (err) {
        const left = deadline - Date.now();
        if (left <= 50) throw err;
        console.warn(
          "[prime-core] SSE awaitTurnTerminal failed, falling back to poll:",
          err instanceof Error ? err.message : err
        );
        return this.awaitTurnTerminalPoll(sessionId, turnId, left, onTick);
      }
    })();

    return Promise.race([transport, hardTimeout, zombieWatch]);
  }

  /** Mid-flight turn with no live Core task → heal + surface as timeout (resumable). */
  private async watchOrphanTurn(
    sessionId: string,
    turnId: string,
    deadline: number,
    onTick?: (snap: SessionSnapshot) => void | Promise<void>
  ): Promise<SessionSnapshot> {
    const inflight = new Set([
      "accepted",
      "preparing",
      "reasoning",
      "acting",
      "observing",
      "finalizing",
    ]);
    /** Don't treat brief active_turns blips / early LLM as orphans. */
    const graceMs = Math.max(
      10_000,
      Number(process.env.QUBIT_PRIME_ORPHAN_GRACE_MS ?? 25_000) || 25_000
    );
    /** Require sustained orphan signal (was 3s — false-killed turns mid-LLM/news). */
    const streakNeed = Math.max(
      5,
      Number(process.env.QUBIT_PRIME_ORPHAN_STREAK_SECS ?? 15) || 15
    );
    const watchStarted = Date.now();
    let streak = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_000));
      let health: RuntimeHealth;
      let snap: SessionSnapshot;
      try {
        [health, snap] = await Promise.all([
          this.health(),
          this.sessionSnapshot(sessionId),
        ]);
      } catch {
        continue;
      }
      if (onTick) {
        try {
          await onTick(snap);
        } catch {
          /* ignore */
        }
      }
      const turn = snap.active_turn;
      if (
        turn &&
        turn.turn_id === turnId &&
        (turn.state === "completed" ||
          turn.state === "cancelled" ||
          turn.state === "failed" ||
          turn.state === "awaiting_hitl")
      ) {
        return snap;
      }
      if (Date.now() - watchStarted < graceMs) {
        streak = 0;
        continue;
      }
      const registered =
        typeof health.registered_turns === "number"
          ? health.registered_turns
          : null;
      // Prefer joint signal: semaphore empty AND cancel registry empty (when known).
      // Legacy cores omit registered_turns — fall back to active_turns alone.
      const noLiveTask =
        health.active_turns === 0 &&
        (registered === null || registered === 0);
      if (
        turn &&
        turn.turn_id === turnId &&
        inflight.has(String(turn.state)) &&
        noLiveTask
      ) {
        streak += 1;
        if (streak >= streakNeed) {
          console.warn(
            `[prime-core] orphan turn ${turnId}: active_turns=0` +
              (registered === null ? "" : ` registered_turns=${registered}`) +
              ` for ${streak}s — failTurn`
          );
          try {
            await this.failTurn({ session_id: sessionId, turn_id: turnId });
          } catch {
            try {
              await this.cancelTurn({ session_id: sessionId, turn_id: turnId });
            } catch {
              /* ignore */
            }
          }
          throw new Error(`timeout waiting for turn ${turnId}`);
        }
      } else {
        streak = 0;
      }
    }
    throw new Error(`timeout waiting for turn ${turnId}`);
  }

  private eventsUrl(turnId: string): string {
    const base = this.baseUrl.replace(/\/$/, "");
    return `${base}/events?turn_id=${encodeURIComponent(turnId)}`;
  }

  /** SSE to Core `/events?turn_id=` and wait for terminal RuntimeEvent. */
  private async awaitTurnTerminalViaSse(
    sessionId: string,
    turnId: string,
    timeoutMs: number,
    onTick?: (snap: SessionSnapshot) => void | Promise<void>,
    onEvent?: (event: PrimeRuntimeEvent) => void | Promise<void>
  ): Promise<SessionSnapshot> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const checkSnap = async (): Promise<SessionSnapshot | null> => {
      const snap = await this.sessionSnapshot(sessionId);
      if (onTick) await onTick(snap);
      const turn = snap.active_turn;
      if (
        turn &&
        turn.turn_id === turnId &&
        (turn.state === "completed" ||
          turn.state === "cancelled" ||
          turn.state === "failed" ||
          turn.state === "awaiting_hitl")
      ) {
        return snap;
      }
      return null;
    };

    try {
      const res = await fetch(this.eventsUrl(turnId), {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`sse_unavailable: HTTP ${res.status}`);
      }

      pollTimer = setInterval(() => {
        void checkSnap().then((snap) => {
          if (snap) ctrl.abort();
        });
      }, 200);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const early = await checkSnap();
        if (early) return early;

        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const chunk of parts) {
          const dataLine = chunk
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const raw = dataLine.slice(5).trim();
          try {
            const data = JSON.parse(raw) as PrimeRuntimeEvent & {
              type?: string;
              turn_id?: string;
            };
            if (onEvent) {
              try {
                await onEvent(data);
              } catch (err) {
                console.warn(
                  "[prime-core] awaitTurnTerminal onEvent failed:",
                  err instanceof Error ? err.message : err
                );
              }
            }
            if (
              data.type === "turn_completed" ||
              data.type === "turn_failed" ||
              data.type === "hitl_requested"
            ) {
              const snap = await checkSnap();
              if (snap) return snap;
            }
          } catch {
            /* ignore malformed */
          }
        }
      }
      throw new Error("sse closed before terminal");
    } finally {
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      ctrl.abort();
    }
  }

  /** Poll session.snapshot until turn is terminal, awaiting_hitl, or timeout. */
  async awaitTurnTerminalPoll(
    sessionId: string,
    turnId: string,
    timeoutMs = 5000,
    onTick?: (snap: SessionSnapshot) => void | Promise<void>
  ): Promise<SessionSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.sessionSnapshot(sessionId);
      if (onTick) {
        try {
          await onTick(snap);
        } catch (err) {
          console.warn(
            "[prime-core] awaitTurnTerminal onTick failed:",
            err instanceof Error ? err.message : err
          );
        }
      }
      const turn = snap.active_turn;
      if (
        turn &&
        turn.turn_id === turnId &&
        (turn.state === "completed" ||
          turn.state === "cancelled" ||
          turn.state === "failed" ||
          turn.state === "awaiting_hitl")
      ) {
        return snap;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`timeout waiting for turn ${turnId}`);
  }
}
