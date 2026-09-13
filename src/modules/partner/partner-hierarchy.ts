/**
 * MULTI-LEVEL CTV (max 5 levels) — PURE hierarchy + commission math (Part E).
 *
 * COMMISSION ORIGIN: a real COMPLETED customer Order ONLY. Recruiting a
 * Partner NEVER pays anything. No AI involvement. Decimal math only.
 *
 * FIXED NETWORK COMMISSION (E2):
 *   L1 = $1.00, L2 = $0.40, L3 = $0.30, L4 = $0.20, L5 = $0.10
 *   Max network payout (all 5 levels) = $2.00.
 *   Missing upline is NEVER redistributed.
 * L1 EXTRA: 20% of the commissionable FX spread (E3) — no spread for L2-L5.
 * COMPANY/ADMIN BASE: $1.00 per COMPLETED Order — a REPORTING component,
 * never a payable PartnerSettlement commission row.
 *
 * FROZEN SPREAD BASIS (E3/E6): the Order's rateMarginSnapshot (baseRate +
 * buyMargin + sellMargin captured at Order creation from the authoritative
 * ExchangeRate row). Legacy Orders without the snapshot get fixed-only
 * commission with spreadBasis unavailable — nothing is invented.
 */
import { Decimal } from "decimal.js";

export const CTV_RULE_VERSION = "CTV_V2_5LEVEL_2026_09";
export const MAX_CTV_LEVELS = 5;
export const COMPANY_BASE_USD = "1";

/** E2 — exact fixed tier amounts (USD) per level. */
export const FIXED_COMMISSION_BY_LEVEL: Record<number, string> = {
  1: "1",
  2: "0.4",
  3: "0.3",
  4: "0.2",
  5: "0.1"
};

/** L1 spread share: 20% of the commissionable FX spread. */
export const L1_SPREAD_SHARE_PERCENT = "0.2";

/** Maximum payout depth INCLUDING the direct CTV. */
export function levelLimit(): number {
  return MAX_CTV_LEVELS;
}

/**
 * E1 — upline traversal from the direct (L1) partner through parents.
 * `parentByPartnerId` maps partnerId → parentPartnerId (or null).
 * Cycle-safe and depth-capped: a cyclic/over-deep chain simply stops.
 * Returns [{level, partnerId}] with level 1 = the direct Partner.
 */
export function getUplineChain(
  parentByPartnerId: Map<string, string | null>,
  directPartnerId: string
): { level: number; partnerId: string }[] {
  const chain: { level: number; partnerId: string }[] = [];
  const visited = new Set<string>();
  let current: string | null = directPartnerId;
  for (let level = 1; level <= MAX_CTV_LEVELS; level++) {
    if (!current || visited.has(current)) break; // missing link or cycle
    visited.add(current);
    chain.push({ level, partnerId: current });
    current = parentByPartnerId.get(current) ?? null;
  }
  return chain;
}

/**
 * E1 — validate a parent assignment: no self-parent, no cycles, and the
 * resulting chain from `partnerId` must not exceed MAX_CTV_LEVELS.
 * Returns an error message (Vietnamese) or null when valid.
 */
export function validateParentAssignment(
  parentByPartnerId: Map<string, string | null>,
  partnerId: string,
  newParentId: string | null
): string | null {
  if (newParentId === null) return null; // clearing is always safe
  if (newParentId === partnerId) return "CTV không thể là cha của chính nó.";
  // Walk up from the new parent: if we ever reach partnerId → cycle.
  const seen = new Set<string>([partnerId]);
  let current: string | null = newParentId;
  let depth = 0;
  while (current) {
    if (seen.has(current)) return "Gán quan hệ này sẽ tạo vòng lặp (cycle) trong mạng lưới CTV.";
    seen.add(current);
    depth++;
    if (depth > MAX_CTV_LEVELS) {
      return `Chuỗi tầng quá sâu (tối đa ${MAX_CTV_LEVELS} tầng trong mạng lưới chi trả).`;
    }
    current = parentByPartnerId.get(current) ?? null;
  }
  return null;
}

