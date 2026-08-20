/**
 * Process-local circuit breaker for optional Harness packages.
 *
 * The legacy tool surface remains the availability boundary. A failing optional
 * profile is isolated after repeated composition failures, then retried after a
 * cooldown. Health is intentionally non-persistent: a server restart is an
 * explicit operator retry, while the event ledger remains the audit source.
 */
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 5 * 60_000;
const COOLDOWN_MS = 10 * 60_000;

type ProfileHealth = {
  failures: number[];
  openedAt: number | null;
  lastError: string | null;
};

const profiles = new Map<string, ProfileHealth>();

export type HarnessProfileHealth = {
  profileId: string;
  state: "closed" | "open";
  failuresInWindow: number;
  openedAt: string | null;
  retryAt: string | null;
  lastError: string | null;
};

export function recordHarnessProfileFailure(profileIds: readonly string[], error: string): void {
  const now = Date.now();
  for (const profileId of profileIds) {
    const state = profiles.get(profileId) ?? { failures: [], openedAt: null, lastError: null };
    state.failures = state.failures.filter((timestamp) => timestamp >= now - WINDOW_MS);
    state.failures.push(now);
    state.lastError = error.slice(0, 500);
    if (state.failures.length >= FAILURE_THRESHOLD) state.openedAt = now;
    profiles.set(profileId, state);
  }
}

export function isHarnessProfileCircuitOpen(profileId: string, now = Date.now()): boolean {
  const state = profiles.get(profileId);
  if (!state?.openedAt) return false;
  if (state.openedAt + COOLDOWN_MS > now) return true;
  state.openedAt = null;
  state.failures = [];
  profiles.set(profileId, state);
  return false;
}

export function listHarnessProfileHealth(now = Date.now()): HarnessProfileHealth[] {
  return [...profiles.entries()]
    .map(([profileId, state]) => {
      const failures = state.failures.filter((timestamp) => timestamp >= now - WINDOW_MS);
      const open = isHarnessProfileCircuitOpen(profileId, now);
      return {
        profileId,
        state: (open ? "open" : "closed") as HarnessProfileHealth["state"],
        failuresInWindow: failures.length,
        openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : null,
        retryAt: state.openedAt ? new Date(state.openedAt + COOLDOWN_MS).toISOString() : null,
        lastError: state.lastError,
      };
    })
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}

export function resetHarnessProfileHealthForTest(): void {
  profiles.clear();
}
