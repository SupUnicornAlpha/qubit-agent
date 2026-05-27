/**
 * 2026-05-27 P2 修复回归测试：
 *
 * WF a09e90c5 实测：def-analyst-technical 调 code.run_python 报
 * `python_exit_nonzero`，trace 里写"请手动运行
 * `<repo>/src-tauri/target/debug/bundle/python-venv/bin/python3 --version`"。
 * 那条 python3 是 Tauri 打包过的软链，dyld 找不到 Python3 framework 直接 abort。
 *
 * 根因：`resolvePythonBin` 只 `existsSync` 判断，没验证候选能 spawn 起来。
 * 修复后：existsSync + `--version` 探针，spawn 失败的候选自动跳过。
 *
 * 本测试不依赖真实文件系统状态，只验证：
 *   1. QUBIT_PYTHON 显式指定 → 直接用，不探针（行为最直接）
 *   2. 候选都不存在 → fallback 到系统 `python3`
 *   3. 进程内缓存有效（同一 bin 多次问只 spawn 一次）
 *   4. _resetPythonBinCacheForTest 能清掉缓存
 *
 * 真实的"坏 venv 跳过"行为依赖 src-tauri 软链 + dyld 错误，
 * 不在单测里复现（属于集成层），但代码路径覆盖到了。
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetPythonBinCacheForTest, resolvePythonBin } from "../app-paths";

const ORIGINAL_QUBIT_PYTHON = process.env["QUBIT_PYTHON"];
const ORIGINAL_QUBIT_APP_ROOT = process.env["QUBIT_APP_ROOT"];

describe("resolvePythonBin", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "qubit-pybin-"));
    delete process.env["QUBIT_PYTHON"];
    process.env["QUBIT_APP_ROOT"] = tmp;
    _resetPythonBinCacheForTest();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (ORIGINAL_QUBIT_PYTHON === undefined) delete process.env["QUBIT_PYTHON"];
    else process.env["QUBIT_PYTHON"] = ORIGINAL_QUBIT_PYTHON;
    if (ORIGINAL_QUBIT_APP_ROOT === undefined) delete process.env["QUBIT_APP_ROOT"];
    else process.env["QUBIT_APP_ROOT"] = ORIGINAL_QUBIT_APP_ROOT;
    _resetPythonBinCacheForTest();
  });

  it("QUBIT_PYTHON 显式指定 → 直接返回，不做探针", () => {
    process.env["QUBIT_PYTHON"] = "/fake/python3";
    expect(resolvePythonBin(tmp)).toBe("/fake/python3");
  });

  it("候选都不存在 → 退回到系统 python3 / python.exe", () => {
    const out = resolvePythonBin(tmp);
    expect(out).toBe(process.platform === "win32" ? "python" : "python3");
  });

  it("坏 venv 候选（exists 但 spawn 非零退出）自动跳过", () => {
    /**
     * 在 appRoot/python-venv/bin/python3 放一个一定退出 1 的 shell 脚本，
     * 模拟"软链坏掉"场景；resolvePythonBin 应跳过它去用系统 python3。
     */
    const badDir = join(tmp, "python-venv", "bin");
    mkdirSync(badDir, { recursive: true });
    const badBin = join(badDir, "python3");
    writeFileSync(badBin, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(badBin, 0o755);

    const out = resolvePythonBin(tmp);
    expect(out).not.toBe(badBin);
    expect(out).toBe("python3");
  });

  it("好 venv 候选 (exit 0) 会被选用", () => {
    /**
     * `/bin/sh -c "exit 0"` 的脚本：
     */
    const goodDir = join(tmp, "python-venv", "bin");
    mkdirSync(goodDir, { recursive: true });
    const goodBin = join(goodDir, "python3");
    writeFileSync(goodBin, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(goodBin, 0o755);

    expect(resolvePythonBin(tmp)).toBe(goodBin);
  });

  it("缓存命中 — 同一坏 bin 不会被反复 spawn", () => {
    const badDir = join(tmp, "python-venv", "bin");
    mkdirSync(badDir, { recursive: true });
    const badBin = join(badDir, "python3");
    writeFileSync(badBin, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(badBin, 0o755);

    // 第一次：探针 + 缓存
    expect(resolvePythonBin(tmp)).toBe("python3");
    // 把坏脚本改成"好"，如果第二次不复用缓存就会被选中；缓存命中则不会
    writeFileSync(badBin, "#!/bin/sh\nexit 0\n", "utf8");
    expect(resolvePythonBin(tmp)).toBe("python3");

    // 清缓存后才会重新探针
    _resetPythonBinCacheForTest();
    expect(resolvePythonBin(tmp)).toBe(badBin);
  });
});
