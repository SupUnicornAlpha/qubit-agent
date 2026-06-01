/**
 * EnvironmentManager 顶层 status 聚合 —— 给前端 Dashboard / 顶部 statusbar。
 *
 * 决策点（DESIGN §6.5 / 决议 §10.4）：
 *   - **必需包**（optional=false）missing 或 versionMismatch → ok=false
 *   - **可选包**（optional=true）missing → ok 仍 true，但 summary 给 warn 提示
 *   - connector probe 不影响 ok 判定（参见 connector-probes.ts header）
 *   - python_runtime 探测失败时也给 ok=false（pip 依赖必装核心都跑不起来）
 */

import { config } from "../../config";
import { resolvePythonBin } from "../app-paths";
import { listConnectorProbes, type ConnectorProbe } from "./connector-probes";
import { buildNpmDiff } from "./npm-deps";
import { buildPythonDiff } from "./python-deps";
import type { ExpectedPackage, PackageDiff } from "./types";

export type EnvironmentOk = "ok" | "warn" | "error";

export interface EnvironmentStatus {
  ok: EnvironmentOk;
  /** 4-6 字短摘要：环境就绪 / 缺少可选包 / 必需包缺失 / Python 不可用 */
  summary: string;
  pythonBin: string;
  python: PackageDiff & { hasPipFailure: boolean };
  npm: PackageDiff;
  connectors: ConnectorProbe[];
  generatedAt: string;
}

function classify(diff: PackageDiff): { hasMissingRequired: boolean; hasMismatchRequired: boolean } {
  const isReq = (p: ExpectedPackage) => !p.optional;
  return {
    hasMissingRequired: diff.missing.some(isReq),
    hasMismatchRequired: diff.versionMismatch.some((m) => isReq(m.expected)),
  };
}

/**
 * 收集 python diff、npm diff、connector probes，做顶层 ok 决策。
 *
 * 任何一步失败都被吞住（落到 hasPipFailure 之类的 flag），保证 status API
 * 不至于因 connector / pip 的 transient 故障返回 5xx。
 */
export async function getEnvironmentStatus(): Promise<EnvironmentStatus> {
  const pythonBin = resolvePythonBin(config.dataDir);

  let pythonDiff: PackageDiff & { hasPipFailure: boolean };
  try {
    const d = await buildPythonDiff();
    pythonDiff = { ...d, hasPipFailure: false };
  } catch (e) {
    console.warn(`[env-status] python diff failed: ${(e as Error).message}`);
    pythonDiff = {
      expected: [],
      installed: [],
      satisfied: [],
      missing: [],
      versionMismatch: [],
      orphan: [],
      hasPipFailure: true,
    };
  }

  let npmDiff: PackageDiff;
  try {
    npmDiff = await buildNpmDiff();
  } catch (e) {
    console.warn(`[env-status] npm diff failed: ${(e as Error).message}`);
    npmDiff = {
      expected: [],
      installed: [],
      satisfied: [],
      missing: [],
      versionMismatch: [],
      orphan: [],
    };
  }

  let connectors: ConnectorProbe[] = [];
  try {
    connectors = await listConnectorProbes();
  } catch (e) {
    console.warn(`[env-status] connector probes failed: ${(e as Error).message}`);
  }

  const py = classify(pythonDiff);
  const np = classify(npmDiff);

  let ok: EnvironmentOk = "ok";
  let summary = "环境就绪";
  if (pythonDiff.hasPipFailure) {
    ok = "error";
    summary = "Python 不可用：pip list 失败";
  } else if (py.hasMissingRequired || py.hasMismatchRequired || np.hasMissingRequired) {
    ok = "error";
    summary = "必需包缺失或版本不匹配";
  } else if (
    pythonDiff.missing.length > 0 ||
    pythonDiff.versionMismatch.length > 0 ||
    npmDiff.missing.length > 0 ||
    npmDiff.versionMismatch.length > 0
  ) {
    ok = "warn";
    summary = "可选包未装或版本提示";
  }

  return {
    ok,
    summary,
    pythonBin,
    python: pythonDiff,
    npm: npmDiff,
    connectors,
    generatedAt: new Date().toISOString(),
  };
}
