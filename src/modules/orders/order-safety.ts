/**
 * Centralized authoritative Order cancellation / reminder / auto-cancel rules.
 *
 * SAFETY (Order cancellation + payment reminder hardening):
 * - This module is the SINGLE source of truth for which states allow customer
 *   cancel, admin cancel, payment reminders and auto-cancel. The customer
 *   handler, the admin handler and the scheduler MUST all call these helpers
 *   instead of duplicating state checks (requirement L).
 * - Rules are pure (no DB access) so they are testable and reusable; the
 *   callers are responsible for reloading the authoritative Order from the
 *   database BEFORE invoking them (stale reload = stale decision).
 * - The state machine is the real Prisma enum OrderStatus:
 *   WAITING_PAYMENT, CUSTOMER_SENT_BILL, WAITING_ADMIN_VERIFY,
 *   PAYMENT_CONFIRMED, WAITING_PAYOUT, PAYOUT_SENT, COMPLETED, CANCELLED,
 *   PAYMENT_MISMATCH, MANUAL_REVIEW, SUSPICIOUS.
 */

export type CancellationCode =
  | "ALLOWED"
  | "NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "COMPLETED"
  | "PAYOUT_SENT"
  | "PAYMENT_CONFIRMED"
  | "BILL_EXISTS"
  | "NOT_CANCELLABLE";

export interface CancellationDecision {
  allowed: boolean;
  code: CancellationCode;
  /** True when the order already carries customer bill/evidence. */
  billWarning: boolean;
}

export interface OrderSafetyInfo {
  status: string;
  customerBillFileId?: string | null;
  payoutBillFileId?: string | null;
  /** incoming payment verified by Admin (Authoritative field) */
  verifiedAt?: Date | string | null;
  payoutAt?: Date | string | null;
  completedAt?: Date | string | null;
  payoutBankSnapshot?: any;
  /** orderBillEvidence rows (OrderService.getOrder includes `bills`) */
  bills?: { id: string }[];
}

// ---------------------------------------------------------------------------
// Financial evidence detection
// ---------------------------------------------------------------------------

/**
 * True when the order already carries valid payment evidence (customer bill).
 * Any persisted evidence row or promoted primary reference counts. OCR/AI is
 * irrelevant — the ORIGINAL evidence is authoritative (requirement F).
 */
