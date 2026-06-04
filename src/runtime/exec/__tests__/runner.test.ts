/**
 * exec/runner + registry 单测
 *
 * 覆盖：
 *   - happy path：`echo hello` 跑通拿 stdout
 *   - stdin 传入
 *   - wall_timeout：sleep 比 timeoutMs 长
 *   - cwd 逃逸：absolute 但不在 allowedRoot 下
 *   - cwd 非绝对路径
 *   - cwd 包含 `..`
 *   - arg 元字符拒绝
 *   - allowFreeformArgs=false + allowedSubcommands 拒绝
 *   - argTemplate 渲染（{prompt}/{cwd}/{files...}）
 *   - env allowlist 过滤
 *   - 用户配置文件覆盖：注册新 binary + 同 id 整条替换内置
 *   - getExecProvider 按 kind 双重过滤
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DIR = join(tmpdir(), `qubit-exec-runner-${process.pid}-${Date.now()}`);
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });
// 仅在还没人设过时才设——bun test 同进程多文件跑时，config 是单例，第一个
// import config 的人锁死 dataDir。本文件后跑时只能 fallback 用前人的 dataDir。
if (!process.env.QUBIT_DATA_DIR) process.env.QUBIT_DATA_DIR = TMP_DIR;

// 必须在 import config 之前设环境变量，所以走 dynamic import
const { afterAll, beforeEach, describe, expect, test } = await import("bun:test");
const { config } = await import("../../../config");
const { checkArgs, checkCwdScope, filterEnv, renderArgTemplate, runExec } = await import(
  "../runner"
);
const { getExecProvider, listExecProviders, loadExecProviders, resetExecProviderRegistry } =
  await import("../registry");
type ExecProviderT = import("../types").ExecProvider;

// 用 config.dataDir 实际 resolve 的值（参见上方注释），避免与同目录别的 test 文件冲突
const EFFECTIVE_DATA_DIR = config.dataDir;
const PROJECT_ID = "proj-exec-test";
const WORKFLOW_ID = "wf-exec-test";
const workflowDir = join(EFFECTIVE_DATA_DIR, "projects", PROJECT_ID, "workflows", WORKFLOW_ID);
mkdirSync(workflowDir, { recursive: true });

afterAll(() => {
  rmSync(workflowDir, { recursive: true, force: true });
  rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  resetExecProviderRegistry();
});

/** 构造一个临时 provider（不写注册表，直接传给 runExec） */
function fakeProvider(over: Partial<ExecProviderT> = {}): ExecProviderT {
  return {
    id: "echo",
    kind: "shell",
    description: "test echo",
    command: "echo",
    outputProtocol: "text",
    defaultTimeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    envAllowlist: ["HOME", "PATH"],
    workdirStrategy: "workflow-scoped",
    allowFreeformArgs: true,
    ...over,
  };
}

