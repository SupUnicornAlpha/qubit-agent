#!/usr/bin/env bun
/**
 * Manual smoke: assumes qubit-app-server already listening.
 *
 *   cargo run -p qubit-app-server -- --bind 127.0.0.1:8787
 *   QUBIT_CORE_BACKEND=rust bun run scripts/prime-core-smoke.ts
 */

import {
  buildPrimeAgentSpecs,
  smokePrimaryTurn,
  summarizePrimeSeed,
  syncPrimeSpecsToRustCore,
} from "../src/runtime/prime";

process.env.QUBIT_CORE_BACKEND = "rust";
process.env.QUBIT_RUST_CORE_URL =
  process.env.QUBIT_RUST_CORE_URL ?? "http://127.0.0.1:8787";

const summary = summarizePrimeSeed(buildPrimeAgentSpecs());
console.log("[prime-smoke] seed", summary);

const synced = await syncPrimeSpecsToRustCore();
console.log("[prime-smoke] upserted", synced.upserted);

const result = await smokePrimaryTurn({ text: "cli smoke hello" });
console.log("[prime-smoke] turn", result);

if (result.delivery_status !== "delivered") {
  console.error("[prime-smoke] FAIL delivery", result);
  process.exit(1);
}
console.log("[prime-smoke] OK");
