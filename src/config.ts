import { z } from "zod";
import { defaultDataDir } from "./runtime/app-paths";

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("localhost"),
  env: z.enum(["development", "production", "test"]).default("development"),
  dataDir: z.string().default(defaultDataDir()),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  riskSigningKey: z.string().default("dev-secret-change-in-production"),
  /**
   * Default agent execution path for new native workflows. 收敛后 native loop 唯一
   * 内部总线是 A2A（graph 派发已删除）；"graph" 枚举仅为兼容历史 DB 行，实际不再路由到 LangGraph。
   */
  agentExecutionPath: z.enum(["graph", "a2a"]).default("a2a"),
  /**
   * 研究团队（analyst wave / 融合 / 辩论 / aux）内部执行传输：
   *   - "a2a"（默认）：分析师作为 A2A 总线上的真实参与方——orchestrator 真发
   *     TASK_ASSIGN 给每个 analyst 专属实例、真等 TASK_RESULT 回包，往返落
   *     `a2a_message` 表 → 拓扑/监控显示真实连线。
   *   - "inprocess"：历史路径，analyst slot 在 `runAnalystTeam` 进程内
   *     `Promise.allSettled` fan-out，不经总线（仅 `research_team_interaction` 有日志）。
   * env: QUBIT_TEAM_EXECUTION_PATH=inprocess 整体回退老路径。
   * 注：A2A 路径需 A2A pool 已启动才生效；无法解析 orchestrator 实例时自动回退到
   * 进程内执行（保证脱离 pool 的单测/脚本仍可跑）。
   */
  teamExecutionPath: z.enum(["inprocess", "a2a"]).default("a2a"),
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
    teamExecutionPath: process.env["QUBIT_TEAM_EXECUTION_PATH"],
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
