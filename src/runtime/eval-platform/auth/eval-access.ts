export type EvalPlatformAction = "view" | "annotate" | "export_golden" | "admin";

export type EvalPlatformRole = "viewer" | "annotator" | "eval_admin";

const ROLE_RANK: Record<EvalPlatformRole, number> = {
  viewer: 1,
  annotator: 2,
  eval_admin: 3,
};

const ACTION_MIN_ROLE: Record<EvalPlatformAction, EvalPlatformRole> = {
  view: "viewer",
  annotate: "annotator",
  export_golden: "annotator",
  admin: "eval_admin",
};

function rbacEnabled(): boolean {
  const v = (process.env.QUBIT_EVAL_RBAC_ENABLED ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function resolveActorRole(actor?: string): EvalPlatformRole {
  if (!actor) return "annotator";
  const raw = process.env.QUBIT_EVAL_ROLE_MAP?.trim();
  if (!raw) return "annotator";
  try {
    const map = JSON.parse(raw) as Record<string, EvalPlatformRole>;
    return map[actor] ?? "viewer";
  } catch {
    return "viewer";
  }
}

export function assertEvalPlatformAccess(input: {
  action: EvalPlatformAction;
  actor?: string;
}): void {
  if (!rbacEnabled()) return;
  const role = resolveActorRole(input.actor);
  const required = ACTION_MIN_ROLE[input.action];
  if (ROLE_RANK[role] < ROLE_RANK[required]) {
    throw new Error(`eval_platform_forbidden:${input.action}:${role}`);
  }
}
