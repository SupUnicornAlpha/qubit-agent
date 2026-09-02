import { describe, expect, test } from "bun:test";
import {
  isManualLiveDeploymentApproval,
  resolveManualLiveDeploymentAdmission,
} from "./strategy-promotion-service";

describe("manual live deployment approval semantics", () => {
  test("does not confuse measured live observations or legacy labels with a governed authorization", () => {
    expect(
      isManualLiveDeploymentApproval({
        evalKind: "live",
        scenarioKey: "live_performance_30d",
        metricsJson: { netReturn: 0.12 },
      })
    ).toBe(false);
    expect(
      isManualLiveDeploymentApproval({
        evalKind: "live",
        scenarioKey: "live_approval",
        metricsJson: {
          approvalKind: "manual_limited_live_deployment_v1",
          gateVersion: "live-approval-v1",
        },
      })
    ).toBe(false);
    expect(
      isManualLiveDeploymentApproval({
        evalKind: "live",
        scenarioKey: "live_approval",
        metricsJson: {
          approvalKind: "manual_limited_live_deployment_v2",
          gateVersion: "live-approval-v2",
          promotionAdmission: {
            version: "strategy-live-admission-v1",
            kind: "manual_champion_bootstrap",
            decision: "manual_champion_bootstrap_required",
            comparisonCohortId: "strategy_cohort_0123456789abcdef01234567",
            championStrategyVersionId: null,
            challengerStrategyVersionId: "strategy-version",
            diversification: null,
          },
        },
      })
    ).toBe(true);
  });

  test("only allows a first bootstrap or a diversification-passed challenger", () => {
    const bootstrap = resolveManualLiveDeploymentAdmission({
      comparisonCohortId: "strategy_cohort_0123456789abcdef01234567",
      champion: null,
      challenger: { strategyVersionId: "candidate" },
      diversification: { pass: false } as never,
      promotionEligible: false,
      decision: "manual_champion_bootstrap_required",
    });
    expect(bootstrap?.kind).toBe("manual_champion_bootstrap");

    const rejected = resolveManualLiveDeploymentAdmission({
      comparisonCohortId: "strategy_cohort_0123456789abcdef01234567",
      champion: { strategyVersionId: "champion" },
      challenger: { strategyVersionId: "candidate" },
      diversification: { pass: false } as never,
      promotionEligible: true,
      decision: "candidate_for_manual_promotion",
    });
    expect(rejected).toBeNull();
  });
});
