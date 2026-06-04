/**
 * timeseries 纯函数单测（不依赖 sqlite）。
 *
 * 覆盖：
 *   - floorToBucket：5 种 interval 的边界 / UTC 一致性
 *   - buildBucketStarts：from/to 不对齐 / to 不含 / 空区间
 *   - fillMissingBuckets：缺桶补 0 / series 字典序 / 越界 ts 丢弃
 *
 * 注：queryTimeseries 走 DB 集成测试（依赖 schema 真实写入），不在此 mock，避免与
 *     drizzle SQL 模板耦合产生脆性。
 */
import { describe, expect, test } from "bun:test";
import {
  buildBucketStarts,
  fillMissingBuckets,
  floorToBucket,
} from "../timeseries";

describe("floorToBucket", () => {
  test("1m 对齐到整分钟", () => {
    expect(floorToBucket(new Date("2026-05-26T10:23:45.678Z"), "1m")).toBe(
      "2026-05-26T10:23:00Z"
    );
  });

  test("5m 向下对齐到 5 分钟边界", () => {
    expect(floorToBucket(new Date("2026-05-26T10:23:45.678Z"), "5m")).toBe(
      "2026-05-26T10:20:00Z"
    );
    expect(floorToBucket(new Date("2026-05-26T10:25:00.000Z"), "5m")).toBe(
      "2026-05-26T10:25:00Z"
    );
  });

  test("15m 向下对齐到 15 分钟边界", () => {
    expect(floorToBucket(new Date("2026-05-26T10:29:00.000Z"), "15m")).toBe(
      "2026-05-26T10:15:00Z"
    );
  });

  test("1h 对齐到整点（UTC）", () => {
    expect(floorToBucket(new Date("2026-05-26T10:59:59.999Z"), "1h")).toBe(
      "2026-05-26T10:00:00Z"
    );
  });

  test("1d 对齐到 UTC 日开始", () => {
    expect(floorToBucket(new Date("2026-05-26T23:59:59.999Z"), "1d")).toBe(
      "2026-05-26T00:00:00Z"
    );
  });
});

describe("buildBucketStarts", () => {
  test("from/to 不对齐 → 端点先 floor", () => {
    const buckets = buildBucketStarts(
      new Date("2026-05-26T10:07:30Z"),
      new Date("2026-05-26T10:23:00Z"),
      "5m"
    );
    expect(buckets).toEqual([
      "2026-05-26T10:05:00Z",
      "2026-05-26T10:10:00Z",
      "2026-05-26T10:15:00Z",
      "2026-05-26T10:20:00Z",
    ]);
  });

  test("to 自身正好在边界 → 不含 to 桶（半开区间）", () => {
    const buckets = buildBucketStarts(
      new Date("2026-05-26T10:00:00Z"),
      new Date("2026-05-26T10:15:00Z"),
      "5m"
    );
    // 10:00, 10:05, 10:10；10:15 不含
    expect(buckets).toEqual([
      "2026-05-26T10:00:00Z",
      "2026-05-26T10:05:00Z",
      "2026-05-26T10:10:00Z",
    ]);
  });

  test("to <= from → 空数组", () => {
    expect(
      buildBucketStarts(
        new Date("2026-05-26T10:00:00Z"),
        new Date("2026-05-26T10:00:00Z"),
        "1h"
      )
    ).toEqual([]);
  });

  test("跨小时 1m 桶", () => {
    const buckets = buildBucketStarts(
      new Date("2026-05-26T10:59:30Z"),
      new Date("2026-05-26T11:01:30Z"),
      "1m"
    );
    expect(buckets).toEqual([
      "2026-05-26T10:59:00Z",
      "2026-05-26T11:00:00Z",
      "2026-05-26T11:01:00Z",
    ]);
  });

  test("跨天 1d 桶", () => {
    const buckets = buildBucketStarts(
      new Date("2026-05-25T23:00:00Z"),
      new Date("2026-05-27T01:00:00Z"),
      "1d"
    );
    expect(buckets).toEqual([
      "2026-05-25T00:00:00Z",
      "2026-05-26T00:00:00Z",
      "2026-05-27T00:00:00Z",
    ]);
  });
});

describe("fillMissingBuckets", () => {
  const bucketStarts = [
    "2026-05-26T10:00:00Z",
    "2026-05-26T10:05:00Z",
    "2026-05-26T10:10:00Z",
  ];

  test("空 rows → 0 series 数组", () => {
    expect(fillMissingBuckets(bucketStarts, [])).toEqual([]);
  });

  test("单 series 缺中间桶 → 中间补 0", () => {
    const r = fillMissingBuckets(bucketStarts, [
      { ts: "2026-05-26T10:00:00Z", series: "openai", value: 3 },
      { ts: "2026-05-26T10:10:00Z", series: "openai", value: 7 },
    ]);
    expect(r).toEqual([{ name: "openai", points: [3, 0, 7] }]);
  });

  test("多 series 按字典序稳定排序", () => {
    const r = fillMissingBuckets(bucketStarts, [
      { ts: "2026-05-26T10:00:00Z", series: "z-series", value: 1 },
      { ts: "2026-05-26T10:00:00Z", series: "a-series", value: 2 },
      { ts: "2026-05-26T10:05:00Z", series: "a-series", value: 3 },
    ]);
    expect(r.map((s) => s.name)).toEqual(["a-series", "z-series"]);
    expect(r[0]?.points).toEqual([2, 3, 0]);
    expect(r[1]?.points).toEqual([1, 0, 0]);
  });

  test("越界 ts 直接丢弃（不抛错）", () => {
    const r = fillMissingBuckets(bucketStarts, [
      { ts: "2026-05-26T09:55:00Z", series: "x", value: 99 },
      { ts: "2026-05-26T10:05:00Z", series: "x", value: 2 },
    ]);
    expect(r).toEqual([{ name: "x", points: [0, 2, 0] }]);
  });
});
