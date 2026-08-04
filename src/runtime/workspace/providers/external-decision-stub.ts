/**
 * external.decision_stub — 外部决策引擎适配样例。
 */
import type { DecisionEngineProvider } from "./resolve";

export const EXTERNAL_DECISION_STUB_KIND = "external.decision_stub";

export function createExternalDecisionStub(): DecisionEngineProvider {
  return {
    kind: EXTERNAL_DECISION_STUB_KIND,
    async listStrategies() {
      return [];
    },
    async listFactors() {
      return [];
    },
    async syncIntoWorkspace() {
      throw new Error(
        `${EXTERNAL_DECISION_STUB_KIND} does not sync workshop assets. ` +
          `Register a real DecisionEngineProvider or use builtin.local_quant.`
      );
    },
  };
}
