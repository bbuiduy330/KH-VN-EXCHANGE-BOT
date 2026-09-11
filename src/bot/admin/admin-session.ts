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

export interface AdminWizard {
  /** Which wizard owns the next freeform text input. */
  kind: string;
  step: number;
  data: Record<string, any>;
}

export interface PendingAction {
  action: string;
  targetId: string;
  timestamp: number;
}

export interface AdminSession {
  mode: AdminSessionMode;
  /** Which entity the next freeform text should be interpreted for. */
  searchType: AdminSearchType | null;
  selectedOrderId: string | null;
  selectedCustomerId: string | null;
  /** Two-step financial action awaiting a final confirmation. */
  pendingFinancialAction: PendingFinancialAction | null;
  /** Two-step non-financial action awaiting a final confirmation. */
  pendingAction: PendingAction | null;
  /** Multi-step input wizard (rate/account/staff/ai/config). */
  wizard: AdminWizard | null;
  /** Epoch ms the session was (re)created, for timeout safety. */
  createdAt: number;
  /** Message id of the current admin control panel (for re-rendering). */
  panelMessageId: number | null;
  panelChatId: number | null;
}

/** Sensitive pending actions expire after 10 minutes (no persisted schema). */
export const ADMIN_WIZARD_TIMEOUT_MS = 10 * 60 * 1000;

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
    pendingAction: null,
    wizard: null,
    createdAt: Date.now(),
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
    pendingFinancialAction: null,
    wizard: null
  });
}

// ---------------------------------------------------------------------------
// Multi-step wizard helpers (rate / account / staff / ai / config)
// ---------------------------------------------------------------------------

export function startWizard(telegramId: string, kind: string, data: Record<string, any> = {}): void {
  updateAdminSession(telegramId, {
    mode: "rate_input",
    wizard: { kind, step: 1, data },
    searchType: null,
    pendingFinancialAction: null,
    createdAt: Date.now()
  });
}

export function updateWizard(telegramId: string, patch: { step?: number; data?: Record<string, any> }): AdminWizard | null {
  const session = getAdminSession(telegramId);
  if (!session.wizard) return null;
  const next: AdminWizard = {
    kind: session.wizard.kind,
    step: patch.step ?? session.wizard.step,
    data: { ...(session.wizard.data || {}), ...(patch.data || {}) }
  };
  updateAdminSession(telegramId, { wizard: next, createdAt: Date.now() });
  return next;
}

export function clearWizard(telegramId: string): void {
  updateAdminSession(telegramId, { wizard: null, mode: "idle" });
}

/** True when the session has exceeded the wizard timeout (callers must reload state). */
export function isSessionExpired(telegramId: string): boolean {
  const session = getAdminSession(telegramId);
  return Date.now() - session.createdAt > ADMIN_WIZARD_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Callback-only two-step actions (no text wizard) still get expiry protection.
// ---------------------------------------------------------------------------

/** Record a two-step action awaiting final confirmation (with its own timestamp). */
export function setPendingAction(telegramId: string, action: string, targetId: string): void {
  updateAdminSession(telegramId, {
    pendingAction: { action, targetId, timestamp: Date.now() }
  });
}

/**
 * Validate + consume a two-step action. Returns:
 * - valid:false, expired:true  → the preview is older than the timeout
 * - valid:false, expired:false → no matching pending action
 * - valid:true,  expired:false → ok to proceed
 * Always clears the pending action.
 */
export function consumePendingAction(
  telegramId: string,
  action: string,
  targetId: string
): { valid: boolean; expired: boolean } {
  const session = getAdminSession(telegramId);
  const pending = session.pendingAction;
  updateAdminSession(telegramId, { pendingAction: null });
  if (!pending) return { valid: false, expired: false };
  const expired = Date.now() - pending.timestamp > ADMIN_WIZARD_TIMEOUT_MS;
  if (expired) return { valid: false, expired: true };
  const match = pending.action === action && pending.targetId === targetId;
  return { valid: match, expired: false };
}
