/**
 * Load ScenarioRecipe JSON from crates/qubit-policy/recipes/ (single source of truth).
 * Maps snake_case wire format → camelCase ScenarioRecipe used by TS runtime.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AnswerSchemaPredicate,
  ArtifactPredicate,
  CompletionPredicate,
  DataGapRecovery,
  RequiredToolPredicate,
  ScenarioRecipe,
  StallBudget,
  StallBudgetKey,
} from "./types";

/** Product recipes shared with TS runtime (open.json is Rust Core freeform only). */
const TS_RECIPE_FILES = [
  "stock_pick.json",
  "factor.json",
  "strategy.json",
  "research.json",
  "live_trading.json",
] as const;

function findRecipesDir(): string {
  const here =
    typeof import.meta.dir === "string"
      ? import.meta.dir
      : dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "crates/qubit-policy/recipes"),
    resolve(here, "../../../../crates/qubit-policy/recipes"),
    resolve(here, "../../../../../crates/qubit-policy/recipes"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `qubit-policy recipes dir not found (cwd=${process.cwd()}, tried=${candidates.join(", ")})`
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function mapStallBudget(raw: Record<string, unknown>): StallBudget {
  const keyRaw = String(raw.key ?? "tool_fingerprint");
  const key: StallBudgetKey =
    keyRaw === "tool" || keyRaw === "tool_market" || keyRaw === "tool_fingerprint"
      ? keyRaw
      : "tool_fingerprint";
  const onExceed =
    raw.on_exceed === "inject_recovery" ? "inject_recovery" : "strip_from_surface";
  return {
    tools: asStringArray(raw.tools),
    key,
    maxSuccess: Number(raw.max_success ?? 1) || 1,
    onExceed,
  };
}

function mapRecovery(raw: Record<string, unknown>): DataGapRecovery {
  const after = String(raw.after_probe_failure ?? "continue_without_realtime");
  const afterProbeFailure =
    after === "escalate_hitl" || after === "degrade_source" || after === "continue_without_realtime"
      ? after
      : "continue_without_realtime";
  return {
    afterProbeFailure,
    forbidGapAsFinalAnswer: true,
  };
}

function mapArtifact(raw: Record<string, unknown>): ArtifactPredicate {
  const scope = raw.scope === "project" ? "project" : "workflow";
  const out: ArtifactPredicate = {
    table: String(raw.table ?? ""),
    minRows: Number(raw.min_rows ?? 1) || 1,
    scope,
  };
  if (raw.research_min_rows !== undefined && raw.research_min_rows !== null) {
    out.researchMinRows = Number(raw.research_min_rows);
  }
  if (Array.isArray(raw.required_fields)) {
    out.requiredFields = asStringArray(raw.required_fields);
  }
  return out;
}

function mapRequiredTool(raw: Record<string, unknown>): RequiredToolPredicate {
  return {
    capability: String(raw.capability ?? ""),
    minSuccess: Number(raw.min_success ?? 1) || 1,
  };
}

function mapAnswerSchema(raw: Record<string, unknown>): AnswerSchemaPredicate {
  const out: AnswerSchemaPredicate = {
    requiredSections: asStringArray(raw.required_sections),
  };
  if (raw.min_chars !== undefined && raw.min_chars !== null) {
    out.minChars = Number(raw.min_chars);
  }
  return out;
}

function mapCompletion(raw: Record<string, unknown>): CompletionPredicate {
  const artifacts = Array.isArray(raw.artifacts)
    ? raw.artifacts.map((a) => mapArtifact(asRecord(a)))
    : [];
  const requiredTools = Array.isArray(raw.required_tools)
    ? raw.required_tools.map((t) => mapRequiredTool(asRecord(t)))
    : [];
  return {
    artifacts,
    requiredTools,
    answerSchema: mapAnswerSchema(asRecord(raw.answer_schema)),
  };
}

function mapStringMap(raw: unknown): Record<string, string> | undefined {
  const o = asRecord(raw);
  const keys = Object.keys(o);
  if (!keys.length) return undefined;
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (typeof o[k] === "string") out[k] = o[k] as string;
  }
  return Object.keys(out).length ? out : undefined;
}

function mapStringListMap(raw: unknown): Record<string, string[]> | undefined {
  const o = asRecord(raw);
  const keys = Object.keys(o);
  if (!keys.length) return undefined;
  const out: Record<string, string[]> = {};
  for (const k of keys) {
    out[k] = asStringArray(o[k]);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Parse one snake_case recipe JSON object into ScenarioRecipe. */
export function mapRecipeJson(raw: unknown): ScenarioRecipe {
  const o = asRecord(raw);
  const recipe: ScenarioRecipe = {
    key: String(o.key ?? ""),
    aliases: asStringArray(o.aliases),
    version: String(o.version ?? ""),
    stallBudget: mapStallBudget(asRecord(o.stall_budget)),
    recovery: mapRecovery(asRecord(o.recovery)),
    completion: mapCompletion(asRecord(o.completion)),
    checklistPrompt: asStringArray(o.checklist_prompt),
  };
  const owners = mapStringMap(o.capability_owners);
  if (owners) recipe.capabilityOwners = owners;
  const allow = mapStringListMap(o.role_tool_allowlist);
  if (allow) recipe.roleToolAllowlist = allow;
  return recipe;
}

let cached: ScenarioRecipe[] | null = null;

export function listLoadedRecipes(opts?: { forceReload?: boolean }): ScenarioRecipe[] {
  if (cached && !opts?.forceReload) return cached;
  const dir = findRecipesDir();
  const files = TS_RECIPE_FILES.filter((f) => existsSync(join(dir, f)));
  // Fall back to any *.json except open.json if the pin list is missing files.
  const toLoad =
    files.length > 0
      ? files
      : readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "open.json");
  const recipes: ScenarioRecipe[] = [];
  for (const file of toLoad) {
    const text = readFileSync(join(dir, file), "utf8");
    recipes.push(mapRecipeJson(JSON.parse(text) as unknown));
  }
  cached = recipes;
  return recipes;
}

export function clearRecipeJsonCache(): void {
  cached = null;
}
