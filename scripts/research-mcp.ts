import { createInterface } from "node:readline";
import { createResearchMcpHandler } from "../src/runtime/research-program/mcp-adapter";

const handle = createResearchMcpHandler({
  baseUrl: process.env.QUBIT_RESEARCH_API_URL ?? "http://127.0.0.1:3000",
  projectId: process.env.QUBIT_RESEARCH_PROJECT_ID ?? "",
});
// stdout is reserved for JSON-RPC. The backend owns execution, so disconnecting
// this stdio client does not lose the ledger or cancel the server's attempt.
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
})) {
  try {
    const response = await handle(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`
    );
  }
}
