import { z } from "zod";
import { researchProtocolSpecSchema } from "./types";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const tools = [
  {
    name: "research_protocol_get",
    description:
      "Read the bound project's immutable protocols, cumulative budget and experiment ledger.",
    inputSchema: object({}),
  },
  {
    name: "research_protocol_create",
    description:
      "Create the next immutable protocol. Budgets cannot increase. Use the same spec shape returned by research_protocol_get.",
    inputSchema: object(
      {
        spec: {
          type: "object",
          properties: {
            hypothesis: string,
            benchmark: string,
            stoppingRule: string,
            development: object(
              {
                datasetSnapshotId: string,
                symbols: { type: "array", items: string, minItems: 3 },
                startDate: string,
                endDate: string,
              },
              ["datasetSnapshotId", "symbols", "startDate", "endDate"]
            ),
            evaluation: object(
              {
                method: { const: "factor_rank_ic_v1" },
                horizonDays: { type: "integer", minimum: 1 },
                groupCount: { type: "integer", minimum: 2 },
                sealedDatasetId: string,
              },
              ["method", "horizonDays", "groupCount"]
            ),
            budget: object(
              {
                maxAttempts: { type: "integer", minimum: 1 },
                maxEvaluations: { type: "integer", minimum: 0 },
              },
              ["maxAttempts", "maxEvaluations"]
            ),
          },
          required: [
            "hypothesis",
            "benchmark",
            "stoppingRule",
            "development",
            "evaluation",
            "budget",
          ],
          additionalProperties: false,
        },
      },
      ["spec"]
    ),
  },
  {
    name: "research_factor_list",
    description: "List factors in the bound project.",
    inputSchema: object({}),
  },
  {
    name: "research_factor_register",
    description:
      "Register a draft daily qlib expression. Does not run a hidden dry-run experiment.",
    inputSchema: object(
      {
        name: string,
        category: { enum: ["value", "momentum", "volatility", "news", "quality", "macro"] },
        expr: string,
        universe: string,
        horizon: { type: "integer", minimum: 1 },
      },
      ["name", "category", "expr", "universe", "horizon"]
    ),
  },
  {
    name: "research_factor_run",
    description:
      "Preregister and execute a factor attempt under the active protocol. Reuse idempotencyKey when retrying. Poll research_protocol_get for the terminal state.",
    inputSchema: object(
      {
        factorId: string,
        kind: { enum: ["factor_compute", "factor_evaluate", "sealed_factor"] },
        idempotencyKey: string,
      },
      ["factorId", "kind", "idempotencyKey"]
    ),
  },
  {
    name: "research_attempt_cancel",
    description: "Cancel an attempt. Its history and budget charge remain.",
    inputSchema: object({ attemptId: string }, ["attemptId"]),
  },
];

/** A narrow integration surface, not a sandbox for an external Agent's other tools. */
export function createResearchMcpHandler(config: {
  baseUrl: string;
  projectId: string;
  fetch?: typeof fetch;
}) {
  const url = new URL(config.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("research_mcp_invalid_url");
  if (!config.projectId.trim()) throw new Error("QUBIT_RESEARCH_PROJECT_ID_required");
  const projectPath = `/api/v1/research-programs/${encodeURIComponent(config.projectId)}`;
  async function call(path: string, body?: unknown) {
    const response = await (config.fetch ?? fetch)(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as { ok: boolean; data?: unknown; error?: string };
    if (!response.ok || !data.ok)
      throw new Error(data.error ?? `research_api_http_${response.status}`);
    return data.data;
  }
  return async (message: unknown): Promise<Record<string, unknown> | null> => {
    const parsed = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.unknown().optional(),
      })
      .safeParse(message);
    if (!parsed.success)
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    const request = parsed.data;
    if (request.id === undefined) return null;
    const response = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize")
      return response({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "qubit-research", version: "1.0.0" },
      });
    if (request.method === "ping") return response({});
    if (request.method === "tools/list") return response({ tools });
    if (request.method !== "tools/call")
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      };
    try {
      const params = z
        .object({ name: z.string(), arguments: z.record(z.unknown()).default({}) })
        .strict()
        .parse(request.params);
      let data: unknown;
      switch (params.name) {
        case "research_protocol_get":
          z.object({}).strict().parse(params.arguments);
          data = await call(projectPath);
          break;
        case "research_protocol_create":
          data = await call(
            `${projectPath}/protocols`,
            z.object({ spec: researchProtocolSpecSchema }).strict().parse(params.arguments)
          );
          break;
        case "research_factor_list":
          z.object({}).strict().parse(params.arguments);
          data = await call(`/api/v1/factors?project_id=${encodeURIComponent(config.projectId)}`);
          break;
        case "research_factor_register": {
          const args = z
            .object({
              name: z.string().min(1),
              category: z.enum(["value", "momentum", "volatility", "news", "quality", "macro"]),
              expr: z.string().min(1).max(10_000),
              universe: z.string().min(1),
              horizon: z.number().int().min(1).max(252),
            })
            .strict()
            .parse(params.arguments);
          data = await call("/api/v1/factors", {
            ...args,
            projectId: config.projectId,
            lang: "qlib_expr",
            providerKey: "qlib_expr",
            dryRun: false,
            status: "draft",
          });
          break;
        }
        case "research_factor_run": {
          const args = z
            .object({
              factorId: z.string().min(1),
              kind: z.enum(["factor_compute", "factor_evaluate", "sealed_factor"]),
              idempotencyKey: z.string().min(1).max(200),
            })
            .strict()
            .parse(params.arguments);
          data = await call(`${projectPath}/attempts`, args);
          break;
        }
        case "research_attempt_cancel": {
          const { attemptId } = z
            .object({ attemptId: z.string().min(1) })
            .strict()
            .parse(params.arguments);
          data = await call(`${projectPath}/attempts/${encodeURIComponent(attemptId)}/cancel`, {});
          break;
        }
        default:
          throw new Error("Unknown tool");
      }
      return response({ content: [{ type: "text", text: JSON.stringify(data) }] });
    } catch (error) {
      return response({
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      });
    }
  };
}
