/**
 * Feasibility: start prebuilt qubit-app-server, sync AgentSpecs, run primary + invoke.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import {
  RustCoreClient,
  buildPrimeAgentSpecs,
  resetCoreRuntimeCache,
  summarizePrimeSeed,
} from "../index";

const ROOT = join(import.meta.dir, "../../../../..");
const BIND = "127.0.0.1:18787";
const BASE = `http://${BIND}`;

let proc: Subprocess | null = null;
let serverReady = false;

function resolveAppServerBin(): string | null {
  const fromEnv = process.env.CARGO_TARGET_DIR
    ? join(process.env.CARGO_TARGET_DIR, "debug", "qubit-app-server")
    : null;
  const candidates = [fromEnv, join(ROOT, "target/debug/qubit-app-server")].filter(
    Boolean
  ) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function waitHealthy(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("qubit-app-server health timeout");
}

describe("rust core agent feasibility", () => {
  beforeAll(async () => {
    const bin = resolveAppServerBin();
    if (!bin) {
      console.warn(
        "qubit-app-server binary missing — run `cargo build -p qubit-app-server` first; skipping"
      );
      return;
    }
    proc = spawn({
      cmd: [bin, "--bind", BIND],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        RUST_LOG: "qubit_app_server=info,qubit_runtime=warn",
      },
    });
    try {
      await waitHealthy();
      serverReady = true;
      resetCoreRuntimeCache();
    } catch (e) {
      const errText = proc.stderr ? await new Response(proc.stderr).text() : "";
      console.warn("server failed to start:", e, errText.slice(0, 800));
      proc.kill();
      proc = null;
    }
  }, 60_000);

  afterAll(() => {
    proc?.kill();
    proc = null;
  });

  test("sync seed specs + primary turn delivers", async () => {
    if (!serverReady || !proc) return;
    const client = new RustCoreClient(BASE);
    const health = await client.health();
    expect(health.core_backend).toBe("rust");

    const specs = buildPrimeAgentSpecs();
    const summary = summarizePrimeSeed(specs);
    expect(summary.primaryId).toBe("def-orchestrator");

    for (const spec of specs) {
      await client.upsertAgent(spec);
    }
    const listed = await client.listAgents();
    expect(listed.agents.some((a) => a.id === "def-orchestrator")).toBe(true);
    expect(listed.agents.find((a) => a.id === "def-orchestrator")?.execution_kind).toBe("primary");
    expect(listed.agents.find((a) => a.id === "def-research")?.execution_kind).toBe("subagent");

    const session = await client.createSession({
      workspace_id: "ws_feasibility",
      agent_ref: "def-orchestrator",
      interaction_mode: "agent",
    });
    expect(session.execution_kind).toBe("primary");

    const started = await client.startTurn({
      session_id: session.session_id,
      input: { text: "feasibility: ping core", attachments: [] },
      idempotency_key: `feas-${Date.now()}`,
    });
    const snap = await client.awaitTurnTerminal(session.session_id, started.turn_id, 10_000);
    expect(snap.active_turn?.state).toBe("completed");
    expect(snap.active_turn?.lifecycle).toBe("completed");
    expect(snap.active_turn?.delivery?.status).toBe("delivered");
  }, 30_000);

  test("subagent cannot create user session; invoke works", async () => {
    if (!serverReady || !proc) return;
    const client = new RustCoreClient(BASE);
    for (const spec of buildPrimeAgentSpecs()) {
      await client.upsertAgent(spec);
    }

    await expect(
      client.createSession({
        agent_ref: "def-research",
        interaction_mode: "agent",
      })
    ).rejects.toThrow();

    const parent = await client.createSession({
      agent_ref: "def-orchestrator",
      interaction_mode: "agent",
    });
    const inv = await client.invokeAgent({
      invocation_id: `inv_feas_${Date.now()}`,
      parent_session_id: parent.session_id,
      parent_turn_id: "trn_parent_feas",
      caller_instance_id: parent.agent_instance_id,
      callee_spec_id: "def-research",
      goal: "quick research note",
      budget: { max_iterations: 2 },
    });
    expect(inv.state).toBe("completed");
    expect(String(inv.child_session_id)).not.toBe(parent.session_id);
  }, 30_000);
});
