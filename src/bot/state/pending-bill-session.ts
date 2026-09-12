/**
 * Per-customer PENDING-BILL session state.
 *
 * SAFETY (multi-order bill routing):
 * - When a customer has MULTIPLE billable Orders, the bot must NEVER guess
 *   which Order an incoming payment bill belongs to (financial routing).
 * - Instead, the incoming Telegram media is preserved as a short-lived
 *   session reference (Telegram file_id + safe media metadata — never the
 *   media itself) and the customer is shown an explicit Order chooser.
 * - The evidence is only persisted AFTER the customer selects the Order
 *   (customer:bill:attach) — ambiguous media is never attached to an
 *   arbitrary Order.
 * - The customer never needs to re-send the image: the stored Telegram
 *   file_id is re-downloaded at submission time.
 * - Storage: process-memory Map (no schema change). Sessions expire after
 *   10 minutes or on restart — the customer simply re-sends the photo.
 * - Scoped strictly by CUSTOMER TELEGRAM ID; two customers can never
 *   interfere with each other's pending bill.
 */

export type PendingBillMediaType = "photo" | "document";

export interface PendingBillSession {
  /** Telegram file reference — re-downloaded at submission, never stored media. */
  fileId: string;
  mediaType: PendingBillMediaType;
  /** Safe metadata hints for evidence MIME resolution. */
  telegramMime?: string | null;
  fileName?: string | null;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

const sessions = new Map<string, PendingBillSession>();

function keyOf(telegramId: string): string {
  return String(telegramId || "").trim();
}

export function setPendingBillSession(
  telegramId: string,
  data: {
    fileId: string;
    mediaType: PendingBillMediaType;
    telegramMime?: string | null;
    fileName?: string | null;
  }
): void {
  const key = keyOf(telegramId);
  if (!key || !data.fileId) return;
  sessions.set(key, { ...data, createdAt: Date.now() });
}

/**
 * Fetch the customer's ACTIVE pending-bill session (expired sessions are
 * dropped). Returns null when there is no session — callers must then treat
 * the selection as expired and ask the customer to re-send the media.
 */
export function getPendingBillSession(telegramId: string): PendingBillSession | null {
  const key = keyOf(telegramId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(key);
    return null;
  }
  return s;
}

// ---------------------------------------------------------------------------
// ATOMIC take / finish (reliability fix for the pending-bill flow)
//
// The pending session must NEVER be lost when bill persistence fails:
//   - takePendingBillSession atomically MOVES the session out of the ready
//     map into an in-flight slot: a concurrent second callback (double-click)
//     can neither take it again (no double attach) nor see "expired".
//   - While in flight, the media is owned by exactly one processing attempt.
//   - finishPendingBill(release) decides the outcome AFTER persistence:
//       restore=false → success: the session is gone for good (cleared).
//       restore=true  → failure: the ORIGINAL session (with its original
//                        createdAt — the TTL is never extended) is put back
//                        so the customer can retry WITHOUT re-sending.
//     Restore is skipped if a NEWER photo already placed a fresh session.
//   - clearPendingBillSession also cancels the in-flight slot, so a
//     superseding direct attach can never resurrect a stale session.
// ---------------------------------------------------------------------------

export type PendingBillTake =
  | { state: "taken"; session: PendingBillSession }
  | { state: "in_flight" }
  | { state: "none" };

const inFlight = new Map<string, PendingBillSession>();

/** Atomically take (consume) the pending session for ONE processing attempt. */
export function takePendingBillSession(telegramId: string): PendingBillTake {
  const key = keyOf(telegramId);
  const s = sessions.get(key);
  if (s) {
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      sessions.delete(key);
      return { state: "none" };
    }
    sessions.delete(key);
    inFlight.set(key, s);
    return { state: "taken", session: s };
  }
  return inFlight.has(key) ? { state: "in_flight" } : { state: "none" };
}

/**
 * Close ONE processing attempt opened by takePendingBillSession.
 * `restore=true` returns the ORIGINAL media reference to the ready map so the
 * customer can retry without re-sending; restore never clobbers a newer
 * pending session and never resurrects a superseded (cleared) attempt.
 */
export function finishPendingBill(telegramId: string, taken: PendingBillSession, restore: boolean): void {
  const key = keyOf(telegramId);
  if (inFlight.get(key) !== taken) return; // superseded meanwhile — do nothing
  inFlight.delete(key);
  if (restore && !sessions.has(key)) {
    sessions.set(key, taken);
  }
}

/** True while a taken pending session is being processed (double-click guard). */
export function isPendingBillInFlight(telegramId: string): boolean {
  return inFlight.has(keyOf(telegramId));
}

export function clearPendingBillSession(telegramId: string): void {
  const key = keyOf(telegramId);
  sessions.delete(key);
  inFlight.delete(key);
}
