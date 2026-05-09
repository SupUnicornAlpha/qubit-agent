type CircuitState = {
  failures: number;
  openedAt?: number;
};

type IdempotencyEntry<T> = {
  value: T;
  expiresAt: number;
};

const circuitByKey = new Map<string, CircuitState>();
const idempotencyByKey = new Map<string, IdempotencyEntry<unknown>>();

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
}

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export interface IdempotencyPolicy {
  enabled: boolean;
  key: string;
  ttlMs: number;
}

export interface ExternalCallPolicy {
  scopeKey: string;
  retry: RetryPolicy;
  circuitBreaker: CircuitBreakerPolicy;
  idempotency?: IdempotencyPolicy;
}

export interface ExternalCallMeta {
  policyKey: string;
  attempt: number;
}

export async function executeWithPolicy<T>(
  policy: ExternalCallPolicy,
  action: (meta: ExternalCallMeta) => Promise<T>
): Promise<T> {
  if (policy.idempotency?.enabled) {
    const cached = idempotencyByKey.get(policy.idempotency.key) as IdempotencyEntry<T> | undefined;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }

  const key = policyKey(policy);
  const circuit = circuitByKey.get(key) ?? { failures: 0 };
  const now = Date.now();
  if (
    circuit.openedAt &&
    now - circuit.openedAt < policy.circuitBreaker.cooldownMs
  ) {
    throw new Error("circuit breaker open");
  }
  if (circuit.openedAt && now - circuit.openedAt >= policy.circuitBreaker.cooldownMs) {
    circuit.failures = 0;
    circuit.openedAt = undefined;
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= policy.retry.maxAttempts; attempt++) {
    try {
      const result = await action({
        policyKey: key,
        attempt,
      });
      circuit.failures = 0;
      circuit.openedAt = undefined;
      circuitByKey.set(key, circuit);
      if (policy.idempotency?.enabled) {
        idempotencyByKey.set(policy.idempotency.key, {
          value: result,
          expiresAt: Date.now() + policy.idempotency.ttlMs,
        });
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      circuit.failures += 1;
      if (circuit.failures >= policy.circuitBreaker.failureThreshold) {
        circuit.openedAt = Date.now();
      }
      circuitByKey.set(key, circuit);
      if (attempt >= policy.retry.maxAttempts) break;
      const backoff = policy.retry.backoffMs * Math.pow(policy.retry.backoffMultiplier, attempt - 1);
      await Bun.sleep(backoff);
    }
  }
  throw lastError ?? new Error("external call failed");
}

function policyKey(policy: ExternalCallPolicy): string {
  return `${policy.scopeKey}:${policy.circuitBreaker.failureThreshold}:${policy.circuitBreaker.cooldownMs}:${policy.retry.maxAttempts}`;
}

