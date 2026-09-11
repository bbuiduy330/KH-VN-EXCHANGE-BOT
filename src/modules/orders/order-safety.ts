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
 * FINAL RULE (financial safety audit): a normal Admin "❌ Huỷ đơn" is ONLY
 * allowed for a SAFELY UNPAID order — the same authoritative financial-safety
 * principle as the customer rule:
 *
 *   status === WAITING_PAYMENT
 *   AND no bill/evidence (no customerBillFileId, no orderBillEvidence rows)
 *   AND no verifiedAt (incoming payment NOT confirmed)
 *   AND no payoutAt / completedAt
 *
 * For every state where payment evidence exists or money may already have
 * arrived (CUSTOMER_SENT_BILL, WAITING_ADMIN_VERIFY, PAYMENT_MISMATCH,
 * MANUAL_REVIEW, SUSPICIOUS, PAYMENT_CONFIRMED, WAITING_PAYOUT, PAYOUT_SENT,
 * COMPLETED) a normal CANCELLED transition is BLOCKED. Admin must use the
 * existing safe flows instead:
 *   - "❌ Chưa nhận được tiền" (ops:pay:not_received) for bill-present states,
 *   - manualFinancialOverride (manual review) for confirmed-money states.
 * All evidence and financial history is preserved — nothing is discarded.
 */
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
  if (order.status === "COMPLETED") {
    return { allowed: false, code: "COMPLETED", billWarning };
  }
  // Confirmed incoming money — never a normal cancel. The existing financial
  // workflow for these states is manualFinancialOverride / manual review.
  if (["PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT"].includes(order.status) || order.verifiedAt || order.payoutAt) {
    return { allowed: false, code: "PAYMENT_CONFIRMED", billWarning };
  }
  // Evidence exists (bill submitted / mismatch) — money MAY have arrived:
  // a normal cancel must never silently discard the evidence. Route Admin to
  // the existing manual-review / not-received flow instead.
  if (billWarning) {
    return { allowed: false, code: "BILL_EXISTS", billWarning: true };
  }
  if (order.status === "WAITING_PAYMENT") {
    return { allowed: true, code: "ALLOWED", billWarning: false };
  }
  // CUSTOMER_SENT_BILL / WAITING_ADMIN_VERIFY / PAYMENT_MISMATCH /
  // MANUAL_REVIEW / SUSPICIOUS (without promoted evidence) — manual-review
  // territory, never an ordinary cancellation.
  return { allowed: false, code: "NOT_CANCELLABLE", billWarning };
}

// ---------------------------------------------------------------------------
// Admin cancel reason presets (operational UI stays Vietnamese)
// ---------------------------------------------------------------------------

export const ADMIN_CANCEL_REASONS: { key: string; label: string }[] = [
  { key: "customer_request", label: "Khách yêu cầu hủy đơn" },
  { key: "wrong_rate", label: "Tạo nhầm đơn / tỷ giá sai" },
  { key: "no_payment", label: "Khách không chuyển tiền" },
  { key: "test_order", label: "Đơn thử nghiệm" }
];

export function adminCancelReasonLabel(key: string, customReason?: string): string {
  if (key === "custom") return customReason?.trim() || "Lý do khác";
  return ADMIN_CANCEL_REASONS.find((r) => r.key === key)?.label || customReason?.trim() || key;
}

/** Human-readable source tags persisted in audit/state history metadata. */
export const CANCELLATION_SOURCES = {
  CUSTOMER: "CUSTOMER_CANCELLED",
  ADMIN: "ADMIN_CANCELLED",
  AUTO_TIMEOUT: "ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT"
} as const;
