import { describe, expect, test } from "bun:test";
import { assessNewsEvidence } from "./news-evidence";

const asOf = new Date("2026-07-22T12:00:00.000Z");

describe("assessNewsEvidence", () => {
  test("current mode only accepts fresh, symbol-relevant, non-synthetic evidence", () => {
    const result = assessNewsEvidence(
      [
        {
          title: "东山精密 002384 获得新订单",
          publishedAt: "2026-07-21T03:00:00.000Z",
          source: "exchange",
        },
        {
          title: "[stub] News for 002384.SZ",
          content: "Synthetic news row",
          publishedAt: "2026-07-22T03:00:00.000Z",
          source: "qubit-native",
          isSynthetic: true,
        },
        {
          title: "002384 历史回顾",
          publishedAt: "2026-06-01T03:00:00.000Z",
          source: "archive",
        },
        {
          title: "亚洲成长型公司榜单",
          publishedAt: "2026-07-21T03:00:00.000Z",
          source: "rss",
        },
      ],
      { symbol: "002384.SZ", aliases: ["东山精密"], asOf, maxAgeDays: 7 }
    );

    expect(result.accepted.map((item) => item.title)).toEqual(["东山精密 002384 获得新订单"]);
    expect(result.rejected).toMatchObject({ synthetic: 1, stale: 1, irrelevant: 1 });
  });

  test("historical validation permits old evidence but still rejects missing dates", () => {
    const result = assessNewsEvidence(
      [
        { title: "东山精密历史公告", publishedAt: "2024-01-01", source: "archive" },
        { title: "东山精密无日期公告", publishedAt: "", source: "archive" },
      ],
      { symbol: "002384.SZ", aliases: ["东山精密"], asOf, allowHistorical: true }
    );
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.missing_or_invalid_time).toBe(1);
  });
});
