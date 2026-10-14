import { strategyLifecycle } from "./strategy-lifecycle";
import { strategyManagementSchema } from "./strategy-management-types";
import { strategyPaper } from "./strategy-paper";
export async function manageResearchStrategy(projectId: string, versionId: string, raw: unknown) {
  const input = strategyManagementSchema.parse(raw);
  switch (input.action) {
    case "inspect":
      return strategyLifecycle.detail(projectId, versionId);
    case "compare":
      return strategyLifecycle.compare(projectId, versionId, input.otherVersionId);
    case "state":
      return strategyLifecycle.transition(projectId, versionId, input);
    case "plan":
      return strategyLifecycle.plan(projectId, versionId, input.expectedRevision);
    case "validate":
      return strategyLifecycle.validate(projectId, versionId, input.planId, input.idempotencyKey);
    case "paper_list":
      return strategyPaper.list(projectId, versionId);
    case "paper_create":
      return strategyPaper.create(
        projectId,
        versionId,
        input.referenceAttemptId,
        input.expectedRevision
      );
    case "paper_status":
      return strategyPaper.setStatus(
        projectId,
        versionId,
        input.sessionId,
        input.status,
        input.expectedRevision,
        input.automatic
      );
    case "paper_advance":
      return strategyPaper.advance(projectId, versionId, input.sessionId, input);
  }
}
