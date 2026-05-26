import { randomUUID } from "node:crypto";
import type { A2AMessageType, AgentRole } from "../types/entities";
import {
  A2A_GOVERNANCE,
  A2AMessageSchema,
  AlertPayloadSchema,
  MemoryWritePayloadSchema,
  OrderIntentPayloadSchema,
  RiskBlockPayloadSchema,
  TaskAssignPayloadSchema,
  TaskResultPayloadSchema,
  type A2AMessageEnvelope,
} from "../types/a2a";
import { persistA2AMessage } from "./a2a-persistence";
import { messageBus } from "./bus";

/**
 * P2-A：A2A envelope payload schema 分发表。
 *
 * 之前 router 只跑 `_enforceGovernance`（只看 ORDER_INTENT.riskSignature），
 * payload 形状漂移没有任何防护。这里挂回 types/a2a.ts 已有的 zod schema，
 * 按 messageType 派发对应 payload schema 做 .safeParse。
 *
 * 失败行为：开发模式 throw、生产模式 warn 不挡（避免单条破消息把总线打死）。
 * 由 env 变量 `A2A_STRICT_PAYLOAD` 控制；CI / 单测默认 strict。
 */
const PAYLOAD_SCHEMAS: Record<A2AMessageType, { parse: (v: unknown) => unknown }> = {
  TASK_ASSIGN: TaskAssignPayloadSchema,
  TASK_RESULT: TaskResultPayloadSchema,
  RISK_BLOCK: RiskBlockPayloadSchema,
  ORDER_INTENT: OrderIntentPayloadSchema,
  MODEL_UPDATE: { parse: (v: unknown) => v }, // 暂无 schema，原样放行
  MEMORY_WRITE: MemoryWritePayloadSchema,
  ALERT: AlertPayloadSchema,
};

function isStrictMode(): boolean {
  // 显式关闭：A2A_STRICT_PAYLOAD=false / 0；默认 strict
  const raw = process.env.A2A_STRICT_PAYLOAD ?? "";
  if (raw === "false" || raw === "0") return false;
  return true;
}

/**
 * A2A (Agent-to-Agent) router.
 *
 * Enforces governance rules:
 * 1. Only the Orchestrator may be the primary decision-maker per workflow.
 * 2. Risk Agent holds veto power over ORDER_INTENT messages.
 * 3. Execution Agent only consumes risk-signed order intents.
 */
export class A2ARouter {
  private static _instance: A2ARouter | null = null;

  private constructor() {}

  static getInstance(): A2ARouter {
    if (!A2ARouter._instance) {
      A2ARouter._instance = new A2ARouter();
    }
    return A2ARouter._instance;
  }

  /**
   * Route a message through schema + governance checks then dispatch to the bus.
   */
  async route(message: A2AMessageEnvelope): Promise<void> {
    this._validateEnvelopeAndPayload(message);
    this._enforceGovernance(message);
    messageBus.publish(message);
    void persistA2AMessage(message).catch((err) => {
      console.error("[A2ARouter] failed to persist message:", err);
    });
  }

  /**
   * Build and route a new A2A message.
   */
  async send(
    params: Omit<A2AMessageEnvelope, "messageId" | "createdAt">
  ): Promise<void> {
    const envelope: A2AMessageEnvelope = {
      ...params,
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.route(envelope);
  }

  /**
   * Register a handler for a specific message type.
   * Returns an unsubscribe function.
   */
  on(
    type: A2AMessageType | "*",
    handler: (msg: A2AMessageEnvelope) => void | Promise<void>
  ): () => void {
    return messageBus.subscribe(type, handler);
  }

  /**
   * P2-A：Envelope + payload schema 双层校验。
   *
   * 错误处理：
   *   - envelope schema 失败 → 总是 throw（消息格式坏掉，无法 fallback）
   *   - payload schema 失败 → strict 模式 throw；非 strict 模式只 console.warn 不挡
   *     （避免一条 payload 异常把整条总线打死，让上层 handler 自己 catch）
   */
  private _validateEnvelopeAndPayload(message: A2AMessageEnvelope): void {
    /** envelope 自身先过 schema（type / sender / receiver / messageType 等） */
    const envelopeCheck = A2AMessageSchema.safeParse(message);
    if (!envelopeCheck.success) {
      throw new Error(
        `A2A envelope schema mismatch: ${envelopeCheck.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    /** 按 messageType 找 payload schema */
    const payloadSchema = PAYLOAD_SCHEMAS[message.messageType];
    if (!payloadSchema) return;
    try {
      payloadSchema.parse(message.payload);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const msg = `A2A payload schema mismatch (messageType=${message.messageType}, id=${message.messageId}): ${detail}`;
      if (isStrictMode()) {
        throw new Error(msg);
      } else {
        console.warn("[A2ARouter]", msg);
      }
    }
  }

  /**
   * Governance enforcement — throws if rules are violated.
   */
  private _enforceGovernance(message: A2AMessageEnvelope): void {
    // Rule: ORDER_INTENT must carry a risk signature before reaching Execution Agent
    if (
      message.messageType === A2A_GOVERNANCE.VETO_MESSAGE_TYPE &&
      A2A_GOVERNANCE.EXECUTION_REQUIRES_RISK_SIGNATURE
    ) {
      const payload = message.payload as Record<string, unknown> | null;
      if (!payload?.["riskSignature"]) {
        throw new Error(
          `A2A governance violation: ORDER_INTENT [${message.messageId}] must carry a risk signature.`
        );
      }
    }
  }
}

export const a2aRouter = A2ARouter.getInstance();
