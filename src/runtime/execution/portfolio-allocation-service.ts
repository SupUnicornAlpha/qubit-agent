export interface PortfolioCandidate {
  symbol: string;
  side: "long" | "short";
  price: number;
  stopLoss?: number | null;
  confidence: number;
  score?: number | null;
  proposedWeight?: number | null;
  currentQty?: number;
  sector?: string | null;
  beta?: number | null;
  styleExposures?: Record<string, number>;
  factorExposures?: Record<string, number>;
}

export interface PortfolioAllocationConfig {
  capital: number;
  grossLimit?: number;
  netLimit?: number;
  perPositionMax?: number;
  totalRiskBudget?: number;
  maxSectorGross?: number;
  defaultStopDistancePct?: number;
  correlationMatrix?: Record<string, Record<string, number>>;
}

export interface PortfolioAllocationRow {
  symbol: string;
  side: "long" | "short";
  price: number;
  targetWeight: number;
  targetNotional: number;
  targetQty: number;
  currentQty: number;
  rebalanceQty: number;
  riskContributionPct: number;
  sector: string;
  beta: number;
}

export interface PortfolioExposureReport {
  longGross: number;
  shortGross: number;
  grossExposure: number;
  netExposure: number;
  estimatedLossAtStopsPct: number;
  concentrationHhi: number;
  portfolioBeta: number;
  weightedAverageCorrelation: number | null;
  sectorGross: Record<string, number>;
  sectorNet: Record<string, number>;
  style: Record<string, number>;
  factor: Record<string, number>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function stopDistancePct(candidate: PortfolioCandidate, fallback: number): number {
  if (
    candidate.stopLoss != null &&
    Number.isFinite(candidate.stopLoss) &&
    candidate.stopLoss > 0 &&
    candidate.price > 0
  ) {
    return clamp(Math.abs(candidate.price - candidate.stopLoss) / candidate.price, 0.001, 1);
  }
  return fallback;
}

function scaleDominantSide(weights: number[], sides: Array<"long" | "short">, netLimit: number): void {
  const longGross = weights.reduce((sum, weight, index) => sum + (sides[index] === "long" ? weight : 0), 0);
  const shortGross = weights.reduce((sum, weight, index) => sum + (sides[index] === "short" ? weight : 0), 0);
  const net = longGross - shortGross;
  if (Math.abs(net) <= netLimit) return;
  if (net > netLimit && longGross > 0) {
    const targetLong = shortGross + netLimit;
    const scale = clamp(targetLong / longGross, 0, 1);
    weights.forEach((weight, index) => {
      if (sides[index] === "long") weights[index] = weight * scale;
    });
  } else if (net < -netLimit && shortGross > 0) {
    const targetShort = longGross + netLimit;
    const scale = clamp(targetShort / shortGross, 0, 1);
    weights.forEach((weight, index) => {
      if (sides[index] === "short") weights[index] = weight * scale;
    });
  }
}

export function allocatePortfolio(
  rawCandidates: PortfolioCandidate[],
  config: PortfolioAllocationConfig,
): {
  asof: string;
  config: Required<Omit<PortfolioAllocationConfig, "correlationMatrix">>;
  rows: PortfolioAllocationRow[];
  exposures: PortfolioExposureReport;
  warnings: string[];
} {
  if (!Number.isFinite(config.capital) || config.capital <= 0) {
    throw new Error("capital must be greater than zero");
  }
  const resolved = {
    capital: config.capital,
    grossLimit: clamp(config.grossLimit ?? 1, 0, 3),
    netLimit: clamp(config.netLimit ?? 1, 0, 3),
    perPositionMax: clamp(config.perPositionMax ?? 0.25, 0.001, 1),
    totalRiskBudget: clamp(config.totalRiskBudget ?? 0.02, 0.0001, 1),
    maxSectorGross: clamp(config.maxSectorGross ?? 0.4, 0.001, 3),
    defaultStopDistancePct: clamp(config.defaultStopDistancePct ?? 0.08, 0.001, 1),
  };
  const warnings: string[] = [];
  const seen = new Set<string>();
  const candidates = rawCandidates.filter((candidate) => {
    const symbol = normalizeSymbol(candidate.symbol);
    if (!symbol || seen.has(symbol) || !Number.isFinite(candidate.price) || candidate.price <= 0) {
      warnings.push(`ignored invalid or duplicate candidate: ${candidate.symbol || "<empty>"}`);
      return false;
    }
    seen.add(symbol);
    return true;
  });
  if (!candidates.length) {
    return {
      asof: new Date().toISOString(),
      config: resolved,
      rows: [],
      exposures: emptyExposure(),
      warnings: [...warnings, "no valid portfolio candidates"],
    };
  }

  const convictions = candidates.map((candidate) => {
    const confidence = clamp(candidate.confidence, 0, 1);
    const signal = candidate.score == null || !Number.isFinite(candidate.score)
      ? 1
      : Math.max(0.01, Math.abs(candidate.score));
    return Math.max(0.0001, confidence * signal);
  });
  const convictionTotal = convictions.reduce((sum, value) => sum + value, 0);
  const weights = candidates.map((candidate, index) => {
    const unconstrained = resolved.grossLimit * (convictions[index]! / convictionTotal);
    const candidateCap = candidate.proposedWeight == null || !Number.isFinite(candidate.proposedWeight)
      ? resolved.perPositionMax
      : Math.min(resolved.perPositionMax, Math.max(0, Math.abs(candidate.proposedWeight)));
    return Math.min(unconstrained, candidateCap);
  });

  const sectors = candidates.map((candidate) => candidate.sector?.trim() || "UNKNOWN");
  const sectorIndexes = new Map<string, number[]>();
  sectors.forEach((sector, index) => {
    const indexes = sectorIndexes.get(sector) ?? [];
    indexes.push(index);
    sectorIndexes.set(sector, indexes);
  });
  for (const [sector, indexes] of sectorIndexes) {
    const gross = indexes.reduce((sum, index) => sum + weights[index]!, 0);
    if (gross <= resolved.maxSectorGross) continue;
    const scale = resolved.maxSectorGross / gross;
    indexes.forEach((index) => { weights[index] = weights[index]! * scale; });
    warnings.push(`sector cap applied: ${sector}`);
  }

  const riskDistances = candidates.map((candidate) => stopDistancePct(candidate, resolved.defaultStopDistancePct));
  const estimatedRisk = weights.reduce((sum, weight, index) => sum + weight * riskDistances[index]!, 0);
  if (estimatedRisk > resolved.totalRiskBudget) {
    const scale = resolved.totalRiskBudget / estimatedRisk;
    weights.forEach((weight, index) => { weights[index] = weight * scale; });
    warnings.push("portfolio risk budget scaled target weights");
  }
  scaleDominantSide(weights, candidates.map((candidate) => candidate.side), resolved.netLimit);

  const rows = candidates.map((candidate, index): PortfolioAllocationRow => {
    const signedWeight = weights[index]! * (candidate.side === "short" ? -1 : 1);
    const targetNotional = signedWeight * resolved.capital;
    const targetQty = targetNotional / candidate.price;
    const currentQty = Number.isFinite(candidate.currentQty) ? Number(candidate.currentQty) : 0;
    return {
      symbol: normalizeSymbol(candidate.symbol),
      side: candidate.side,
      price: candidate.price,
      targetWeight: round(signedWeight),
      targetNotional: round(targetNotional, 2),
      targetQty: round(targetQty),
      currentQty: round(currentQty),
      rebalanceQty: round(targetQty - currentQty),
      riskContributionPct: round(weights[index]! * riskDistances[index]!),
      sector: sectors[index]!,
      beta: Number.isFinite(candidate.beta) ? Number(candidate.beta) : 1,
    };
  });
  const exposures = buildExposureReport(rows, candidates, config.correlationMatrix);
  exposures.estimatedLossAtStopsPct = round(
    weights.reduce((sum, weight, index) => sum + weight * riskDistances[index]!, 0),
  );
  return { asof: new Date().toISOString(), config: resolved, rows, exposures, warnings };
}

function emptyExposure(): PortfolioExposureReport {
  return {
    longGross: 0,
    shortGross: 0,
    grossExposure: 0,
    netExposure: 0,
    estimatedLossAtStopsPct: 0,
    concentrationHhi: 0,
    portfolioBeta: 0,
    weightedAverageCorrelation: null,
    sectorGross: {},
    sectorNet: {},
    style: {},
    factor: {},
  };
}

function buildExposureReport(
  rows: PortfolioAllocationRow[],
  candidates: PortfolioCandidate[],
  correlationMatrix?: Record<string, Record<string, number>>,
): PortfolioExposureReport {
  const exposure = emptyExposure();
  let correlationSum = 0;
  let correlationWeight = 0;
  rows.forEach((row, index) => {
    const grossWeight = Math.abs(row.targetWeight);
    exposure.longGross += row.targetWeight > 0 ? grossWeight : 0;
    exposure.shortGross += row.targetWeight < 0 ? grossWeight : 0;
    exposure.estimatedLossAtStopsPct += row.riskContributionPct;
    exposure.concentrationHhi += grossWeight ** 2;
    exposure.portfolioBeta += row.targetWeight * row.beta;
    exposure.sectorGross[row.sector] = (exposure.sectorGross[row.sector] ?? 0) + grossWeight;
    exposure.sectorNet[row.sector] = (exposure.sectorNet[row.sector] ?? 0) + row.targetWeight;
    for (const [name, loading] of Object.entries(candidates[index]?.styleExposures ?? {})) {
      exposure.style[name] = (exposure.style[name] ?? 0) + row.targetWeight * loading;
    }
    for (const [name, loading] of Object.entries(candidates[index]?.factorExposures ?? {})) {
      exposure.factor[name] = (exposure.factor[name] ?? 0) + row.targetWeight * loading;
    }
    for (let right = index + 1; right < rows.length; right += 1) {
      const correlation = correlationMatrix?.[row.symbol]?.[rows[right]!.symbol]
        ?? correlationMatrix?.[rows[right]!.symbol]?.[row.symbol];
      if (!Number.isFinite(correlation)) continue;
      const pairWeight = grossWeight * Math.abs(rows[right]!.targetWeight);
      correlationSum += Number(correlation) * pairWeight;
      correlationWeight += pairWeight;
    }
  });
  exposure.grossExposure = exposure.longGross + exposure.shortGross;
  exposure.netExposure = exposure.longGross - exposure.shortGross;
  exposure.weightedAverageCorrelation = correlationWeight > 0 ? correlationSum / correlationWeight : null;
  for (const record of [exposure.sectorGross, exposure.sectorNet, exposure.style, exposure.factor]) {
    Object.keys(record).forEach((key) => { record[key] = round(record[key]!); });
  }
  exposure.longGross = round(exposure.longGross);
  exposure.shortGross = round(exposure.shortGross);
  exposure.grossExposure = round(exposure.grossExposure);
  exposure.netExposure = round(exposure.netExposure);
  exposure.estimatedLossAtStopsPct = round(exposure.estimatedLossAtStopsPct);
  exposure.concentrationHhi = round(exposure.concentrationHhi);
  exposure.portfolioBeta = round(exposure.portfolioBeta);
  exposure.weightedAverageCorrelation = exposure.weightedAverageCorrelation == null
    ? null
    : round(exposure.weightedAverageCorrelation);
  return exposure;
}
