/**
 * Answer schema check for finalize / DeliveryVerdict.
 * Prefer labeled sections; fall back to heading-like markers in Markdown.
 */

import type { AnswerSchemaPredicate } from "./types";

const SECTION_ALIASES: Record<string, string[]> = {
  goal: ["goal", "目标", "任务目标", "任务"],
  evidence: ["evidence", "证据", "依据", "事实"],
  decision: ["decision", "决策", "结论", "推荐", "动作"],
  risks: ["risks", "risk", "风险", "风控"],
  gaps: ["gaps", "gap", "缺口", "缺失", "待补"],
};

export function assertAnswerSchema(
  schema: AnswerSchemaPredicate,
  text: string | null | undefined
): { schemaOk: boolean; missingSections: string[] } {
  const body = (text ?? "").trim();
  if (!body) {
    return { schemaOk: false, missingSections: [...schema.requiredSections] };
  }
  if (schema.minChars != null && body.length < schema.minChars) {
    return { schemaOk: false, missingSections: [...schema.requiredSections] };
  }

  const missing: string[] = [];
  for (const section of schema.requiredSections) {
    if (!sectionPresent(body, section)) missing.push(section);
  }

  if (schema.mustIncludeTerms && schema.mustIncludeTerms.length > 0) {
    const lower = body.toLowerCase();
    for (const term of schema.mustIncludeTerms) {
      if (!lower.includes(term.toLowerCase()) && !body.includes(term)) {
        missing.push(`term:${term}`);
      }
    }
  }

  return { schemaOk: missing.length === 0, missingSections: missing };
}

function sectionPresent(body: string, section: string): boolean {
  const aliases = SECTION_ALIASES[section.toLowerCase()] ?? [section];
  const patterns = aliases.flatMap((alias) => [
    new RegExp(`(^|\\n)\\s{0,3}#{1,3}\\s*${escapeRegExp(alias)}\\b`, "i"),
    new RegExp(`(^|\\n)\\s*${escapeRegExp(alias)}\\s*[:：]`, "i"),
    new RegExp(`\\*\\*\\s*${escapeRegExp(alias)}\\s*\\*\\*`, "i"),
    new RegExp(`"${escapeRegExp(alias)}"\\s*:`, "i"),
  ]);
  return patterns.some((re) => re.test(body));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
