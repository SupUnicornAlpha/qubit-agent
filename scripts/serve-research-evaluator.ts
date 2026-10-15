import { z } from "zod";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createSealedEvaluator } from "../src/runtime/research-program/sealed-evaluator";

/** Run on the evaluator host; these bundles and keys must stay outside the research Agent's filesystem. */
const configFile = process.env.QUBIT_SEALED_EVALUATOR_CONFIG;
const token = process.env.QUBIT_SEALED_EVALUATOR_TOKEN_FILE
  ? (await readFile(process.env.QUBIT_SEALED_EVALUATOR_TOKEN_FILE, "utf8")).trim()
  : process.env.QUBIT_SEALED_EVALUATOR_TOKEN;
if (!configFile || !token) {
  throw new Error(
    "Set QUBIT_SEALED_EVALUATOR_CONFIG and QUBIT_SEALED_EVALUATOR_TOKEN on the isolated evaluator host"
  );
}
const absoluteConfig = resolve(configFile);
const config = z
  .object({
    sqliteFilename: z.string().min(1),
    trustedPublicKeys: z.record(z.string().min(1)),
    bundleFiles: z.array(z.string().min(1)).min(1).max(100),
    hostname: z.string().default("127.0.0.1"),
    port: z.number().int().min(1025).max(65535).default(8790),
    deployment: z.enum(["local_process", "operator_managed"]).default("operator_managed"),
  })
  .strict()
  .parse(JSON.parse(await readFile(absoluteConfig, "utf8")));
if (config.deployment === "local_process" && config.hostname !== "127.0.0.1")
  throw new Error("local_evaluator_requires_loopback");
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
  deployment: config.deployment,
});
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: config.hostname ?? "127.0.0.1",
    port: config.port ?? 8790,
    maxRequestBodySize: 32_000,
    idleTimeout: 120,
    fetch: evaluator.fetch,
  });
} catch (error) {
  evaluator.close();
  throw error;
}
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
