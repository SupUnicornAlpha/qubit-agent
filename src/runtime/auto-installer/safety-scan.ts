/**
 * W3（2026-06-11）：AutoInstaller 候选安全扫描 —— 在 propose 之前对 external
 * （source='registry' / 'fsi'）来源做静态检查。
 *
 * 背景：
 *   P8/P9 现状下 builtin 候选可以走 auto 模式直接安装；external 来源的 propose
 *   走人工审批，但 proposal payload 仍可能携带可疑 command（npm registry 上 typo
 *   squat / supply-chain attack）。审批人面对几十条 proposal 也没耐心一条条审 cmd。
 *
 *   本扫描器在 proposal 写入前做：
 *     1. 黑名单 slug：直接 block，不写 proposal（写也是徒增噪音）。
 *     2. 命令注入静态检查：`rm -rf /`、`curl ... | bash`、`base64 -d`、命令替换 `$(...)` 等。
 *     3. URL 必须 https / wss（http / ws 标 warning，不 block；本地 dev MCP 也用 http）。
 *     4. external 来源的最低 score / safetyLevel：score < 0.4 或 safety='high' → block。
 *     5. payload.command 长度兜底（>4KB block，避免奇怪的内联脚本）。
 *
 * 设计：
 *   - 纯函数，不 IO，给定输入永远输出相同结果。
 *   - 返回结构化 `SafetyScanResult`，不 throw；caller 决定是 propose / block / fall through。
 *   - 黑名单可注入（部署侧扩展）。
 */

import type { CatalogSource, MatchCandidate, ProposalSafetyLevel } from "./types";

export interface SafetyScanResult {
  /** 终判：true 才允许进 propose */
  ok: boolean;
  /** 阻断原因（出现一项即 ok=false）。每项形如 `blacklist:<slug>` / `dangerous_command:rm-rf` */
  blockers: string[];
  /** 非阻断告警，建议给前端 / proposal payload 显示 */
  warnings: string[];
}

export interface SafetyScanOptions {
  /** 完全 block 的 slug 列表（来源：管理员黑名单 + 已知 supply-chain 受损包） */
  blacklistSlugs?: ReadonlyArray<string>;
  /** external（registry/fsi）来源候选的最低分数；默认 0.4 */
  minExternalScore?: number;
  /** payload.command 最大字节数；默认 4096 */
  maxCommandBytes?: number;
}

const DEFAULT_BLACKLIST_SLUGS: ReadonlyArray<string> = [
  // 历史 supply-chain 受损包占位；具体名单由部署管理员维护
  "mcp-evil",
  "test-malicious",
];

const DEFAULT_MIN_EXTERNAL_SCORE = 0.4;
const DEFAULT_MAX_COMMAND_BYTES = 4 * 1024;

/**
 * 危险命令模式（每项 [pattern, label]）。
 * 用 RegExp 而非全字符串包含，避免误伤正常命令里的子串
 * （如 `npx -y @org/pkg` 中没有 `rm -rf`）。
 */
const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+-r[fF]?\b/, "rm_recursive"],
  [/\bcurl\s+[^|]+\|\s*(bash|sh)\b/i, "curl_pipe_shell"],
  [/\bwget\s+[^|]+\|\s*(bash|sh)\b/i, "wget_pipe_shell"],
  [/\bbase64\s+-[dD]\b/, "base64_decode_inline"],
  [/`[^`]+`/, "backtick_substitution"],
  [/\$\([^)]+\)/, "command_substitution"],
  [/\bsudo\b/, "sudo"],
  [/>\s*\/dev\/(tcp|udp)/i, "dev_socket_redirect"],
  [/\beval\b/, "eval"],
];

function checkBlacklist(
  slug: string,
  blacklist: ReadonlyArray<string>
): string | null {
  const lower = slug.toLowerCase();
  for (const banned of blacklist) {
    if (banned.toLowerCase() === lower) return `blacklist:${banned}`;
  }
  return null;
}

function checkDangerousCommand(command: string): string[] {
  const blockers: string[] = [];
  for (const [pattern, label] of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) blockers.push(`dangerous_command:${label}`);
  }
  return blockers;
}

function isExternalSource(source: CatalogSource): boolean {
  return source !== "builtin";
}

function safetyLevelRank(level: ProposalSafetyLevel): number {
  if (level === "low") return 0;
  if (level === "medium") return 1;
  return 2;
}

export function scanCandidate(
  candidate: MatchCandidate,
  opts: SafetyScanOptions = {}
): SafetyScanResult {
  const blacklist = opts.blacklistSlugs ?? DEFAULT_BLACKLIST_SLUGS;
  const minScore = opts.minExternalScore ?? DEFAULT_MIN_EXTERNAL_SCORE;
  const maxBytes = opts.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const slugBlock = checkBlacklist(candidate.targetSlug, blacklist);
  if (slugBlock) blockers.push(slugBlock);

  const cmd = (candidate.payload.command ?? "").trim();
  if (cmd) {
    if (Buffer.byteLength(cmd, "utf-8") > maxBytes) {
      blockers.push(`command_too_long:${Buffer.byteLength(cmd, "utf-8")}b`);
    }
    blockers.push(...checkDangerousCommand(cmd));
  }

  const url = (candidate.payload.url ?? "").trim();
  if (url) {
    const lower = url.toLowerCase();
    const isSecure = lower.startsWith("https://") || lower.startsWith("wss://");
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
    if (!isSecure) {
      if (isLoopback) {
        // 本地 dev / 自己跑的 MCP 用 http://localhost 是合法 use-case
        warnings.push("insecure_url_loopback");
      } else {
        blockers.push("insecure_url");
      }
    }
  }

  if (isExternalSource(candidate.source)) {
    if (candidate.score < minScore) {
      blockers.push(`external_score_too_low:${candidate.score}<${minScore}`);
    }
    if (safetyLevelRank(candidate.safetyLevel) >= safetyLevelRank("high")) {
      blockers.push(`external_safety_high:${candidate.safetyLevel}`);
    }
    if (candidate.safetyLevel === "medium") {
      warnings.push("external_safety_medium_review_carefully");
    }
  }

  return { ok: blockers.length === 0, blockers, warnings };
}
