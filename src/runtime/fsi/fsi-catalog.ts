import type { AgentRole } from "../../types/entities";
import {
  getFsiConfigSnapshot,
  getFsiContentRoot,
  isFsiActive,
  resolveEnabledFsiBundles,
} from "./fsi-config";
import { getFsiVendorDir } from "./fsi-settings";
import { loadFsiManifest, resolveActiveFsiSkillIdsForRole } from "./fsi-manifest-loader";

export async function getFsiCatalogSnapshot() {
  const manifest = await loadFsiManifest();
  const contentRoot = getFsiContentRoot();
  const bundles = resolveEnabledFsiBundles();

  const steering: Array<{ event: string; description?: string; workflowSlug?: string }> = [
    ...manifest.globalSteeringExamples,
  ];
  for (const [slug, wf] of Object.entries(manifest.agentWorkflows)) {
    for (const ex of wf.steeringExamples ?? []) {
      steering.push({ ...ex, workflowSlug: slug });
    }
  }

  const roleMappings: Record<string, { skillIds: string[]; workflows: string[] }> = {};
  const roles = new Set<AgentRole>([
    ...(Object.keys(manifest.roleSkillDefaults) as AgentRole[]),
    ...Object.values(manifest.agentWorkflows).flatMap((w) => w.fuseIntoRoles),
  ]);
  for (const role of roles) {
    roleMappings[role] = {
      skillIds: await resolveActiveFsiSkillIdsForRole(role),
      workflows: Object.entries(manifest.agentWorkflows)
        .filter(([, w]) => w.fuseIntoRoles.includes(role))
        .map(([slug]) => slug),
    };
  }

  const snap = getFsiConfigSnapshot();
  return {
    id: manifest.id,
    version: manifest.version,
    description: manifest.description,
    active: isFsiActive(),
    config: {
      ...snap,
      settingsFile: "content-packs/anthropic-fsi/settings.json",
      vendorDir: getFsiVendorDir(),
      contentReady: contentRoot != null,
    },
    bundles: manifest.bundles,
    skills: Object.keys(manifest.skills),
    agentWorkflows: Object.fromEntries(
      Object.entries(manifest.agentWorkflows).map(([slug, w]) => [
        slug,
        {
          label: w.label,
          fuseIntoRoles: w.fuseIntoRoles,
          skillIds: w.skillIds,
          sandboxPreset: w.sandboxPreset,
        },
      ])
    ),
    roleMappings,
    mcpCatalog: manifest.mcpCatalog,
    sandboxPresets: Object.keys(manifest.sandboxPresets),
    outputSchemaRoles: Object.keys(manifest.outputSchemas),
    steeringExamples: steering,
  };
}
