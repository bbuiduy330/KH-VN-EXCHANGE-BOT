/**
 * Customer mini-CRM — PURE, deterministic overview helpers (Part B).
 *
 * Advisory UI only: the outputs NEVER block an Order and are NEVER financial
 * authority; AI is not involved anywhere. Everything is computed from the
 * authoritative DB rows the caller loads on demand (no new schema).
 */
import { Decimal } from "decimal.js";

/** Nonterminal operational statuses ("⏳ Active" bucket + history filter). */
export const CRM_ACTIVE_STATUSES = [
  "WAITING_PAYMENT",
  "CUSTOMER_SENT_BILL",
  "WAITING_ADMIN_VERIFY",
  "PAYMENT_CONFIRMED",
  "WAITING_PAYOUT",
  "PAYOUT_SENT",
  "PAYMENT_MISMATCH",
  "MANUAL_REVIEW",
  "SUSPICIOUS"
] as const;

/** B4 — status icon map (single source for every customer history row). */
export function orderStatusIcon(status: string | null | undefined): string {
  switch (String(status || "")) {
    case "COMPLETED": return "✅";
    case "CANCELLED": return "❌";
    case "CUSTOMER_SENT_BILL":
    case "WAITING_ADMIN_VERIFY": return "🧾";
    case "PAYMENT_CONFIRMED":
    case "WAITING_PAYOUT":
    case "PAYOUT_SENT": return "💸";
    case "PAYMENT_MISMATCH":
    case "MANUAL_REVIEW": return "⚠️";
    case "SUSPICIOUS": return "🚨";
    default: return "⏳";
  }
}

export interface CrmStats {
  completed: number;
  cancelled: number;
  active: number;
  /** CANCELLED / (COMPLETED + CANCELLED) as a whole percent; null when no terminal orders. */
  cancellationRatePct: number | null;
}

export function computeCrmStats(orders: { status: string }[]): CrmStats {
  let completed = 0;
  let cancelled = 0;
  let active = 0;
  for (const o of orders || []) {
    if (o.status === "COMPLETED") completed++;
    else if (o.status === "CANCELLED") cancelled++;
    else if ((CRM_ACTIVE_STATUSES as readonly string[]).includes(String(o.status))) active++;
  }
  const terminal = completed + cancelled;
  return {
    completed,
    cancelled,
    active,
    // Never show a fake 0% for customers with no terminal orders:
    cancellationRatePct: terminal === 0 ? null : Math.round((cancelled / terminal) * 100)
  };
}

export interface CompletedVolume {
  /** Total COMPLETED source USD (USD → VND direction), as a plain string. */
  usdToVnd: string | null;
  /** Total COMPLETED source VND (VND → USD direction), as a plain string. */
  vndToUsd: string | null;
}

/**
 * B2 — COMPLETED volume by direction. USD and VND are NEVER summed together:
 * each direction shows its own source-currency total (existing MoneyService
 * formatting is applied by the caller).
 */
export function computeCompletedVolume(orders: { status: string; sourceCurrency: string; sourceAmount: unknown }[]): CompletedVolume {
  let usd = new Decimal(0);
  let vnd = new Decimal(0);
  for (const o of orders || []) {
    if (o.status !== "COMPLETED") continue;
    if (String(o.sourceCurrency) === "USD") usd = usd.plus(new Decimal(String(o.sourceAmount ?? 0)));
    else if (String(o.sourceCurrency) === "VND") vnd = vnd.plus(new Decimal(String(o.sourceAmount ?? 0)));
  }
  return {
    usdToVnd: usd.greaterThan(0) ? usd.toString() : null,
    vndToUsd: vnd.greaterThan(0) ? vnd.toString() : null
  };
}

export type CrmRiskLevel = "HIGH" | "WATCH" | "NORMAL";

export interface CrmRisk {
  level: CrmRiskLevel;
  /** Always populated reasons (Vietnamese, Admin-facing). */
  reasons: string[];
}

/**
 * B3 — deterministic, transparent risk signals (UI advisory only):
 *  HIGH : customer currently/ever had a SUSPICIOUS order.
 *  WATCH: PAYMENT_MISMATCH or MANUAL_REVIEW history, OR cancellation rate
 *         ≥ 40% with ≥ 3 terminal orders.
 * Volume/newness/CTV attribution are deliberately NOT risk signals.
 */
export function computeRiskLevel(orders: { status: string }[]): CrmRisk {
  const reasons: string[] = [];
  let suspicious = 0;
  let mismatch = 0;
  let review = 0;
  for (const o of orders || []) {
    if (o.status === "SUSPICIOUS") suspicious++;
    else if (o.status === "PAYMENT_MISMATCH") mismatch++;
    else if (o.status === "MANUAL_REVIEW") review++;
  }
  if (suspicious > 0) reasons.push(`${suspicious} đơn SUSPICIOUS`);
  if (mismatch > 0) reasons.push(`${mismatch} lần PAYMENT_MISMATCH`);
  if (review > 0) reasons.push(`${review} lần MANUAL_REVIEW`);

  const stats = computeCrmStats(orders);
  const terminal = stats.completed + stats.cancelled;
  if (stats.cancellationRatePct !== null && stats.cancellationRatePct >= 40 && terminal >= 3) {
    reasons.push(`Tỷ lệ hủy ${stats.cancellationRatePct}% (${stats.cancelled}/${terminal})`);
  }

  if (suspicious > 0) return { level: "HIGH", reasons };
  if (reasons.length > 0) return { level: "WATCH", reasons };
  return { level: "NORMAL", reasons: [] };
}
