/**
 * P1 优先级 TDD（Round 7 复盘 2026-06-08）：编组级硬约束 hint
 *
 * 覆盖：
 *   1. 已知白名单 → 返回硬约束 markdown（含必备工具名）
 *   2. 已知 group 但 role 不在白名单 → 走兜底 description 软提示
 *   3. groupId 未给 → 走兜底 description 软提示
 *   4. groupId 未命中 + groupDescription 缺失 → 返回空串
 *   5. hasHardConstraint 准确反映白名单
 */

import { describe, expect, test } from "bun:test";
import {
  buildGroupRoleConstraintHint,
  hasHardConstraint,
} from "../group-constraint-hint";

describe("buildGroupRoleConstraintHint (P1 编组硬约束注入)", () => {
  test("grp-strategy-pipeline + research → 含 strategy.create_version + strategy.compose 强制提示", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-strategy-pipeline",
      role: "research",
    });
    expect(hint).toContain("grp-strategy-pipeline");
    expect(hint).toContain("strategy.create_version");
    expect(hint).toContain("strategy.compose");
    expect(hint).toContain("factor_ids");
    expect(hint).toMatch(/必须/);
  });

  test("grp-live-trading + research → 含 order.create_intent 强制提示 + dispatch_mode='paper'", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-live-trading",
      role: "research",
    });
    expect(hint).toContain("grp-live-trading");
    expect(hint).toContain("order.create_intent");
    expect(hint).toContain("paper");
    expect(hint).toMatch(/必须/);
  });

  test("grp-live-trading + risk → 含 pre-trade + risk_decision 提示", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-live-trading",
      role: "risk",
    });
    expect(hint).toContain("grp-live-trading");
    expect(hint).toContain("risk_decision");
    expect(hint).toMatch(/order_intent_id/);
  });

  test("已知 group 但 role 不在白名单（如 backtest）→ 走 description 软提示", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-strategy-pipeline",
      role: "backtest",
      groupDescription: "策略撰写编组：研究→回测→风控顺序串行",
    });
    expect(hint).not.toContain("strategy.create_version"); // 没硬约束
    expect(hint).toContain("编组背景");
    expect(hint).toContain("策略撰写编组");
  });

  test("未知 group + 给了 description → 返回软提示", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-some-custom",
      role: "research",
      groupDescription: "用户自定义编组",
    });
    expect(hint).toContain("编组背景");
    expect(hint).toContain("用户自定义编组");
  });

  test("groupId 为 null + 无 description → 空串（对原 flow 无副作用）", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: null,
      role: "research",
    });
    expect(hint).toBe("");
  });

  test("groupId 为 undefined + 无 description → 空串", () => {
    const hint = buildGroupRoleConstraintHint({
      role: "research",
    });
    expect(hint).toBe("");
  });

  test("description 为空串 → 不应当作软提示", () => {
    const hint = buildGroupRoleConstraintHint({
      groupId: "grp-unknown",
      role: "research",
      groupDescription: "   ",
    });
    expect(hint).toBe("");
  });
});

describe("hasHardConstraint", () => {
  test("strategy-pipeline research 命中", () => {
    expect(hasHardConstraint({ groupId: "grp-strategy-pipeline", role: "research" })).toBe(
      true
    );
  });
  test("live-trading research 命中", () => {
    expect(hasHardConstraint({ groupId: "grp-live-trading", role: "research" })).toBe(true);
  });
  test("strategy-pipeline backtest 不命中", () => {
    expect(hasHardConstraint({ groupId: "grp-strategy-pipeline", role: "backtest" })).toBe(
      false
    );
  });
  test("空 groupId 不命中", () => {
    expect(hasHardConstraint({ role: "research" })).toBe(false);
  });
});
