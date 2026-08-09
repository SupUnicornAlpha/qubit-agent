#!/usr/bin/env bun

const endpoints = [
  {
    url: process.env.QUBIT_RUST_CORE_HEALTH ?? "http://127.0.0.1:8787/health",
    accept: async (response: Response) => response.ok,
  },
  {
    url:
      process.env.QUBIT_BACKEND_HEALTH ??
      "http://127.0.0.1:17385/api/v1/prime-bridge/health",
    accept: async (response: Response) => response.ok,
  },
  {
    url:
      process.env.QUBIT_PYTHON_HEALTH ??
      "http://127.0.0.1:17385/api/v1/system/python-health?force=true",
    accept: async (response: Response) => {
      if (!response.ok) return false;
      const payload = (await response.json()) as {
        data?: { dependencies?: Array<{ name?: string; available?: boolean }> };
      };
      const deps = new Map(
        (payload.data?.dependencies ?? []).map((dep) => [dep.name, dep.available])
      );
      return deps.get("yfinance") === true && deps.get("akshare") === true;
    },
  },
];
const deadline = Date.now() + Number(process.env.QUBIT_SERVICE_WAIT_MS ?? 120_000);
const pending = new Map(endpoints.map((endpoint) => [endpoint.url, endpoint]));

while (pending.size > 0 && Date.now() < deadline) {
  for (const [url, endpoint] of [...pending]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (await endpoint.accept(response)) {
        pending.delete(url);
        console.log(`[benchmark-ready] ${url}`);
      }
    } catch {
      // Process may still be compiling/booting. Retry until the bounded deadline.
    }
  }
  if (pending.size > 0) await Bun.sleep(1_000);
}

if (pending.size > 0) {
  throw new Error(`benchmark services not ready: ${[...pending.keys()].join(", ")}`);
}
