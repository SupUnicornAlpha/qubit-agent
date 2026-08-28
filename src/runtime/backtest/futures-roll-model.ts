import type { BacktestInstrumentSpec } from "../provider/types";

export interface FutureRollInstruction {
  rollDate: string;
  successorSymbol: string;
}

/** Resolve an explicit roll chain without inferring anything from contract codes. */
export function resolveFutureRollSymbol(
  symbol: string,
  date: string,
  instruments?: Record<string, BacktestInstrumentSpec>
): string {
  let current = symbol;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const roll = instruments?.[current]?.futureRoll;
    if (!roll || date < roll.rollDate || !roll.successorSymbol.trim()) return current;
    current = roll.successorSymbol.trim();
  }
  return current;
}

export function shouldRollFuture(
  spec: BacktestInstrumentSpec | undefined,
  date: string
): spec is BacktestInstrumentSpec & { futureRoll: FutureRollInstruction } {
  return Boolean(
    spec?.assetClass === "future" &&
      spec.futureRoll?.successorSymbol.trim() &&
      spec.futureRoll.rollDate === date
  );
}

/** Preserve underlying contract exposure across an explicit roll; never round a new lot upward. */
export function rollSuccessorQuantity(input: {
  oldQuantity: number;
  oldMultiplier: number;
  successorMultiplier: number;
  successorLotSize?: number;
}): number {
  if (
    !Number.isFinite(input.oldQuantity) ||
    !Number.isFinite(input.oldMultiplier) ||
    !Number.isFinite(input.successorMultiplier) ||
    input.oldMultiplier <= 0 ||
    input.successorMultiplier <= 0
  ) {
    return 0;
  }
  const raw = Math.abs((input.oldQuantity * input.oldMultiplier) / input.successorMultiplier);
  const lot = input.successorLotSize;
  const quantity = lot && lot > 0 ? Math.floor(raw / lot) * lot : raw;
  return quantity === 0 ? 0 : Math.sign(input.oldQuantity) * quantity;
}
