/**
 * VeighnaEmsProvider — VeighNa 实盘 EMS Provider 骨架
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §9（Live Trading）
 *
 * 当前实现：内存版 paper-trade（账户初始资金 / 持仓 / 订单状态都在进程内 Map 里）。
 * 后续扩展：
 *   - mode='paper'（默认）：完全本地模拟，无需 Python
 *   - mode='subprocess'：spawn python_connectors/veighna_ems_server.py 长驻进程，
 *     走 JSON-RPC 桥接 VeighNa 多 broker（CTP / SimNow / IB / IBKR / Tiger 等）
 *   - mode='rest'：直连 broker REST（暂不实现）
 *
 * 注册为 live_ems kind，priority 默认 50（高于 legacy_http_ems 的 10）。
 *
 * 接入 ExecutionDispatcher 由后续 M7+ 完成；此处仅注册到 ProviderRegistry，
 * UI 配置中心可见且 healthCheck 可探测。
 */

import {
  type LiveEmsProvider,
  type LiveOrderAck,
  type LiveOrderIntent,
  type LiveOrderStatus,
  type LiveOrderStatusInfo,
  type LiveAccountSnapshot,
  type LivePosition,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "live_ems",
  key: "veighna_ems",
  displayName: "VeighNa EMS（paper trade）",
  description:
    "内存 paper-trade 骨架；后续可切到 subprocess 模式接 VeighNa CTP/SimNow/IB 等 gateway。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "futures", "crypto"],
    features: ["paper_trade", "memory_oms", "veighna_bridge_ready"],
    performanceProfile: "neartime",
  },
  isBuiltin: true,
  isFallback: false,
};

interface AccountState {
  cash: number;
  startingCash: number;
  positions: Map<string, LivePosition>;
  /** brokerOrderId → status 详情 */
  orders: Map<
    string,
    {
      info: LiveOrderStatusInfo;
      intent: LiveOrderIntent;
    }
  >;
  updatedAt: string;
}

export class VeighnaEmsProvider implements LiveEmsProvider {
  readonly meta = META;

  /** accountRef → state（内存账户） */
  private accounts = new Map<string, AccountState>();

  private nextOrderSeq = 1;

  /** Mode：paper / subprocess（subprocess 未实现，会回退 paper） */
  private mode: "paper" | "subprocess" = "paper";

  constructor(opts?: { mode?: "paper" | "subprocess"; startingCash?: number }) {
    if (opts?.mode === "subprocess") {
      // 占位：真正 subprocess 模式需要 spawn python_connectors/veighna_ems_server.py
      this.mode = "paper"; // 暂时降级
    }
    this.startingCash = opts?.startingCash ?? 1_000_000;
  }

  private startingCash: number;

  async healthCheck(): Promise<{ ok: boolean; meta?: Record<string, unknown> }> {
    // paper mode 永远 healthy；subprocess 模式后续检查 python 进程
    return { ok: true, meta: { mode: this.mode } };
  }

  private getOrInitAccount(ref: string): AccountState {
    let s = this.accounts.get(ref);
    if (!s) {
      s = {
        cash: this.startingCash,
        startingCash: this.startingCash,
        positions: new Map(),
        orders: new Map(),
        updatedAt: new Date().toISOString(),
      };
      this.accounts.set(ref, s);
    }
    return s;
  }

  private positionKey(symbol: string, exchange: string): string {
    return `${symbol}@${exchange}`;
  }

