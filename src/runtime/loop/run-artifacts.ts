import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOOP_SUBDIR = "loop-runs";

/** Workspace-relative base: `.qubit/loop-runs` under cwd. */
export function loopRunsBaseDir(cwd = process.cwd()): string {
  return join(cwd, ".qubit", LOOP_SUBDIR);
}

export function loopRunDir(workflowId: string, cwd = process.cwd()): string {
  return join(loopRunsBaseDir(cwd), workflowId);
}

export async function ensureLoopRunDir(workflowId: string, cwd = process.cwd()): Promise<string> {
  const dir = loopRunDir(workflowId, cwd);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Absolute path to MCP bridge entry (Bun entrypoint). */
export function mcpBridgeEntryFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "mcp-bridge-server.ts");
}

export async function writeLoopRunArtifacts(input: {
  workflowId: string;
  projectId: string;
  goal: string;
  mode: string;
  loopKind: "claude_cli" | "codex_cli";
  injectMcpBridge: boolean;
  cwd?: string;
}): Promise<{ runDir: string; promptPath: string; bridgeManifestPath?: string }> {
  const runDir = await ensureLoopRunDir(input.workflowId, input.cwd);
  const promptPath = join(runDir, "QUBIT_PROMPT.md");
  const bridgeBody = `# QUBIT external loop

workflowId: \`${input.workflowId}\`
projectId: \`${input.projectId}\`
mode: \`${input.mode}\`

## Goal

${input.goal}

## Optional machine protocol (stdout)

You may emit **one JSON object per line** (NDJSON) using schema \`qubit.loop.v1\`:

\`\`\`json
{"v":"qubit.loop.v1","type":"log","message":"..."}
{"v":"qubit.loop.v1","type":"tool","tool":"name","payload":{}}
{"v":"qubit.loop.v1","type":"session","sessionId":"<your-session-id>"}
{"v":"qubit.loop.v1","type":"final","payload":{"status":"completed"}}
{"v":"qubit.loop.v1","type":"error","message":"..."}
\`\`\`

Plain text lines are recorded as unstructured logs.

If you emit a \`session\` line early, QUBIT will persist it on \`workflow_run.cli_session_id\` and, on
process restart, resume your CLI with the same session (\`claude --resume <id>\` / \`codex exec resume <id>\`).
QUBIT also best-effort sniffs the native \`session_id\` field from your CLI's first JSON line.

${
  input.injectMcpBridge
    ? `## MCP (QUBIT-configured servers)

Use the MCP server \`qubit\` defined in \`qubit-mcp-bridge.json\` in this directory (stdio bridge into QUBIT's dispatcher). Merge or reference it from your tool config.
`
    : ""
}
`;
  await writeFile(promptPath, bridgeBody, "utf8");

  let bridgeManifestPath: string | undefined;
  if (input.injectMcpBridge) {
    bridgeManifestPath = join(runDir, "qubit-mcp-bridge.json");
    const manifest = {
      mcpServers: {
        qubit: {
          command: "bun",
          args: ["run", mcpBridgeEntryFile()],
          env: {
            QUBIT_MCP_BRIDGE_PROJECT_ID: input.projectId,
          },
        },
      },
    };
    await writeFile(bridgeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  await writeFile(
    join(runDir, "README.txt"),
    `QUBIT loop run artifacts
- QUBIT_PROMPT.md — pass to your CLI (-p / exec / etc.)
${input.injectMcpBridge ? "- qubit-mcp-bridge.json — MCP fragment for qubit stdio bridge\n" : ""}`,
    "utf8"
  );

  return { runDir, promptPath, bridgeManifestPath };
}