export interface RateMarginBasis {
  baseRate?: string;
  buyMargin?: string;
  sellMargin?: string;
}

export interface SpreadBasis {
  direction: "USD_TO_VND" | "VND_TO_USD";
  baseRate: string;
  margin: string;
  spreadVnd: string;
  commissionableSpreadUsd: string;
  sharePercent: string;
}

export interface SpreadShareResult {
  /** L1 spread share in USD (full internal precision) or null = unavailable. */
  shareUsd: Decimal | null;
  /** Frozen basis used (E6 transparency) or null when data was unavailable. */
  basis: SpreadBasis | null;
}

/**
 * E3 — commissionable FX spread from the FROZEN Order rate/margin snapshot.
 *   USD → VND: spreadVnd = sourceUsd × buyMargin;  commissionable = / baseRate
 *   VND → USD: spreadVnd = targetUsd × sellMargin; commissionable = / baseRate
 * Decimal ONLY. Missing/invalid frozen basis ⇒ { null, null } (do NOT invent).
 */
export function computeCommissionableSpread(order: {
  sourceCurrency: string;
  sourceAmount: unknown;
  targetCurrency: string;
  targetAmount: unknown;
  rateMarginSnapshot?: unknown;
}): SpreadShareResult {
  const snap = (order.rateMarginSnapshot ?? null) as RateMarginBasis | null;
  if (!snap || !snap.baseRate || !snap.buyMargin || !snap.sellMargin) {
    return { shareUsd: null, basis: null };
  }
  const baseRate = new Decimal(String(snap.baseRate));
  const buyMargin = new Decimal(String(snap.buyMargin));
  const sellMargin = new Decimal(String(snap.sellMargin));
  if (!baseRate.isFinite() || baseRate.lessThanOrEqualTo(0) || !buyMargin.isFinite() || !sellMargin.isFinite()) {
    return { shareUsd: null, basis: null };
  }

  let spreadVnd: Decimal | null = null;
  let direction: "USD_TO_VND" | "VND_TO_USD" | null = null;
  let margin: Decimal | null = null;
  if (order.sourceCurrency === "USD") {
    direction = "USD_TO_VND";
    margin = buyMargin;
    spreadVnd = new Decimal(String(order.sourceAmount ?? 0)).times(buyMargin);
  } else if (order.targetCurrency === "USD") {
    direction = "VND_TO_USD";
    margin = sellMargin;
    spreadVnd = new Decimal(String(order.targetAmount ?? 0)).times(sellMargin);
  }
  if (!spreadVnd || !direction || !margin) return { shareUsd: null, basis: null };

  const commissionableSpreadUsd = spreadVnd.dividedBy(baseRate);
  const basis: SpreadBasis = {
    direction,
    baseRate: baseRate.toString(),
    margin: margin.toString(),
    spreadVnd: spreadVnd.toString(),
    commissionableSpreadUsd: commissionableSpreadUsd.toString(),
    sharePercent: L1_SPREAD_SHARE_PERCENT
  };
  return { shareUsd: commissionableSpreadUsd.times(L1_SPREAD_SHARE_PERCENT), basis };
}

/** E6 — the frozen per-commission snapshot (immutable after creation). */
export function buildHierarchySnapshot(chain: { level: number; partnerId: string; displayName: string }[]): object {
  return {
    ruleVersion: CTV_RULE_VERSION,
    fixedByLevel: { 1: "1", 2: "0.4", 3: "0.3", 4: "0.2", 5: "0.1" },
    spreadSharePercent: L1_SPREAD_SHARE_PERCENT,
    companyBaseUsd: COMPANY_BASE_USD,
    chain: chain.map((c) => ({ level: c.level, partnerId: c.partnerId, displayName: c.displayName }))
  };
}

