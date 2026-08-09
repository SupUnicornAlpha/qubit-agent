import { describe, expect, test } from "bun:test";
import { extractCoreSkillActivities } from "../project-core-activity";

describe("Rust Core Skill topology projection", () => {
  test("projects valid recalled Skills and drops malformed rows", () => {
    expect(
      extractCoreSkillActivities({
        skills: [
          { id: "skill-1", name: "backtest-leakage-self-check", version: "v1", score: 0.9 },
          { name: "" },
          null,
        ],
      })
    ).toEqual([
      { id: "skill-1", name: "backtest-leakage-self-check", version: "v1", score: 0.9 },
    ]);
  });
});
