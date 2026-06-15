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

export interface ExternalCallOptions {
  /**
   * 每次 attempt 失败时回调（含会被重试吞掉的中途失败）。
   *
   * 为什么需要：`executeWithPolicy` 内部重试时，中途失败的 attempt 会被 catch
   * 吞掉再重试，调用方只看得到「最终成功 / 最终失败」。但 DB 健康统计
   * （mcp_server_health.failureCount）想如实反映「这次工具调用一共失败了几次」，
   * 否则 attempt1 失败 + attempt2 成功会被记成纯 success，failureCount 偏乐观、
   * DB 熔断触发偏晚。dispatcher 借这个钩子把中途失败也回写一笔。
   *
   * 回调内抛错不影响主流程（被吞 + warn），observability 不该拖垮业务。
   */
  onAttemptFailure?: (attempt: number, error: Error) => void | Promise<void>;
}

export async function executeWithPolicy<T>(
  policy: ExternalCallPolicy,
  action: (meta: ExternalCallMeta) => Promise<T>,
  options?: ExternalCallOptions
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
      if (options?.onAttemptFailure) {
        // observability 钩子失败不该拖垮业务：吞 + warn
        try {
          await options.onAttemptFailure(attempt, lastError);
        } catch (cbErr) {
          console.warn(
            `[executeWithPolicy] onAttemptFailure threw (ignored): ${(cbErr as Error).message}`
          );
        }
      }
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

