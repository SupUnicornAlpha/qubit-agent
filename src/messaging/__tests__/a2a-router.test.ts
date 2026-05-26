/**
 * P2-A 测试基线：A2ARouter envelope + payload schema 校验 + governance。
 *
 * 之前 router 这部分零单测，下游 handler 拿到的 payload 形状全靠"以为对"。
 * 这里把 6 条关键断言锁住，后续 schema 改动至少要更新这里。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { a2aRouter } from "../a2a";
import { messageBus } from "../bus";
import type { A2AMessageEnvelope } from "../../types/a2a";

const baseEnvelope = (
  overrides: Partial<A2AMessageEnvelope> = {},
): A2AMessageEnvelope => ({
  messageId: crypto.randomUUID(),
  workflowId: "wf-1",
  traceId: "trace-1",
  senderAgent: "orchestrator",
  receiverAgent: "analyst_fundamental",
  messageType: "TASK_ASSIGN",
  payload: {
    taskId: "t-1",
    taskType: "research",
    params: { ticker: "AAPL" },
    assignedRole: "analyst_fundamental",
  },
  priority: 50,
  createdAt: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  process.env.A2A_STRICT_PAYLOAD = "true";
});

afterEach(() => {
  delete process.env.A2A_STRICT_PAYLOAD;
});

describe("A2ARouter.route — envelope schema", () => {
  test("合法 envelope 通过（payload 也合法 TASK_ASSIGN）", async () => {
    /** 仅验证 .route 不抛；bus 内部异步消费不阻塞测试 */
    await expect(a2aRouter.route(baseEnvelope())).resolves.toBeUndefined();
  });

  test("envelope 缺 workflowId → throw envelope schema mismatch", async () => {
    const bad = baseEnvelope();
    delete (bad as Record<string, unknown>).workflowId;
    await expect(a2aRouter.route(bad as A2AMessageEnvelope)).rejects.toThrow(
      /envelope schema mismatch/i,
    );
  });

  test("envelope.messageType 非法 → throw envelope schema mismatch", async () => {
    const bad = baseEnvelope({ messageType: "NOT_A_TYPE" as unknown as A2AMessageEnvelope["messageType"] });
    await expect(a2aRouter.route(bad)).rejects.toThrow(/envelope schema mismatch/i);
  });
});

describe("A2ARouter.route — payload schema (strict)", () => {
  test("TASK_ASSIGN payload 缺 taskId → strict 模式 throw", async () => {
    const bad = baseEnvelope({
      payload: { taskType: "research", params: {}, assignedRole: "analyst_fundamental" },
    });
    await expect(a2aRouter.route(bad)).rejects.toThrow(/payload schema mismatch/i);
  });

  test("ORDER_INTENT payload side 非 buy/sell → throw", async () => {
    /**
     * 注意 governance 也会拦这条（缺 riskSignature）；为了证明 schema 在 governance 前
     * 先发威，给个 riskSignature 但 side 非法。
     */
    const bad = baseEnvelope({
      messageType: "ORDER_INTENT",
      payload: {
        orderIntentId: "oi-1",
        instrumentId: "AAPL",
        side: "long", // ← 非法
        qty: 100,
        orderType: "market",
        timeInForce: "day",
        riskSignature: "sig-x",
      },
    });
    await expect(a2aRouter.route(bad)).rejects.toThrow(/payload schema mismatch/i);
  });
});

describe("A2ARouter.route — payload schema (non-strict fallback)", () => {
  test("A2A_STRICT_PAYLOAD=false 时 payload 异常只 warn，不 throw", async () => {
    process.env.A2A_STRICT_PAYLOAD = "false";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const bad = baseEnvelope({
        payload: { taskType: "research" }, // 缺 taskId / params / assignedRole
      });
      await expect(a2aRouter.route(bad)).resolves.toBeUndefined();
      expect(warns.some((w) => /payload schema mismatch/i.test(w))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("A2ARouter.route — governance", () => {
  test("ORDER_INTENT 缺 riskSignature → governance throw（在 schema 之后）", async () => {
    const bad = baseEnvelope({
      messageType: "ORDER_INTENT",
      payload: {
        orderIntentId: "oi-1",
        instrumentId: "AAPL",
        side: "buy",
        qty: 100,
        orderType: "market",
        timeInForce: "day",
        // riskSignature 故意省
      },
    });
    await expect(a2aRouter.route(bad)).rejects.toThrow(/governance violation/i);
  });

  test("ORDER_INTENT 带 riskSignature 且 payload 合法 → 通过", async () => {
    const ok = baseEnvelope({
      messageType: "ORDER_INTENT",
      receiverAgent: "execution",
      payload: {
        orderIntentId: "oi-2",
        instrumentId: "AAPL",
        side: "buy",
        qty: 100,
        orderType: "market",
        timeInForce: "day",
        riskSignature: "valid-hmac-sig",
      },
    });
    await expect(a2aRouter.route(ok)).resolves.toBeUndefined();
  });
});

describe("A2ARouter.send", () => {
  test("自动填 messageId / createdAt 并下发", async () => {
    const received: A2AMessageEnvelope[] = [];
    const unsub = messageBus.subscribe("ALERT", (msg) => {
      received.push(msg);
    });
    try {
      await a2aRouter.send({
        workflowId: "wf-x",
        traceId: "trace-x",
        senderAgent: "risk_manager",
        receiverAgent: "orchestrator",
        messageType: "ALERT",
        payload: { alertType: "test", severity: "info", message: "hi" },
        priority: 80,
      });
      /** EventEmitter 同步触发 */
      expect(received).toHaveLength(1);
      expect(received[0]?.messageId).toMatch(/[0-9a-f-]{36}/);
      expect(received[0]?.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      unsub();
    }
  });
});
