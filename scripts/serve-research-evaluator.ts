import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSealedEvaluator } from "../src/runtime/research-program/sealed-evaluator";

/** Run on the evaluator host; these bundles and keys must stay outside the research Agent's filesystem. */
const configFile = process.env.QUBIT_SEALED_EVALUATOR_CONFIG;
const token = process.env.QUBIT_SEALED_EVALUATOR_TOKEN;
if (!configFile || !token) {
  throw new Error(
    "Set QUBIT_SEALED_EVALUATOR_CONFIG and QUBIT_SEALED_EVALUATOR_TOKEN on the isolated evaluator host"
  );
}
const absoluteConfig = resolve(configFile);
const config = JSON.parse(await readFile(absoluteConfig, "utf8")) as {
  sqliteFilename: string;
  trustedPublicKeys: Record<string, string>;
  bundleFiles: string[];
  hostname?: string;
  port?: number;
};
if (!config.sqliteFilename || !config.trustedPublicKeys || !Array.isArray(config.bundleFiles)) {
  throw new Error("sealed_evaluator_config_invalid");
}
const sqliteFilename = resolve(dirname(absoluteConfig), config.sqliteFilename);
await mkdir(dirname(sqliteFilename), { recursive: true });
const bundles = await Promise.all(
  config.bundleFiles.map(
    async (path) =>
      JSON.parse(await readFile(resolve(dirname(absoluteConfig), path), "utf8")) as unknown
  )
);
const evaluator = createSealedEvaluator({
  sqliteFilename,
  token,
  trustedPublicKeys: config.trustedPublicKeys,
  bundles,
});
const server = Bun.serve({
  hostname: config.hostname ?? "127.0.0.1",
  port: config.port ?? 8790,
  maxRequestBodySize: 32_000,
  idleTimeout: 120,
  fetch: evaluator.fetch,
});
console.log(
  `[SealedEvaluator] Listening on ${server.hostname}:${server.port}; ${bundles.length} signed datasets loaded`
);
const shutdown = () => {
  server.stop(true);
  evaluator.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
