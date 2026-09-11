/**
 * Per-admin operations session state.
 *
 * SAFETY: scoped by ADMIN TELEGRAM ID. No global shared selectedOrder /
 * selectedCustomer / waitingForInput / currentAction. Two admins never
 * interfere with each other's workflow.
 *
 * Storage: process-memory Map (no Prisma schema change). On restart all
 * sessions are lost — the persistent keyboard + inline navigation let the
 * admin recover without guessing. This is intentionally separate from the
 * Prisma-backed AdminInputSession (used by the legacy REPLACE_GEMINI_KEY
 * flow) so this module stays dependency-free and testable.
 */

export type AdminSessionMode = "idle" | "search" | "rate_input" | "payout_evidence";
export type AdminSearchType = "order" | "customer";

export interface PendingFinancialAction {
  action: "confirm_payment" | "payout" | "complete_payout";
  orderId: string;
}

export interface AdminSession {
  mode: AdminSessionMode;
  /** Which entity the next freeform text should be interpreted for. */
  searchType: AdminSearchType | null;
  selectedOrderId: string | null;
  selectedCustomerId: string | null;
  /** Two-step financial action awaiting a final confirmation. */
  pendingFinancialAction: PendingFinancialAction | null;
  /** Message id of the current admin control panel (for re-rendering). */
  panelMessageId: number | null;
  panelChatId: number | null;
}

const sessions = new Map<string, AdminSession>();

function keyOf(telegramId: string): string {
  return String(telegramId || "").trim();
}

function emptySession(): AdminSession {
  return {
    mode: "idle",
    searchType: null,
    selectedOrderId: null,
    selectedCustomerId: null,
    pendingFinancialAction: null,
    panelMessageId: null,
    panelChatId: null
  };
}

/** Return the isolated session for one admin, creating an empty one on demand. */
export function getAdminSession(telegramId: string): AdminSession {
  const key = keyOf(telegramId);
  if (!key) return emptySession();
  let session = sessions.get(key);
  if (!session) {
    session = emptySession();
    sessions.set(key, session);
  }
  return session;
}

export function updateAdminSession(telegramId: string, patch: Partial<AdminSession>): AdminSession {
  const key = keyOf(telegramId);
  const next = { ...getAdminSession(telegramId), ...patch };
  if (key) sessions.set(key, next);
  return next;
}

/** Fully reset one admin's session (cancel / Menu Admin / terminal action). */
export function clearAdminSession(telegramId: string): void {
  sessions.delete(keyOf(telegramId));
}

/** Enter a freeform search mode for one admin. */
export function setAdminSearch(telegramId: string, searchType: AdminSearchType): void {
  updateAdminSession(telegramId, {
    mode: "search",
    searchType,
    pendingFinancialAction: null
  });
}

/** Record a two-step financial action awaiting final confirmation. */
export function setPendingFinancialAction(
  telegramId: string,
  action: PendingFinancialAction["action"],
  orderId: string
): void {
  updateAdminSession(telegramId, {
    mode: "idle",
    pendingFinancialAction: { action, orderId }
  });
}

export function clearPendingFinancialAction(telegramId: string): void {
  updateAdminSession(telegramId, { pendingFinancialAction: null });
}

/** Enter payout-evidence mode: the next valid photo/document attaches to this order. */
export function setPayoutEvidenceSession(telegramId: string, orderId: string): void {
  updateAdminSession(telegramId, {
    mode: "payout_evidence",
    selectedOrderId: orderId,
    selectedCustomerId: null,
    pendingFinancialAction: null
  });
}
