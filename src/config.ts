import { z } from "zod";

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("localhost"),
  env: z.enum(["development", "production", "test"]).default("development"),
  dataDir: z
    .string()
    .default(`${process.env["HOME"] ?? "~"}/.quant-agent`),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  riskSigningKey: z.string().default("dev-secret-change-in-production"),
  /** Default agent execution path for new native workflows (graph | a2a). Per-workflow override on workflow_run. */
  agentExecutionPath: z.enum(["graph", "a2a"]).default("graph"),
  memory: z.object({
    sessionTtlHours: z.coerce.number().default(24),
    external: z.object({
      enabled: z.boolean().default(false),
      writeMode: z
        .enum(["dual_write", "external_only", "native_only"])
        .default("native_only"),
    }),
  }).default({}),
  /**
   * FSI 内容包：运行时以 content-packs/anthropic-fsi/settings.json 为准；
   * 此处仅保留占位，实际逻辑见 src/runtime/fsi/fsi-config.ts
   */
  fsi: z.object({}).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env["PORT"],
    host: process.env["HOST"],
    env: process.env["NODE_ENV"],
    dataDir: process.env["QUBIT_DATA_DIR"],
    logLevel: process.env["LOG_LEVEL"],
    riskSigningKey: process.env["QUBIT_RISK_SIGNING_KEY"],
    agentExecutionPath: process.env["QUBIT_AGENT_EXECUTION_PATH"],
    memory: {
      sessionTtlHours: process.env["MEMORY_SESSION_TTL_HOURS"],
      external: {
        enabled: process.env["MEMORY_EXTERNAL_ENABLED"] === "true",
        writeMode: process.env["MEMORY_WRITE_MODE"],
      },
    },
  });
}

export const config = loadConfig();
