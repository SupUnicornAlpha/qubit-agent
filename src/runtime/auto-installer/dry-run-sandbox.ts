/**
 * W3（2026-06-11）：候选 dry-run 沙箱接口 —— external 候选 propose 之前先做一次
 * 廉价"该 server 真能跑起来"的探针。
 *
 * 现状：
 *   AutoInstaller 现在无脑信 catalog 元数据，propose 出去的候选有可能：
 *     - command 在用户 PATH 里压根装不出来
 *     - npm 包名拼错（catalog 老化）
 *     - http URL 已经 404
 *   审批人手动跑一遍才能发现，损耗体验。
 *
 * 本沙箱：
 *   - 接口纯函数（DryRunFn），输入 payload，输出 ok/reason/elapsedMs。
 *   - default 实现（real）保留 TODO，先做"软成功"占位（return ok=true 加 warning='not_executed'），
 *     避免 W3 一上线就因为 spawn 协议未实现把所有 external propose 卡死。
 *   - installer 通过 deps 注入，单测可以传 mockDryRunner 直接覆盖 ok/timeout 路径。
 *
 * Roadmap：
 *   实际 spawn / tools/list 协议在后续 wave 接入；本 PR 只搭框架 + 让 installer 知道
 *   该 plug-in 这一层（reject 在审批前就能尽早表达）。
 */

import type { MatchCandidate } from "./types";

export interface DryRunResult {
  ok: boolean;
  /** 失败时的简短机读 reason；ok=true 时通常省略 */
  reason?: string;
  /** 当前是否真的执行了协议探针；false=只做了静态/接口占位 */
  executed: boolean;
  /** 探到的工具数（real impl 才会填） */
  toolCount?: number;
  /** 探针耗时；占位时 ≈ 0 */
  elapsedMs: number;
}

export type DryRunFn = (
  payload: MatchCandidate["payload"],
  opts?: { timeoutMs?: number }
) => Promise<DryRunResult>;

export interface DryRunSandboxOptions {
  /** 默认 10s 超时；real impl 用，占位 impl 忽略 */
  defaultTimeoutMs?: number;
}

/**
 * Default dry-runner —— 占位实现：不真 spawn，直接返回 `ok=true, executed=false`。
 *
 * 这样 W3 落地后所有 external candidates 都能正常进 propose（保持现有行为），
 * 但 caller 已经能区分"占位 vs 真探"，方便后续 wave 平滑替换。
 */
export function createDefaultDryRunner(_opts?: DryRunSandboxOptions): DryRunFn {
  return async (_payload, _runOpts) => ({
    ok: true,
    executed: false,
    elapsedMs: 0,
  });
}