describe("exec/runner — runExec", () => {
  test("happy path: echo writes stdout, exitCode=0, ok=true", async () => {
    const result = await runExec({
      provider: fakeProvider(),
      args: ["hello", "world"],
      cwd: workflowDir,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("stdin is piped through", async () => {
    const result = await runExec({
      provider: fakeProvider({ id: "cat", command: "cat" }),
      args: [],
      cwd: workflowDir,
      stdinText: "from-stdin\n",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("from-stdin\n");
  });

  test("wall_timeout: sleep longer than timeoutMs is killed", async () => {
    const result = await runExec({
      provider: fakeProvider({
        id: "sleep",
        command: "sleep",
        defaultTimeoutMs: 300,
      }),
      args: ["10"],
      cwd: workflowDir,
      timeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("wall_timeout");
    expect(result.exitCode).toBeNull();
  });

  test("binary_not_found: spawn ENOENT returns structured error (not throw)", async () => {
    const result = await runExec({
      provider: fakeProvider({ id: "ghost", command: "definitely-not-a-real-binary-x9z7" }),
      args: [],
      cwd: workflowDir,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("binary_not_found");
  });

  test("non-zero exit code → ok=false with nonzero_exit", async () => {
    const result = await runExec({
      provider: fakeProvider({ id: "false", command: "false" }),
      args: [],
      cwd: workflowDir,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toBe("nonzero_exit");
  });

  test("output_truncated: large stdout is capped", async () => {
    // yes binary may not exist on every box; use printf in a loop via /bin/sh? 不行，我们 spawn 不走 shell
    // 用 head -c 1000000 /dev/urandom 替代会引入二进制乱码；
    // 最稳的办法：用 echo 重复一个长字符串。POSIX echo 没有重复，但 args 长度可以拼。
    const big = "x".repeat(10_000);
    const result = await runExec({
      provider: fakeProvider({ maxOutputBytes: 4_096 }),
      args: [big],
      cwd: workflowDir,
    });
    expect(result.truncated).toBe(true);
    expect(result.error).toBe("output_truncated");
    expect(result.ok).toBe(false);
    expect(result.stdout.length).toBeLessThan(big.length);
  });
});

describe("exec/runner — checkCwdScope", () => {
  test("absolute cwd inside allowed workflow root: ok", () => {
    const r = checkCwdScope(workflowDir, fakeProvider(), {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(r.ok).toBe(true);
  });

  test("subdirectory of workflow root: ok", () => {
    const sub = join(workflowDir, "strategies", "v1");
    mkdirSync(sub, { recursive: true });
    const r = checkCwdScope(sub, fakeProvider(), {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(r.ok).toBe(true);
  });

  test("relative cwd rejected", () => {
    const r = checkCwdScope("relative/path", fakeProvider(), {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("absolute");
  });

  test("cwd with .. is rejected even before resolve", () => {
    const tricky = join(workflowDir, "..", "..", "other-workflow");
    const r = checkCwdScope(tricky, fakeProvider(), {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(r.ok).toBe(false);
  });

  test("cwd escaping allowed root rejected", () => {
    const escapingPath = join(EFFECTIVE_DATA_DIR, "projects", "other-project");
    mkdirSync(escapingPath, { recursive: true });
    const r = checkCwdScope(escapingPath, fakeProvider(), {
      projectId: PROJECT_ID,
      workflowId: WORKFLOW_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("escapes");
  });

  test("workflow-scoped without projectId/workflowId rejected", () => {
    const r = checkCwdScope(workflowDir, fakeProvider(), {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("workflowId missing");
  });

  test("data-dir-scoped allows broader path", () => {
    const provider = fakeProvider({ workdirStrategy: "data-dir-scoped" });
    const r = checkCwdScope(EFFECTIVE_DATA_DIR, provider, {});
    expect(r.ok).toBe(true);
  });

  test("project-scoped allows project root but not other project", () => {
    const provider = fakeProvider({ workdirStrategy: "project-scoped" });
    const projectDir = join(EFFECTIVE_DATA_DIR, "projects", PROJECT_ID);
    mkdirSync(projectDir, { recursive: true });
    const ok = checkCwdScope(projectDir, provider, { projectId: PROJECT_ID });
    expect(ok.ok).toBe(true);

    const otherProject = join(EFFECTIVE_DATA_DIR, "projects", "other-proj");
    mkdirSync(otherProject, { recursive: true });
    const bad = checkCwdScope(otherProject, provider, { projectId: PROJECT_ID });
    expect(bad.ok).toBe(false);
  });
});

describe("exec/runner — checkArgs", () => {
  test("clean args: ok", () => {
    const r = checkArgs(fakeProvider(), ["status", "-s", "--porcelain"]);
    expect(r.ok).toBe(true);
  });

  test("shell metachar `;` rejected", () => {
    const r = checkArgs(fakeProvider(), ["status; rm -rf /"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("metachar");
  });

  test("shell metachar `|` rejected", () => {
    const r = checkArgs(fakeProvider(), ["log", "--all | head"]);
    expect(r.ok).toBe(false);
  });

  test("backtick rejected", () => {
    const r = checkArgs(fakeProvider(), ["`whoami`"]);
    expect(r.ok).toBe(false);
  });

  test("$() rejected", () => {
    const r = checkArgs(fakeProvider(), ["$(id)"]);
    expect(r.ok).toBe(false);
  });

  test("allowFreeformArgs=false rejects unlisted subcommand", () => {
    const restricted = fakeProvider({
      allowFreeformArgs: false,
      allowedSubcommands: ["status", "diff", "log"],
    });
    expect(checkArgs(restricted, ["status"]).ok).toBe(true);
    expect(checkArgs(restricted, ["push"]).ok).toBe(false);
    expect(checkArgs(restricted, ["push"]).reason).toContain("not in allowedSubcommands");
  });
});

describe("exec/runner — renderArgTemplate", () => {
  test("substitutes {prompt} and {cwd}", () => {
    const args = renderArgTemplate(["-p", "{prompt}", "--cwd", "{cwd}"], {
      prompt: "do the thing",
      cwd: "/tmp/x",
    });
    expect(args).toEqual(["-p", "do the thing", "--cwd", "/tmp/x"]);
  });

  test("expands {files...} into multiple args", () => {
    const args = renderArgTemplate(["agent", "{prompt}", "--", "{files...}"], {
      prompt: "task",
      cwd: "/tmp/x",
      files: ["a.ts", "b.ts", "c.ts"],
    });
    expect(args).toEqual(["agent", "task", "--", "a.ts", "b.ts", "c.ts"]);
  });

  test("{files...} with empty list omits the slot", () => {
    const args = renderArgTemplate(["--", "{files...}"], { prompt: "p", cwd: "/c" });
    expect(args).toEqual(["--"]);
  });
});

describe("exec/runner — filterEnv", () => {
  test("only allowlisted env vars are passed", () => {
    process.env.QUBIT_EXEC_TEST_SECRET = "leaked-secret";
    process.env.QUBIT_EXEC_TEST_HOME = "/home/x";
    const env = filterEnv(fakeProvider({ envAllowlist: ["QUBIT_EXEC_TEST_HOME"] }));
    expect(env.QUBIT_EXEC_TEST_HOME).toBe("/home/x");
    expect(env.QUBIT_EXEC_TEST_SECRET).toBeUndefined();
    process.env.QUBIT_EXEC_TEST_SECRET = undefined;
    process.env.QUBIT_EXEC_TEST_HOME = undefined;
  });
});

describe("exec/registry", () => {
  test("built-in providers include git, jq, rg, duckdb, claude-code, aider", async () => {
    const all = await listExecProviders();
    const ids = all.map((p) => p.id).sort();
    for (const must of ["git", "jq", "rg", "duckdb", "claude-code", "aider"]) {
      expect(ids).toContain(must);
    }
  });

  test("getExecProvider filters by kind", async () => {
    const gitShell = await getExecProvider("git", "shell");
    expect(gitShell?.id).toBe("git");

    const gitAsCliAgent = await getExecProvider("git", "cli_agent");
    expect(gitAsCliAgent).toBeNull();

    const claudeCli = await getExecProvider("claude-code", "cli_agent");
    expect(claudeCli?.id).toBe("claude-code");

    const claudeShell = await getExecProvider("claude-code", "shell");
    expect(claudeShell).toBeNull();
  });

  test("user override file: adds new binary + replaces built-in", async () => {
    const overridePath = join(EFFECTIVE_DATA_DIR, "exec-providers.json");
    writeFileSync(
      overridePath,
      JSON.stringify([
        {
          id: "yq",
          kind: "shell",
          description: "YAML processor (user-added)",
          command: "yq",
          outputProtocol: "text",
          defaultTimeoutMs: 10_000,
          maxOutputBytes: 65536,
          envAllowlist: ["HOME"],
          workdirStrategy: "workflow-scoped",
        },
        {
          // 整条替换内置的 jq（仅改 defaultTimeoutMs 看是否生效）
          id: "jq",
          kind: "shell",
          description: "jq with bumped timeout",
          command: "jq",
          outputProtocol: "text",
          defaultTimeoutMs: 99_999,
          maxOutputBytes: 65536,
          envAllowlist: ["HOME"],
          workdirStrategy: "workflow-scoped",
        },
      ])
    );
    resetExecProviderRegistry();
    const map = await loadExecProviders();
    expect(map.has("yq")).toBe(true);
    expect(map.get("jq")?.defaultTimeoutMs).toBe(99_999);
    expect(map.get("jq")?.description).toBe("jq with bumped timeout");
    // git 未被覆盖：仍是内置默认描述（中文）
    expect(map.get("git")?.description).toContain("工作流");

    // 清理避免影响后续 case
    rmSync(overridePath, { force: true });
  });

  test("malformed user override does not break built-in defaults", async () => {
    const overridePath = join(EFFECTIVE_DATA_DIR, "exec-providers.json");
    writeFileSync(overridePath, "{ not valid json");
    resetExecProviderRegistry();
    const map = await loadExecProviders();
    // 内置仍可用
    expect(map.has("git")).toBe(true);
    expect(map.has("claude-code")).toBe(true);
    rmSync(overridePath, { force: true });
  });
});
