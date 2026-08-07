/**
 * Persist Bun DeliveryVerdict ledger after a Prime Core turn.
 * Core carries a thin delivery status; Bun re-evaluates against SQLite artifacts
 * so H-DV / UpgradeGate see the same ledger as the TS ReAct path.
 */
import { evaluateDeliveryVerdict } from "../policy/completion";
import { persistDeliveryVerdict } from "../policy/delivery-ledger";
import { loadScenarioRuntimeSnapshot } from "../policy/scenario-snapshot";
import { getRuntimeSqlite } from "../policy/repositories/runtime-sqlite";
import type { DeliveryVerdict } from "../policy/types";

export async function persistDeliveryVerdictForCoreTurn(input: {
  workflowId: string;
  answerText: string;
  /** When Core timed out / cancelled before a usable answer. */
  forceFailed?: boolean;
  forceReason?: string;
}): Promise<DeliveryVerdict | null> {
  try {
    const sqlite = getRuntimeSqlite();
    const snapshot = loadScenarioRuntimeSnapshot({
      sqlite,
      workflowId: input.workflowId,
    });
    if (!snapshot.scenarioKey) return null;

    if (input.forceFailed) {
      const verdict: DeliveryVerdict = {
        state: "failed",
        reasonCodes: [input.forceReason ?? "prime_core_turn_timeout"],
        softReasonCodes: [],
        missingArtifacts: [],
        missingCapabilities: [],
        dataGaps: [],
        answer: { schemaOk: false, missingSections: [] },
        researchOk: false,
        upgradeOk: false,
        evaluatorVersion: "prime-core-timeout",
        recipeKey: snapshot.scenarioKey,
        recipeVersion: snapshot.recipe?.version ?? null,
      };
      await persistDeliveryVerdict({ workflowId: input.workflowId, verdict });
      return verdict;
    }

    const verdict = evaluateDeliveryVerdict({
      sqlite,
      snapshot,
      answerText: input.answerText,
      enforceBenchmarkTerms: false,
    });
    await persistDeliveryVerdict({ workflowId: input.workflowId, verdict });
    return verdict;
  } catch (err) {
    console.warn(
      "[prime-core] persistDeliveryVerdictForCoreTurn failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