export function hasValidPaymentEvidence(order: OrderSafetyInfo | null | undefined): boolean {
  if (!order) return false;
  if (order.customerBillFileId) return true;
  if (Array.isArray(order.bills) && order.bills.length > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Reminder / auto-cancel eligibility (scheduler + handlers)
// ---------------------------------------------------------------------------

/**
 * An order is genuinely "waiting for customer transfer and/or bill" ONLY while
 * it is still WAITING_PAYMENT with no evidence. Every later state
 * (bill submitted, admin verified, manual review, payout, completed) stops the
 * reminders immediately (requirement C).
 */
export function isOrderPaymentReminderEligible(
  order: OrderSafetyInfo | null | undefined
): boolean {
  if (!order) return false;
  if (order.status !== "WAITING_PAYMENT") return false;
  if (order.verifiedAt) return false;
  if (order.completedAt) return false;
  return !hasValidPaymentEvidence(order);
}

/**
 * Auto-cancel guard (requirement D). NEVER auto-cancel:
 * CUSTOMER_SENT_BILL, WAITING_ADMIN_VERIFY, MANUAL_REVIEW, confirmed incoming
 * payment, WAITING_PAYOUT, PAYOUT_SENT, COMPLETED (or equivalents).
 * Only a still-WAITING_PAYMENT order with no evidence at all qualifies.
 */
export function isOrderSafelyAutoCancellable(
  order: OrderSafetyInfo | null | undefined
): boolean {
  if (!order) return false;
  if (!isOrderPaymentReminderEligible(order)) return false;
  if (order.verifiedAt) return false;
  // A confirmed payout destination implies incoming payment was verified —
  // such orders can never be in WAITING_PAYMENT, but guard anyway.
  if (order.payoutAt) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Customer cancellation (requirement A)
// ---------------------------------------------------------------------------

/**
 * Customer may cancel ONLY an active unpaid order:
 * - state exactly WAITING_PAYMENT (incoming payment NOT confirmed — every
 *   later state is excluded),
 * - no valid bill/evidence (with a bill uploaded the customer is directed to
 *   CSKH/Admin review instead of a normal cancel),
 * - never COMPLETED / CANCELLED / confirmed payment.
 */
export function canCustomerCancel(
  order: OrderSafetyInfo | null | undefined
): CancellationDecision {
  if (!order) {
    return { allowed: false, code: "NOT_FOUND", billWarning: false };
  }
  const billWarning = hasValidPaymentEvidence(order);

  if (order.status === "CANCELLED") {
    return { allowed: false, code: "ALREADY_CANCELLED", billWarning };
  }
  if (order.status === "COMPLETED") {
    return { allowed: false, code: "COMPLETED", billWarning };
  }
  if (billWarning) {
    // Bill already uploaded → normal cancellation must be blocked; route to
    // CSKH/Admin review (requirement A / L — never silently discard evidence).
    return { allowed: false, code: "BILL_EXISTS", billWarning: true };
  }
  if (order.status === "WAITING_PAYMENT" && !order.verifiedAt && !order.payoutAt && !order.completedAt) {
    return { allowed: true, code: "ALLOWED", billWarning: false };
  }
  // CUSTOMER_SENT_BILL / WAITING_ADMIN_VERIFY / PAYMENT_CONFIRMED /
  // WAITING_PAYOUT / PAYOUT_SENT / PAYMENT_MISMATCH / MANUAL_REVIEW /
  // SUSPICIOUS — payment side is in progress or confirmed: not customer-cancelable.
  if (["PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT"].includes(order.status) || order.verifiedAt) {
    return { allowed: false, code: "PAYMENT_CONFIRMED", billWarning };
  }
  return { allowed: false, code: "NOT_CANCELLABLE", billWarning };
}

// ---------------------------------------------------------------------------
// Admin cancellation (requirement B — FINANCIAL SAFETY BLOCKER fix)
// ---------------------------------------------------------------------------

/**
 * FINAL RULE (ADMIN OPERATIONS EXPANSION): Admin normal-cancel is a POWERFUL
 * operational tool — it covers fake/invalid bills, suspicious transactions,
 * operational problems and wrong customer info. It is allowed for EVERY state
 * BEFORE the payout has actually been sent, and BLOCKED once money left:
 *
 *   ALLOWED:  WAITING_PAYMENT, CUSTOMER_SENT_BILL, WAITING_ADMIN_VERIFY,
 *             PAYMENT_MISMATCH, MANUAL_REVIEW, SUSPICIOUS, PAYMENT_CONFIRMED,
 *             WAITING_PAYOUT (incl. verified payment / payout destination set)
 *   BLOCKED:  PAYOUT_SENT, COMPLETED, and ANY order with authoritative
 *             payout-sent evidence (payoutAt / payoutBillFileId) even if a
 *             stale status somehow says otherwise.
 *   CANCELLED remains idempotent (handled by the caller/service).
 *
 * Customer cancellation policy is UNCHANGED (unpaid + no evidence only).
 * When money was already verified but not yet paid out, the caller MUST warn
 * the Admin (see adminCancelSource / verified flags) — no automatic refund and
 * no automatic financial reversal ever happens here.
 */
export const ADMIN_CANCELLABLE_STATUSES = [
  "WAITING_PAYMENT",
  "CUSTOMER_SENT_BILL",
  "WAITING_ADMIN_VERIFY",
  "PAYMENT_MISMATCH",
  "MANUAL_REVIEW",
  "SUSPICIOUS",
  "PAYMENT_CONFIRMED",
  "WAITING_PAYOUT"
] as const;

export function isAdminCancellableStatus(status: string | null | undefined): boolean {
  return (ADMIN_CANCELLABLE_STATUSES as readonly string[]).includes(String(status || ""));
}

/**
 * True when the authoritative record proves the payout was ALREADY sent —
 * blocks a normal cancel even if the status is stale.
 */
export function payoutSentEvidence(order: OrderSafetyInfo | null | undefined): boolean {
  if (!order) return false;
  return Boolean(order.payoutAt) || Boolean(order.payoutBillFileId) || order.status === "PAYOUT_SENT";
}

/**
 * True when the incoming payment was verified / recorded (Admin verified it,
 * or the status itself implies verification). Used for the strong preview
 * warning and for choosing the audit source — never for auto-refunds.
 */
export function incomingPaymentVerified(order: OrderSafetyInfo | null | undefined): boolean {
  if (!order) return false;
  if (order.verifiedAt) return true;
  return ["PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT"].includes(String(order.status || ""));
}

export function canAdminCancel(
  order: OrderSafetyInfo | null | undefined
): CancellationDecision {
  if (!order) {
    return { allowed: false, code: "NOT_FOUND", billWarning: false };
  }
  const billWarning = hasValidPaymentEvidence(order);

  if (order.status === "CANCELLED") {
    return { allowed: false, code: "ALREADY_CANCELLED", billWarning };
  }
  if (order.status === "COMPLETED" || order.completedAt) {
    // COMPLETED — or a stale status carrying authoritative completion evidence —
    // can never be normal-cancelled.
    return { allowed: false, code: "COMPLETED", billWarning };
  }
  // Payout already sent (status OR authoritative evidence) — never a normal
  // cancel. Money has left; use the payout/reconciliation flows instead.
  if (payoutSentEvidence(order)) {
    return { allowed: false, code: "PAYOUT_SENT", billWarning };
  }
  if (!isAdminCancellableStatus(order.status)) {
    return { allowed: false, code: "NOT_CANCELLABLE", billWarning };
  }
  return { allowed: true, code: "ALLOWED", billWarning };
}

/**
 * Operational audit distinction (A4): UNPAID vs AFTER-PAYMENT admin cancels.
 * Pure metadata/source choice — no financial records are touched here.
 */
export function adminCancelSource(order: OrderSafetyInfo | null | undefined): string {
  return incomingPaymentVerified(order) ? "ADMIN_CANCELLED_AFTER_PAYMENT" : "ADMIN_CANCELLED_UNPAID";
}

/**
 * Free-form Admin cancel reason sanitizer (A2): trim, strip control chars,
 * cap length. Returns null when empty/oversized (caller prompts again).
 */
export const ADMIN_CANCEL_REASON_MAX_LEN = 300;

export function sanitizeAdminCancelReason(raw: string): string | null {
  const cleaned = String(raw || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > ADMIN_CANCEL_REASON_MAX_LEN) return null;
  return cleaned;
}

/** Human-readable source tags persisted in audit/state history metadata. */
export const CANCELLATION_SOURCES = {
  CUSTOMER: "CUSTOMER_CANCELLED",
  ADMIN: "ADMIN_CANCELLED",
  ADMIN_UNPAID: "ADMIN_CANCELLED_UNPAID",
  ADMIN_AFTER_PAYMENT: "ADMIN_CANCELLED_AFTER_PAYMENT",
  AUTO_TIMEOUT: "ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT"
} as const;
