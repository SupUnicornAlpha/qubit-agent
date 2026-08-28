export interface BlackScholesInput {
  right: "call" | "put";
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  impliedVolatility: number;
  riskFreeRateAnnual: number;
  dividendYield?: number;
}

export interface BlackScholesGreeks {
  theoreticalPrice: number;
  delta: number;
  gamma: number;
  thetaPerDay: number;
  /** P&L for a one percentage-point IV move, per option unit. */
  vegaPerPoint: number;
}

/**
 * European Black–Scholes approximation used exclusively for auditable risk exposure.
 * It never replaces the snapshot option price used for fills or valuation.
 */
export function calculateBlackScholesGreeks(input: BlackScholesInput): BlackScholesGreeks | null {
  const {
    spot,
    strike,
    timeToExpiryYears: t,
    impliedVolatility: sigma,
    riskFreeRateAnnual: r,
  } = input;
  const q = input.dividendYield ?? 0;
  if (
    !(spot > 0) ||
    !(strike > 0) ||
    !(t > 0) ||
    !(sigma > 0) ||
    !Number.isFinite(r) ||
    !Number.isFinite(q)
  ) {
    return null;
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = normalCdf(d1);
  const nd2 = normalCdf(d2);
  const pdfD1 = normalPdf(d1);
  const discountedSpot = spot * Math.exp(-q * t);
  const discountedStrike = strike * Math.exp(-r * t);
  const commonTheta = -(discountedSpot * pdfD1 * sigma) / (2 * sqrtT);

  if (input.right === "call") {
    return {
      theoreticalPrice: discountedSpot * nd1 - discountedStrike * nd2,
      delta: Math.exp(-q * t) * nd1,
      gamma: (Math.exp(-q * t) * pdfD1) / (spot * sigma * sqrtT),
      thetaPerDay: (commonTheta - r * discountedStrike * nd2 + q * discountedSpot * nd1) / 365,
      vegaPerPoint: (discountedSpot * pdfD1 * sqrtT) / 100,
    };
  }
  return {
    theoreticalPrice: discountedStrike * normalCdf(-d2) - discountedSpot * normalCdf(-d1),
    delta: Math.exp(-q * t) * (nd1 - 1),
    gamma: (Math.exp(-q * t) * pdfD1) / (spot * sigma * sqrtT),
    thetaPerDay:
      (commonTheta + r * discountedStrike * normalCdf(-d2) - q * discountedSpot * normalCdf(-d1)) /
      365,
    vegaPerPoint: (discountedSpot * pdfD1 * sqrtT) / 100,
  };
}

export function yearsToExpiry(date: string, expiryDate: string): number {
  const current = Date.parse(`${date}T00:00:00Z`);
  const expiry = Date.parse(`${expiryDate}T00:00:00Z`);
  if (!Number.isFinite(current) || !Number.isFinite(expiry) || expiry <= current) return 0;
  return (expiry - current) / 86_400_000 / 365;
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normalCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26, enough for risk-reporting precision and deterministic.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
