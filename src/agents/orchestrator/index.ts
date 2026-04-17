import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope, TaskAssignPayload } from "../../types/a2a";
import { BaseAgent } from "../base.agent";
import { a2aRouter } from "../../messaging/a2a";

/**
 * OrchestratorAgent — task decomposition, scheduling, arbitration, SLA management.
 *
 * Responsibilities:
 * - Receive high-level workflow goals from the API / CLI
 * - Decompose into sub-tasks and assign to appropriate agents via TASK_ASSIGN
 * - Track task completion and handle failures / retries
 * - Enforce that it is the sole primary decision-maker per workflow
 */
export class OrchestratorAgent extends BaseAgent {
  readonly role: AgentRole = "orchestrator";
  readonly subscriptions: A2AMessageType[] = ["TASK_RESULT", "ALERT", "RISK_BLOCK"];

  protected async onInit(): Promise<void> {
    // TODO: load active workflow runs from DB and resume if needed
  }

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    switch (msg.messageType) {
      case "TASK_RESULT":
        await this._handleTaskResult(msg);
        break;
      case "ALERT":
        await this._handleAlert(msg);
        break;
      case "RISK_BLOCK":
        await this._handleRiskBlock(msg);
        break;
    }
  }

  protected async onShutdown(): Promise<void> {
    // TODO: persist in-flight workflow state
  }

  async assignTask(
    workflowId: string,
    receiverAgent: string,
    payload: TaskAssignPayload
  ): Promise<void> {
    await this.send({
      workflowId,
      traceId: crypto.randomUUID(),
      receiverAgent,
      messageType: "TASK_ASSIGN",
      payload,
      priority: payload.params?.["priority"] as number ?? 50,
    });
  }

  private async _handleTaskResult(_msg: A2AMessageEnvelope): Promise<void> {
    // TODO: update workflow state, trigger next step
  }

  private async _handleAlert(_msg: A2AMessageEnvelope): Promise<void> {
    // TODO: evaluate alert severity and decide on escalation / retry
  }

  private async _handleRiskBlock(_msg: A2AMessageEnvelope): Promise<void> {
    // TODO: notify user / log / cancel associated order intent
  }
}

export const orchestratorAgent = new OrchestratorAgent();
