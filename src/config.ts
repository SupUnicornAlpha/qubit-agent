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
  memory: z.object({
    sessionTtlHours: z.coerce.number().default(24),
    external: z.object({
      enabled: z.boolean().default(false),
      writeMode: z
        .enum(["dual_write", "external_only", "native_only"])
        .default("native_only"),
    }),
  }).default({}),
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
