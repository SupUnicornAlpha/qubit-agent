import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { project, sandboxPolicy, workflowRun, workspace } from "../../db/sqlite/schema";
import { resolveEffectiveAgentTools } from "../orchestration/resolve-effective-tools";
import { authorizeCapability, listAuthorizedCapabilities } from "../tools/capability-gate";
import type { RuntimeAgentDefinition } from "../types";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import {
  acquireWorkflowMathHarnessLease,
  acquireWorkflowResearchIntegrityHarnessLease,
  isWorkflowMathHarnessLeaseActiveForTest,
  isWorkflowResearchIntegrityHarnessLeaseActiveForTest,
} from "./workflow-harness";

const workspaceId = "ws-math-harness-lease";
const projectId = "prj-math-harness-lease";
const policyId = "policy-math-harness-lease";

const definition: RuntimeAgentDefinition = {
  id: "def-math-harness-lease",
  role: "research",
  name: "math lease test",
  version: "1",
  systemPrompt: "",
  tools: ["math.derivation.verify"],
  mcpServers: [],
  skills: [],
  subscriptions: ["TASK_ASSIGN"],
  llmProvider: "mock",
  maxIterations: 3,
  sandboxPolicyId: policyId,
  enabled: true,
};

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db
    .insert(workspace)
    .values({ id: workspaceId, name: "math harness lease", owner: "test" })
    .onConflictDoNothing();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "math harness lease", marketScope: "US" })
    .onConflictDoNothing();
  await db
    .insert(sandboxPolicy)
    .values({
      id: policyId,
      name: "math harness lease",
      allowedToolsJson: ["math.derivation.verify"],
      allowedMcpServersJson: [],
      allowedConnectorsJson: [],
    })
    .onConflictDoNothing();
});

async function createWorkflow(id: string, harness?: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  await db.delete(workflowRun).where(eq(workflowRun.id, id));
  await db.insert(workflowRun).values({
    id,
    projectId,
    goal: "math harness test",
    mode: "research",
    status: "running",
    researchScenarioId: "conversational_research",
    loopOptionsJson: harness ?? {},
  });
}

describe("workflow math Harness lease", () => {
  test("removes math from both the prompt and execution surface until admitted", async () => {
    const workflowId = "wf-math-harness-off";
    await createWorkflow(workflowId);
    const surface = await listAuthorizedCapabilities({
      agentDefinition: definition,
      workflowId,
    });
    expect(surface.tools).not.toContain("math.derivation.verify");
    const denied = await authorizeCapability({
      name: "math.derivation.verify",
      agentDefinition: definition,
      workflowId,
    });
    expect(denied.ok).toBe(false);
  });

  test("activates once per workflow and releases at terminal state", async () => {
    const workflowId = "wf-math-harness-on";
    await createWorkflow(workflowId, {
      harness: {
        mathAudit: { mode: "required", reason: "factor formula decision" },
        researchIntegrity: { mode: "required", reason: "strategy evidence review" },
      },
    });
    const surface = await listAuthorizedCapabilities({
      agentDefinition: definition,
      workflowId,
    });
    expect(surface.tools).toContain("math.derivation.verify");
    const effective = await resolveEffectiveAgentTools(definition, workflowId);
    expect(effective.harnessShadow.profileIds).toContain("quant-research-integrity");
    const allowed = await authorizeCapability({
      name: "math.derivation.verify",
      agentDefinition: definition,
      workflowId,
    });
    expect(allowed.ok).toBe(true);
    expect(await acquireWorkflowMathHarnessLease(workflowId)).toMatchObject({ mode: "required" });
    expect(isWorkflowMathHarnessLeaseActiveForTest(workflowId)).toBe(true);
    expect(await acquireWorkflowResearchIntegrityHarnessLease(workflowId)).toMatchObject({
      profileId: "quant-research-integrity",
      mode: "required",
    });
    expect(isWorkflowResearchIntegrityHarnessLeaseActiveForTest(workflowId)).toBe(true);
    const db = await getDb();
    await db
      .update(workflowRun)
      .set({
        loopOptionsJson: {
          harness: {
            mathAudit: { mode: "required", reason: "factor formula decision" },
            researchIntegrity: { mode: "off", reason: "audit projection disabled" },
          },
        },
      })
      .where(eq(workflowRun.id, workflowId));
    expect(await acquireWorkflowResearchIntegrityHarnessLease(workflowId)).toBeNull();
    expect(isWorkflowResearchIntegrityHarnessLeaseActiveForTest(workflowId)).toBe(false);
    await setWorkflowState(workflowId, "completed", { reason: "workflow-harness-test" });
    expect(isWorkflowMathHarnessLeaseActiveForTest(workflowId)).toBe(false);
    expect(isWorkflowResearchIntegrityHarnessLeaseActiveForTest(workflowId)).toBe(false);
  });
});
