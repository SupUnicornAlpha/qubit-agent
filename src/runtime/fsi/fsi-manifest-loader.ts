import { readFile } from "node:fs/promises";
import type { AgentRole } from "../../types/entities";
import { getBundledManifestPath, resolveEnabledFsiBundles } from "./fsi-config";
import type { FsiManifest } from "./fsi-types";

let cached: FsiManifest | null = null;

export async function loadFsiManifest(): Promise<FsiManifest> {
  if (cached) return cached;
  const raw = await readFile(getBundledManifestPath(), "utf-8");
  cached = JSON.parse(raw) as FsiManifest;
  return cached;
}

/** 当前配置下应启用的全部 skill id（bundle + role 默认 + workflow 融合） */
export async function resolveActiveFsiSkillIdsForRole(role: AgentRole): Promise<string[]> {
  const manifest = await loadFsiManifest();
  const bundles = resolveEnabledFsiBundles();
  const fromBundles = new Set<string>();
  for (const bundleId of bundles) {
    const bundle = manifest.bundles[bundleId];
    if (!bundle) continue;
    for (const id of bundle.skillIds) fromBundles.add(id);
  }
  const fromRole = manifest.roleSkillDefaults[role] ?? [];
  const fromWorkflows = new Set<string>();
  for (const wf of Object.values(manifest.agentWorkflows)) {
    if (!wf.fuseIntoRoles.includes(role)) continue;
    for (const id of wf.skillIds) fromWorkflows.add(id);
  }
  return [...new Set([...fromBundles, ...fromRole, ...fromWorkflows])];
}

export async function listActiveFsiSkillIds(): Promise<string[]> {
  const manifest = await loadFsiManifest();
  const roles = Object.keys(manifest.roleSkillDefaults) as AgentRole[];
  const all = new Set<string>();
  for (const role of roles) {
    for (const id of await resolveActiveFsiSkillIdsForRole(role)) all.add(id);
  }
  const bundles = resolveEnabledFsiBundles();
  for (const bundleId of bundles) {
    const bundle = manifest.bundles[bundleId];
    if (!bundle) continue;
    for (const id of bundle.skillIds) all.add(id);
  }
  return [...all];
}

export async function getFsiWorkflowPlaybookPathsForRole(
  role: AgentRole
): Promise<
  Array<{ slug: string; label: string; path: string; maxChars: number; searchText: string }>
> {
  const manifest = await loadFsiManifest();
  const out: Array<{
    slug: string;
    label: string;
    path: string;
    maxChars: number;
    searchText: string;
  }> = [];
  for (const [slug, wf] of Object.entries(manifest.agentWorkflows)) {
    if (!wf.fuseIntoRoles.includes(role)) continue;
    out.push({
      slug,
      label: wf.label,
      path: wf.playbookPath,
      maxChars: wf.playbookMaxChars ?? 3500,
      searchText: [
        slug,
        wf.label,
        ...wf.skillIds,
        ...(wf.steeringExamples ?? []).flatMap((example) => [
          example.event,
          example.description ?? "",
        ]),
      ].join(" "),
    });
  }
  return out;
}

export function resetFsiManifestCacheForTests(): void {
  cached = null;
}
