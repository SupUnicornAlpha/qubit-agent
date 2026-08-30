/**
 * Migration-only compatibility route.
 *
 * These modules are intentionally isolated from the active Agent domain and
 * are not a second execution core.
 */
export * as loop from "./loop";
export * as memory from "./memory";
export * as primeResidual from "./prime-residual";
