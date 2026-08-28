import { type NormalizedInstrumentSpec, contractNotional } from "./asset-lifecycle-model";

export interface FuturesMarginPosition {
  qty: number;
  marginBalance: number;
  settlementPrice: number;
}

export interface FuturesMarginRequirements {
  initial: number;
  maintenance: number;
}

export function isFuturesInstrument(spec: NormalizedInstrumentSpec): boolean {
  return spec.assetClass === "future";
}

export function futuresMarginRequirements(
  qty: number,
  price: number,
  spec: NormalizedInstrumentSpec
): FuturesMarginRequirements {
  const notional = Math.abs(contractNotional(qty, price, spec));
  return {
    initial: notional * (spec.initialMarginRate ?? 1),
    maintenance: notional * (spec.maintenanceMarginRate ?? 1),
  };
}

/** The equity represented by one futures position before daily settlement. */
export function futuresPositionEquity(
  position: FuturesMarginPosition,
  markPrice: number,
  spec: NormalizedInstrumentSpec
): number {
  return (
    position.marginBalance +
    contractNotional(position.qty, markPrice - position.settlementPrice, spec)
  );
}

/** Opens contracts in the same direction. Callers must close an opposite position first. */
export function openFuturesContracts(
  current: FuturesMarginPosition | undefined,
  signedQty: number,
  fillPrice: number,
  spec: NormalizedInstrumentSpec
): { position: FuturesMarginPosition; cashDelta: number } {
  const requirements = futuresMarginRequirements(signedQty, fillPrice, spec);
  if (!current || Math.abs(current.qty) < 1e-12) {
    return {
      position: { qty: signedQty, marginBalance: requirements.initial, settlementPrice: fillPrice },
      cashDelta: -requirements.initial,
    };
  }
  const totalQty = current.qty + signedQty;
  const totalAbs = Math.abs(totalQty);
  const addedAbs = Math.abs(signedQty);
  const oldAbs = Math.abs(current.qty);
  return {
    position: {
      qty: totalQty,
      marginBalance: current.marginBalance + requirements.initial,
      settlementPrice:
        totalAbs > 0
          ? (oldAbs * current.settlementPrice + addedAbs * fillPrice) / totalAbs
          : fillPrice,
    },
    cashDelta: -requirements.initial,
  };
}

/** Closes part or all of an existing futures position at a fill price. */
export function closeFuturesContracts(
  current: FuturesMarginPosition,
  closeQty: number,
  fillPrice: number,
  spec: NormalizedInstrumentSpec
): { position: FuturesMarginPosition | null; cashDelta: number } {
  const currentAbs = Math.abs(current.qty);
  const qty = Math.min(Math.abs(closeQty), currentAbs);
  const direction = Math.sign(current.qty);
  const realizedPnl = direction * contractNotional(qty, fillPrice - current.settlementPrice, spec);
  const releasedMargin = current.marginBalance * (qty / currentAbs);
  const remainingQty = current.qty - direction * qty;
  if (Math.abs(remainingQty) < 1e-12) {
    return { position: null, cashDelta: realizedPnl + releasedMargin };
  }
  return {
    position: {
      qty: remainingQty,
      marginBalance: current.marginBalance - releasedMargin,
      settlementPrice: current.settlementPrice,
    },
    cashDelta: realizedPnl + releasedMargin,
  };
}

export function settleFuturesPosition(
  current: FuturesMarginPosition,
  settlementPrice: number,
  spec: NormalizedInstrumentSpec
): { position: FuturesMarginPosition; variationPnl: number } {
  const variationPnl = contractNotional(
    current.qty,
    settlementPrice - current.settlementPrice,
    spec
  );
  return {
    position: {
      ...current,
      marginBalance: current.marginBalance + variationPnl,
      settlementPrice,
    },
    variationPnl,
  };
}
