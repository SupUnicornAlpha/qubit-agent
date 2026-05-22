/**
 * Python 运行时统一入口 — 解释器解析 + 启动期健康自检
 *
 * 背景：项目里有 5 个独立模块各自 spawn python3 子进程（沙箱 / qlib / signal /
 * backtest / signal-runner），历史上都硬编码了 "python3"，跳过了 bootstrap 创建的
 * venv（~/.quant-agent/python-venv/），导致系统 python 没装 pandas/numpy 时
 * 用户在 chat 里看到一长串 ModuleNotFoundError，且没有任何运维提示。
 *
 * 本模块做两件事：
 *  1) `getPythonBin()` —— 统一走 `resolvePythonBin(config.dataDir)`
 *     （显式 QUBIT_PYTHON env → 资源 venv → 数据目录 venv → 系统 python3）。
 *  2) `checkPythonHealth()` —— 进程内缓存的探针：探测解释器、版本、关键依赖
 *     （pandas/numpy/scipy）。失败时给出可操作的修复指引，前端可在"系统设置"
 *     展示，沙箱可以在第一次调用前 fail-fast 返回结构化错误。
 */

import { config } from "../../config";
import { resolvePythonBin } from "../app-paths";

export interface PythonDepStatus {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  /**
   * `true`：必需依赖（pandas / numpy），缺失则 `report.ok = false`，沙箱 fail-fast。
   * `false`：可选依赖（scipy 等），缺失只在 hint 里提示，不阻断沙箱启动。
   */
  required: boolean;
}

export interface PythonHealthReport {
  ok: boolean;
  binPath: string;
  /** "system" | "venv" | "explicit"，便于前端区分来源 */
  binKind: "system" | "venv" | "explicit";
  pythonVersion?: string;
  /** 关键科学计算依赖（沙箱 `code.run_python` 用到） */
  dependencies: PythonDepStatus[];
  /** 第一条机器友好的错误码 */
  errorCode?:
    | "python_unavailable"
    | "python_exit_nonzero"
    | "python_deps_missing"
    | "probe_timeout";
  /** 人类可读修复建议 */
  hint?: string;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60_000;
const REQUIRED_DEPS = ["pandas", "numpy"] as const;
const OPTIONAL_DEPS = ["scipy"] as const;

let cached: { at: number; report: PythonHealthReport } | null = null;
let inflight: Promise<PythonHealthReport> | null = null;

export function getPythonBin(): string {
  return resolvePythonBin(config.dataDir);
}

function classifyBin(bin: string): PythonHealthReport["binKind"] {
  if (process.env["QUBIT_PYTHON"]?.trim() === bin) return "explicit";
  if (bin.includes("python-venv")) return "venv";
  return "system";
}

function buildHint(report: Omit<PythonHealthReport, "hint">): string | undefined {
  if (report.errorCode === "python_unavailable") {
    return [
      `Python 解释器不可用：${report.binPath}`,
      "请安装 Python 3.10+，或执行系统初始化（POST /system/bootstrap 或 `bun src/cli.ts bootstrap`）",
      "在数据目录创建 venv 并安装 python_connectors/requirements.txt。",
    ].join(" ");
  }
  if (report.errorCode === "python_deps_missing") {
    const missing = report.dependencies.filter((d) => !d.available).map((d) => d.name);
    return [
      `当前 Python (${report.binPath}) 缺少依赖：${missing.join(", ")}。`,
      "建议执行 `bun src/cli.ts bootstrap` 创建 venv 并 pip install；",
      "或在已有 venv 内手动 `pip install -r python_connectors/requirements.txt`，",
      "并通过 QUBIT_PYTHON 指向该解释器。",
    ].join(" ");
  }
  if (report.errorCode === "probe_timeout") {
    return `Python 解释器探针超时（${PROBE_TIMEOUT_MS}ms），检查 ${report.binPath} 是否被防病毒/沙箱拦截。`;
  }
  if (report.errorCode === "python_exit_nonzero") {
    return `Python 解释器以非零退出码退出，请手动运行 \`${report.binPath} --version\` 排查。`;
  }
  return undefined;
}

async function runProbe(bin: string): Promise<{
  ok: boolean;
  exit: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
}> {
  /*
   * 一次性 probe：打印 sys.version + 每个候选依赖的 import 结果（JSON）。
   * 这样一次 spawn 就拿到全部信息，避免多次启动 python 解释器的开销。
   */
  const reqJson = JSON.stringify([...REQUIRED_DEPS, ...OPTIONAL_DEPS]);
  const code =
    `import json,sys\n` +
    `mods=${reqJson}\n` +
    `out={"version":sys.version.split()[0],"deps":{}}\n` +
    `for m in mods:\n` +
    `  try:\n` +
    `    mod=__import__(m)\n` +
    `    v=getattr(mod,'__version__',None)\n` +
    `    out["deps"][m]={"ok":True,"version":v}\n` +
    `  except Exception as e:\n` +
    `    out["deps"][m]={"ok":False,"error":str(e)[:200]}\n` +
    `print(json.dumps(out))`;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "-c", code], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, exit: -1, stdout: "", stderr: "", spawnError: (e as Error).message };
  }

  const work = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  const wall = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS)
  );
  const winner = await Promise.race([work, wall]);
  if (winner === "timeout") {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return { ok: false, exit: -2, stdout: "", stderr: "probe_timeout" };
  }
  const [stdout, stderr, exit] = winner;
  return { ok: exit === 0, exit, stdout, stderr };
}

