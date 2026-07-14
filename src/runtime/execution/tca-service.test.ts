import { describe, expect, test } from "bun:test";
import { classifyRejection, summarizeTca } from "./tca-service";

describe("summarizeTca", () => {
  test("aggregates fill rate, implementation shortfall and fees", () => {
    const result = summarizeTca([
      {
        orderIntentId: "one",
        side: "buy",
        intendedQty: 100,
        intendedPrice: 10,
        filledQty: 100,
        averageFillPrice: 10.1,
        fees: 1,
        implementationShortfallPct: 1,
        fillRatePct: 100,
        submitLatencyMs: 100,
        fillLatencyMs: 400,
        totalLatencyMs: 500,
        rejected: false,
        rejectionCategory: null,
        rejectionReason: null,
      },
      {
        orderIntentId: "two",
        side: "sell",
        intendedQty: 100,
        intendedPrice: 10,
        filledQty: 50,
        averageFillPrice: 9.8,
        fees: 2,
        implementationShortfallPct: 2,
        fillRatePct: 50,
        submitLatencyMs: 300,
        fillLatencyMs: 700,
        totalLatencyMs: 1000,
        rejected: true,
        rejectionCategory: "broker",
        rejectionReason: "broker_order_rejected",
      },
    ]);
    expect(result.orderCount).toBe(2);
    expect(result.averageFillRatePct).toBe(75);
    expect(result.averageImplementationShortfallPct).toBe(1.5);
    expect(result.totalFees).toBe(3);
    expect(result.averageSubmitLatencyMs).toBe(200);
    expect(result.averageFillLatencyMs).toBe(550);
    expect(result.rejectedOrderCount).toBe(1);
    expect(result.rejectionRatePct).toBe(50);
    expect(result.rejectionBreakdown.broker).toBe(1);
  });

  test("classifies rejection causes", () => {
    expect(classifyRejection("max_notional risk block")).toBe("risk");
    expect(classifyRejection("broker_order_rejected")).toBe("broker");
    expect(classifyRejection("retry timeout exhausted")).toBe("retry_exhausted");
  });
});
