/** Local process supervisor: no sudo, no arbitrary port killing, no claim of host isolation. */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { connect } from "node:net";
const dataDir = process.env.QUBIT_DATA_DIR;
const evaluatorDir = process.env.QUBIT_EVALUATOR_DIR;
if (!dataDir || !evaluatorDir || !isAbsolute(dataDir) || !isAbsolute(evaluatorDir))
  throw new Error("Set absolute QUBIT_DATA_DIR and QUBIT_EVALUATOR_DIR");
const configPath = join(evaluatorDir, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.deployment !== "local_process" || config.hostname !== "127.0.0.1")
  throw new Error("local_supervisor_requires_loopback_local_process_config");
const tokenPath = join(evaluatorDir, "token");
const token = (await readFile(tokenPath, "utf8")).trim();
const port = Number(process.env.PORT ?? 3000);
const evaluatorPort = Number(config.port ?? 8790);
if (
  ![port, evaluatorPort].every((p) => Number.isInteger(p) && p > 1024 && p <= 65535) ||
  port === evaluatorPort
)
  throw new Error("invalid_local_ports");
async function occupied(port: number) {
  return new Promise<boolean>((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      socket.destroy();
      done(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(true);
    });
  });
}
for (const p of [port, evaluatorPort])
  if (await occupied(p)) throw new Error(`port_${p}_already_in_use_stop_its_owner_explicitly`);
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([Promise.all(children.map((c) => c.exited)), Bun.sleep(5000)]);
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(code);
}
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
const cwd = resolve(import.meta.dir, "..");
function launch(script: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, script], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  void child.exited.then((code) => {
    if (!stopping) {
      console.error(`Research child exited (${code}); stopping owned processes.`);
      void stop(code || 1);
    }
  });
  return child;
}
try {
  launch("scripts/serve-research-evaluator.ts", {
    QUBIT_SEALED_EVALUATOR_CONFIG: configPath,
    QUBIT_SEALED_EVALUATOR_TOKEN_FILE: tokenPath,
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${evaluatorPort}/v1/datasets`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      ready = response.ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("evaluator_not_ready");
  launch("src/index.ts", {
    HOST: "127.0.0.1",
    PORT: String(port),
    QUBIT_DATA_DIR: dataDir,
    QUBIT_RESEARCH_EVALUATOR_URL: `http://127.0.0.1:${evaluatorPort}`,
    QUBIT_RESEARCH_EVALUATOR_TOKEN_FILE: tokenPath,
    QUBIT_SKIP_CORE_PORT_KILL: "1",
    QUBIT_SKIP_WORKFLOW_RESTORE: "1",
  });
  console.log(
    `[Research] Local processes started. Backend :${port}, evaluator :${evaluatorPort}. Same-user filesystem access is NOT isolated. Ctrl-C stops only these children; persistent budgets remain.`
  );
  await new Promise(() => {});
} catch (error) {
  console.error(error instanceof Error ? error.message : "local_start_failed");
  await stop(1);
}