/** 仅在值非 undefined 时插入 key —— 兼容 tsconfig exactOptionalPropertyTypes */
function withOpt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

async function probeOnce(): Promise<PythonHealthReport> {
  const binPath = getPythonBin();
  const binKind = classifyBin(binPath);
  const checkedAt = new Date().toISOString();

  const probe = await runProbe(binPath);

  if (probe.spawnError) {
    const requiredSet = new Set<string>(REQUIRED_DEPS);
    const base: Omit<PythonHealthReport, "hint"> = {
      ok: false,
      binPath,
      binKind,
      dependencies: [...REQUIRED_DEPS, ...OPTIONAL_DEPS].map((name) => ({
        name,
        available: false,
        required: requiredSet.has(name),
        error: "python_unavailable",
      })),
      errorCode: "python_unavailable",
      checkedAt,
    };
    return { ...base, ...withOpt("hint", buildHint(base)) };
  }

  if (probe.exit === -2) {
    const base: Omit<PythonHealthReport, "hint"> = {
      ok: false,
      binPath,
      binKind,
      dependencies: [],
      errorCode: "probe_timeout",
      checkedAt,
    };
    return { ...base, ...withOpt("hint", buildHint(base)) };
  }

  if (!probe.ok || !probe.stdout.trim()) {
    const base: Omit<PythonHealthReport, "hint"> = {
      ok: false,
      binPath,
      binKind,
      dependencies: [],
      errorCode: "python_exit_nonzero",
      checkedAt,
    };
    return { ...base, ...withOpt("hint", buildHint(base)) };
  }

  let parsed: {
    version?: string;
    deps?: Record<string, { ok: boolean; version?: string; error?: string }>;
  };
  try {
    parsed = JSON.parse(probe.stdout.trim()) as typeof parsed;
  } catch {
    const base: Omit<PythonHealthReport, "hint"> = {
      ok: false,
      binPath,
      binKind,
      dependencies: [],
      errorCode: "python_exit_nonzero",
      checkedAt,
    };
    return { ...base, ...withOpt("hint", buildHint(base)) };
  }

  const depsRaw = parsed.deps ?? {};
  const requiredSet = new Set<string>(REQUIRED_DEPS);
  const dependencies: PythonDepStatus[] = [...REQUIRED_DEPS, ...OPTIONAL_DEPS].map((name) => {
    const info = depsRaw[name];
    const required = requiredSet.has(name);
    return info?.ok
      ? { name, available: true, required, ...withOpt("version", info.version) }
      : { name, available: false, required, ...withOpt("error", info?.error) };
  });

  const requiredMissing = dependencies.filter(
    (d) => !d.available && (REQUIRED_DEPS as readonly string[]).includes(d.name)
  );

  if (requiredMissing.length > 0) {
    const base: Omit<PythonHealthReport, "hint"> = {
      ok: false,
      binPath,
      binKind,
      ...withOpt("pythonVersion", parsed.version),
      dependencies,
      errorCode: "python_deps_missing",
      checkedAt,
    };
    return { ...base, ...withOpt("hint", buildHint(base)) };
  }

  /*
   * 必需依赖齐全的情况下：即使 ok=true，也帮用户补一个 hint 提示可选依赖缺失。
   * 这样运行时卡片只看 ok 是绿灯，但 hint 字段把"可以但建议补装"的细节也传出去。
   */
  const optionalMissing = dependencies.filter((d) => !d.available && !d.required);
  const okHint =
    optionalMissing.length > 0
      ? `必需依赖已就绪；可选依赖缺失：${optionalMissing.map((d) => d.name).join(", ")}（不影响沙箱基本运行）`
      : undefined;

  return {
    ok: true,
    binPath,
    binKind,
    ...withOpt("pythonVersion", parsed.version),
    dependencies,
    ...withOpt("hint", okHint),
    checkedAt,
  };
}

/**
 * 取缓存的 Python 运行时健康报告；超过 60s 自动重新探测。
 * 调用方应区分 `report.ok`：
 *  - `true`：可正常 spawn 跑 pandas / numpy
 *  - `false`：建议 fail-fast 返回 `report.errorCode` + `report.hint` 给上层
 */
export async function checkPythonHealth(opts?: { force?: boolean }): Promise<PythonHealthReport> {
  const force = opts?.force === true;
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.report;
  }
  if (!force && inflight) return inflight;
  inflight = probeOnce()
    .then((report) => {
      cached = { at: Date.now(), report };
      return report;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 测试钩子：手动清缓存 */
export function _resetPythonHealthCache(): void {
  cached = null;
  inflight = null;
}
