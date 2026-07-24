import { describe, expect, test } from "bun:test";
import { selectRelevantFsiSkillIds } from "../fsi-prompt-enricher";

describe("selectRelevantFsiSkillIds", () => {
  const skills = [
    "fsi/earnings-analysis",
    "fsi/sector-overview",
    "fsi/dcf-model",
    "fsi/idea-generation",
  ];

  test("按任务选择相关技能而非全量注入", () => {
    expect(selectRelevantFsiSkillIds(skills, "分析公司财报和盈利变化", 2)[0]).toBe(
      "fsi/earnings-analysis"
    );
    expect(selectRelevantFsiSkillIds(skills, "构建 DCF 估值模型", 1)).toEqual(["fsi/dcf-model"]);
  });

  test("无明显匹配时稳定回退到前 N 个", () => {
    expect(selectRelevantFsiSkillIds(skills, "完全无关的任务", 2)).toEqual(skills.slice(0, 2));
  });
});