  async submitOrder(intent: LiveOrderIntent): Promise<LiveOrderAck> {
    if (this.mode !== "paper") {
      // future: send via subprocess
    }
    const acct = this.getOrInitAccount(intent.accountRef);
    const brokerOrderId = `vn_${Date.now()}_${this.nextOrderSeq++}`;
    const acceptedAt = new Date().toISOString();

    // Paper 立即 fill 市价单；限价单标 submitted（不撮合，按 limitPrice 假成交）
    const fillPrice =
      intent.orderType === "limit" && typeof intent.limitPrice === "number"
        ? intent.limitPrice
        : this.fakeMarketPrice(intent.symbol);

    const notional = fillPrice * intent.quantity;
    const status: LiveOrderStatus = "filled";

    // 更新现金与持仓
    if (intent.side === "buy") {
      if (acct.cash < notional) {
        const info: LiveOrderStatusInfo = {
          brokerOrderId,
          status: "rejected",
          filledQty: 0,
          avgPrice: 0,
          updatedAt: acceptedAt,
        };
        acct.orders.set(brokerOrderId, { info, intent });
        acct.updatedAt = acceptedAt;
        return {
          brokerOrderId,
          status: "rejected",
          acceptedAt,
        };
      }
      acct.cash -= notional;
      const key = this.positionKey(intent.symbol, intent.exchange);
      const cur = acct.positions.get(key);
      if (!cur) {
        acct.positions.set(key, {
          symbol: intent.symbol,
          exchange: intent.exchange,
          quantity: intent.quantity,
          avgCost: fillPrice,
          marketPrice: fillPrice,
          unrealizedPnl: 0,
        });
      } else {
        const total = cur.quantity + intent.quantity;
        cur.avgCost =
          total > 0 ? (cur.avgCost * cur.quantity + fillPrice * intent.quantity) / total : 0;
        cur.quantity = total;
        cur.marketPrice = fillPrice;
      }
    } else {
      // sell
      const key = this.positionKey(intent.symbol, intent.exchange);
      const cur = acct.positions.get(key);
      if (!cur || cur.quantity < intent.quantity) {
        const info: LiveOrderStatusInfo = {
          brokerOrderId,
          status: "rejected",
          filledQty: 0,
          avgPrice: 0,
          updatedAt: acceptedAt,
        };
        acct.orders.set(brokerOrderId, { info, intent });
        acct.updatedAt = acceptedAt;
        return { brokerOrderId, status: "rejected", acceptedAt };
      }
      acct.cash += notional;
      cur.quantity -= intent.quantity;
      cur.marketPrice = fillPrice;
      if (cur.quantity === 0) {
        acct.positions.delete(key);
      }
    }

    const info: LiveOrderStatusInfo = {
      brokerOrderId,
      status,
      filledQty: intent.quantity,
      avgPrice: fillPrice,
      updatedAt: acceptedAt,
    };
    acct.orders.set(brokerOrderId, { info, intent });
    acct.updatedAt = acceptedAt;

    return {
      brokerOrderId,
      status,
      acceptedAt,
      filledQty: intent.quantity,
      avgPrice: fillPrice,
    };
  }

  async cancelOrder(input: {
    brokerOrderId: string;
    accountRef: string;
  }): Promise<{ ok: boolean; status: LiveOrderStatus }> {
    const acct = this.accounts.get(input.accountRef);
    if (!acct) return { ok: false, status: "rejected" };
    const ent = acct.orders.get(input.brokerOrderId);
    if (!ent) return { ok: false, status: "rejected" };
    if (ent.info.status === "filled" || ent.info.status === "cancelled") {
      return { ok: false, status: ent.info.status };
    }
    ent.info.status = "cancelled";
    ent.info.updatedAt = new Date().toISOString();
    return { ok: true, status: "cancelled" };
  }

  async getOrderStatus(input: {
    brokerOrderId: string;
    accountRef: string;
  }): Promise<LiveOrderStatusInfo> {
    const acct = this.accounts.get(input.accountRef);
    const ent = acct?.orders.get(input.brokerOrderId);
    if (!ent) {
      return {
        brokerOrderId: input.brokerOrderId,
        status: "rejected",
        filledQty: 0,
        avgPrice: 0,
        updatedAt: new Date().toISOString(),
      };
    }
    return ent.info;
  }

  async getAccountSnapshot(input: { accountRef: string }): Promise<LiveAccountSnapshot> {
    const acct = this.getOrInitAccount(input.accountRef);
    const positions = Array.from(acct.positions.values());
    let equity = acct.cash;
    for (const p of positions) {
      const px = p.marketPrice ?? p.avgCost;
      equity += px * p.quantity;
      p.unrealizedPnl = (px - p.avgCost) * p.quantity;
    }
    return {
      accountRef: input.accountRef,
      cash: acct.cash,
      equity,
      marginUsed: 0,
      positions,
      updatedAt: acct.updatedAt,
    };
  }

  /** 仅 paper trade 用：fake 一个市价（基于种子的伪随机数） */
  private fakeMarketPrice(symbol: string): number {
    // 用 symbol hash + 微小波动模拟价格，保证可复现
    let h = 0;
    for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0;
    const base = 50 + Math.abs(h % 500);
    const tick = ((Date.now() / 1000) % 60) / 60;
    return Number((base * (1 + tick * 0.01)).toFixed(2));
  }
}
