/**
 * P2-G：python-oneshot util 单测。
 *
 * 用 `/bin/sh -c '...'` 模拟 python 子进程，覆盖：
 *   - exit !=0 → PythonOneShotError(source='exit')
 *   - exit==0 + stdout 非 JSON → PythonOneShotError(source='parse')
 *   - exit==0 + stdout 合法 JSON → 成功
 *   - timeout → PythonOneShotError(source='timeout')
 *   - stdin payload 写入正确
 */
import { describe, expect, test } from "bun:test";
import { PythonOneShotError, runPythonOneShot, runPythonOneShotRaw } from "../python-oneshot";

describe("runPythonOneShot", () => {
  test("exit==0 + 合法 JSON → 解析成功", async () => {
    const r = await runPythonOneShot<{ ok: boolean; n: number }>({
      bin: "/bin/sh",
      scriptPath: "-c",
      args: [`printf '%s' '{"ok":true,"n":42}'`],
    });
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.n).toBe(42);
    expect(r.exitCode).toBe(0);
  });

  test("exit !=0 → 抛 PythonOneShotError(source='exit')", async () => {
    let caught: PythonOneShotError | null = null;
    try {
      await runPythonOneShot({
        bin: "/bin/sh",
        scriptPath: "-c",
        args: [`echo 'oops' >&2; exit 3`],
      });
    } catch (err) {
      if (err instanceof PythonOneShotError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.source).toBe("exit");
    expect(caught!.exitCode).toBe(3);
    expect(caught!.stderr).toContain("oops");
  });

  test("exit==0 但 stdout 非 JSON → 抛 PythonOneShotError(source='parse')", async () => {
    let caught: PythonOneShotError | null = null;
    try {
      await runPythonOneShot({
        bin: "/bin/sh",
        scriptPath: "-c",
        args: [`echo 'not json'`],
      });
    } catch (err) {
      if (err instanceof PythonOneShotError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.source).toBe("parse");
    expect(caught!.exitCode).toBe(0);
  });

  test("超时 → 抛 PythonOneShotError(source='timeout')", async () => {
    let caught: PythonOneShotError | null = null;
    try {
      await runPythonOneShot({
        bin: "/bin/sh",
        scriptPath: "-c",
        args: [`sleep 2; echo '{}'`],
        timeoutMs: 100,
      });
    } catch (err) {
      if (err instanceof PythonOneShotError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.source).toBe("timeout");
  });

  test("stdin payload 写入并被 python 端读取", async () => {
    /** /bin/sh 直接 cat stdin 模拟 python 端 sys.stdin.read() */
    const r = await runPythonOneShot<{ echoed: unknown }>({
      bin: "/bin/sh",
      scriptPath: "-c",
      args: [`echo "{\\"echoed\\": $(cat)}"`],
      stdinPayload: { hello: "world" },
    });
    expect(r.parsed.echoed).toEqual({ hello: "world" });
  });
});

describe("runPythonOneShotRaw", () => {
  test("--version 风格的健康检查", async () => {
    const r = await runPythonOneShotRaw({
      bin: "/bin/sh",
      scriptPath: "-c",
      args: [`echo 'Python 3.11.x'`],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Python");
  });

  test("exit !=0 抛错", async () => {
    let caught: PythonOneShotError | null = null;
    try {
      await runPythonOneShotRaw({
        bin: "/bin/sh",
        scriptPath: "-c",
        args: [`exit 1`],
      });
    } catch (err) {
      if (err instanceof PythonOneShotError) caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught!.source).toBe("exit");
    expect(caught!.exitCode).toBe(1);
  });
});
