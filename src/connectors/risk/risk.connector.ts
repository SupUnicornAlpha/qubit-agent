import type { ConnectorMeta, RiskCheckRequest, RiskCheckResponse } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * RiskConnector — abstract base for risk rule engine / risk calculation adapters.
 *
 * The Risk Agent holds a veto power; this connector encapsulates the actual
 * risk evaluation logic (which may be a local rule engine or an external service).
 */
export abstract class RiskConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  abstract evaluate(request: RiskCheckRequest): Promise<RiskCheckResponse>;
  abstract loadRules(projectId: string): Promise<RiskRuleSummary[]>;
  abstract reloadRules(projectId: string): Promise<void>;

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "evaluate":
        return this.evaluate(payload as RiskCheckRequest) as unknown as TOutput;
      case "load_rules":
        return this.loadRules((payload as { projectId: string }).projectId) as unknown as TOutput;
      case "reload_rules":
        await this.reloadRules((payload as { projectId: string }).projectId);
        return undefined as TOutput;
      default:
        throw new Error(`RiskConnector: unknown operation "${operation}"`);
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RiskRuleSummary {
  id: string;
  name: string;
  scope: "pre_trade" | "intra_trade" | "post_trade";
  severity: "block" | "warn" | "info";
  enabled: boolean;
  version: number;
}
