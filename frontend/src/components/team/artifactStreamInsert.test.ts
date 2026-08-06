import { describe, expect, test } from "bun:test";
import {
  findArtifactInsertAfterIndex,
  groupArtifactsByInsertAnchor,
  toolMatchesArtifactKind,
  toolMentionsArtifact,
  type TimestampedStreamAnchor,
} from "./artifactStreamInsert";

describe("artifactStreamInsert", () => {
  test("matches create tools by kind", () => {
    expect(toolMatchesArtifactKind("strategy.create_version", "strategy")).toBe(true);
    expect(toolMatchesArtifactKind("factor.register", "factor")).toBe(true);
    expect(toolMatchesArtifactKind("backtest.run", "backtest")).toBe(true);
    expect(toolMatchesArtifactKind("factor.promote_backtest", "backtest")).toBe(true);
    expect(toolMatchesArtifactKind("market.klines", "strategy")).toBe(false);
    expect(toolMatchesArtifactKind("backtest.run", "unknown")).toBe(false);
  });

  test("prefers tool that mentions artifact id", () => {
    const anchors: TimestampedStreamAnchor[] = [
      {
        index: 0,
        isTool: true,
        toolName: "strategy.create_version",
        contentText: '{"id":"sv-other"}',
        ts: "2026-08-04T13:20:00.000Z",
      },
      {
        index: 1,
        isTool: true,
        toolName: "strategy.create_version",
        contentText: '{"id":"sv-hit","name":"semi_ls"}',
        ts: "2026-08-04T13:26:51.000Z",
      },
    ];
    const after = findArtifactInsertAfterIndex(anchors, {
      id: "sv-hit",
      kind: "strategy",
      title: "semi_ls",
      createdAt: "2026-08-04T13:26:55.000Z",
    });
    expect(after).toBe(1);
    expect(
      toolMentionsArtifact("strategy.create_version", '{"id":"sv-hit"}', {
        id: "sv-hit",
        kind: "strategy",
        title: "x",
      })
    ).toBe(true);
  });

  test("falls back to chronological position when no create tool", () => {
    const anchors: TimestampedStreamAnchor[] = [
      { index: 0, isTool: false, ts: "2026-08-04T13:00:00.000Z" },
      { index: 1, isTool: false, ts: "2026-08-04T13:10:00.000Z" },
      { index: 2, isTool: false, ts: "2026-08-04T13:30:00.000Z" },
    ];
    const after = findArtifactInsertAfterIndex(anchors, {
      id: "f1",
      kind: "factor",
      title: "mom",
      createdAt: "2026-08-04T13:12:00.000Z",
    });
    expect(after).toBe(1);
  });

  test("groups multiple artifacts on same anchor", () => {
    const anchors: TimestampedStreamAnchor[] = [
      {
        index: 0,
        isTool: true,
        toolName: "factor.register",
        contentText: "factor-a",
        ts: "2026-08-04T13:00:00.000Z",
      },
    ];
    const map = groupArtifactsByInsertAnchor(anchors, [
      { id: "a", kind: "factor", title: "a", createdAt: "2026-08-04T13:00:01.000Z" },
      { id: "b", kind: "factor", title: "b", createdAt: "2026-08-04T13:00:02.000Z" },
    ]);
    expect(map.get(0)?.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
