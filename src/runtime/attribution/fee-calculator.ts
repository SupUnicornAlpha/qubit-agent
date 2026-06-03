/**
 * Self-Evolving Agent P4a — FeeCalculator
 *
 * 为什么需要：仓库实盘链路 `fill.fee` 全部为 0（无论 paper / live），PnL 算出来全是
 * 高估的 gross。FeeCalculator 按 (broker, market, asset_class, side) 多维匹配
 * `fee_schedule` 表，计算单笔成交的总手续费 = commission + stamp_duty + transfer_fee
 * （都按比例 + 最低收费）。
 *
 * 匹配规则：
 *   1) 先查精确匹配（priority desc）；
 *   2) 任一维度允许 '*' 通配，命中 priority 较低；
 *   3) 命中后取 `enabled=true` 且 `effective_from <= asOf <= (effective_to || ∞)` 的最高优先级行；
 *   4) 全 miss → 返回 0（不抛错，PnL 跑批宁愿少算手续费也不要因此挂掉）。
 *
 * 注意：本计算器**不**改写 fill.fee 字段（避免污染原始数据）；
 * 仅供 PnlAttributor 在算 PnL 时叠加，结果写到 `strategy_pnl_snapshot.fee_daily / fee_cum`。
 */

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { feeSchedule } from "../../db/sqlite/schema";

export interface FeeInput {
  broker: string;
  market: string;
  assetClass: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** ISO date or datetime；用于命中 effective_from / effective_to 窗口；默认 now */
  asOf?: string;
}

export interface FeeBreakdown {
  commission: number;
  stampDuty: number;
  transferFee: number;
  total: number;
  /** 命中的 feeSchedule 行 id；全 miss 时为 null（total=0） */
  matchedRuleId: string | null;
}

interface FeeRow {
  id: string;
  broker: string;
  market: string;
  assetClass: string;
  side: string;
  commissionRate: number;
  commissionMin: number;
  stampDutyRate: number;
  transferFeeRate: number;
  enabled: boolean;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export class FeeCalculator {
  constructor(private readonly db: DbClient) {}

  async calculate(input: FeeInput): Promise<FeeBreakdown> {
    const rule = await this.matchRule(input);
    return this.applyRule(input, rule);
  }

  /** 批量版本：对一组 fill 输入一次性算手续费总和，复用 schedule 缓存 */
  async calculateBatch(inputs: FeeInput[]): Promise<FeeBreakdown[]> {
    if (inputs.length === 0) return [];
    const out: FeeBreakdown[] = [];
    for (const input of inputs) {
      out.push(await this.calculate(input));
    }
    return out;
  }

  /** 提取出来便于测试：让单测可以传入 fake schedule 验证匹配逻辑 */
  applyRule(input: FeeInput, rule: FeeRow | null): FeeBreakdown {
    if (!rule) {
      return { commission: 0, stampDuty: 0, transferFee: 0, total: 0, matchedRuleId: null };
    }
    const notional = Math.abs(input.qty) * input.price;
    let commission = notional * rule.commissionRate;
    if (rule.commissionMin > 0 && commission < rule.commissionMin) {
      commission = rule.commissionMin;
    }
    // 印花税：A 股仅卖出收，香港双向收 —— 由 schedule 行决定（卖向有 rate / 买向 rate=0）。
    const stampDuty = notional * rule.stampDutyRate;
    const transferFee = notional * rule.transferFeeRate;
    return {
      commission,
      stampDuty,
      transferFee,
      total: commission + stampDuty + transferFee,
      matchedRuleId: rule.id,
    };
  }

  /**
   * 按 (broker, market, asset_class, side) 找最高 priority 的 enabled 行。
   *
   * SQLite 不支持 `priority DESC NULLS LAST` 直接和复杂 ORDER BY 组合，
   * 这里用客户端 sort：拉所有可能匹配（精确 + 通配）一次性读出，
   * 在 JS 里按 priority 排序选第一个。schedule 行总数 ≤ ~20 ，性能可接受。
   */
  private async matchRule(input: FeeInput): Promise<FeeRow | null> {
    const asOf = input.asOf ?? new Date().toISOString();
    const rows = await this.db
      .select()
      .from(feeSchedule)
      .where(
        and(
          eq(feeSchedule.enabled, true),
          // broker: 精确 OR '*'
          or(eq(feeSchedule.broker, input.broker), eq(feeSchedule.broker, "*")),
          or(eq(feeSchedule.market, input.market), eq(feeSchedule.market, "*")),
          or(eq(feeSchedule.assetClass, input.assetClass), eq(feeSchedule.assetClass, "*")),
          or(eq(feeSchedule.side, input.side), eq(feeSchedule.side, "*")),
          // effective_from <= asOf
          lte(feeSchedule.effectiveFrom, asOf),
          // effective_to >= asOf 或为 NULL
          or(isNull(feeSchedule.effectiveTo), sql`${feeSchedule.effectiveTo} >= ${asOf}`)
        )
      )
      .all();

    if (rows.length === 0) return null;
    // 高 priority 优先；priority 相同时 effective_from 晚的优先（更新的）
    rows.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    });
    return rows[0] as unknown as FeeRow;
  }
}

/**
 * 实例化便捷工厂；保持与其他 attribution 工具一致的"直接传 db"用法，
 * 不做单例 cache（fee_schedule 不大，每次新建 calculator 没成本）。
 */
export function createFeeCalculator(db: DbClient): FeeCalculator {
  return new FeeCalculator(db);
}
