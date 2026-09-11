/**
 * Per-customer input session state.
 *
 * SAFETY (Customer payout UX hardening):
 * - Scoped strictly by CUSTOMER TELEGRAM ID. No global session shared between
 *   customers; two customers can never overwrite each other's payout details.
 * - The session BINDS free-form payout text / payout QR photos to ONE explicit
 *   Order (chosen by the customer via inline buttons). Arbitrary photos/text
 *   from other contexts can never mutate an unrelated Order.
 * - Every access re-validates against the database (owner + WAITING_PAYOUT +
 *   payout step still open) before anything is persisted.
 * - Storage: process-memory Map (no schema change). Sessions expire after
 *   10 minutes; restart clears them (customer simply taps the button again).
 */

export type PayoutInputKind = "text" | "qr";

export interface CustomerPayoutSession {
  /** The ONLY order this input may attach to. */
  orderId: string;
  kind: PayoutInputKind;
  /** Pending preview awaiting ✅ Confirm (not yet persisted). */
  pendingPreview:
    | {
        type: "text";
        currency: string;
        bankName: string;
        accountNumber: string;
        accountName: string;
      }
    | {
        type: "qr";
        qrFileId: string;
        qrFilePath: string;
        qrSha256?: string;
        mimeType: string;
      }
    | null;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;

const sessions = new Map<string, CustomerPayoutSession>();

function keyOf(telegramId: string): string {
  return String(telegramId || "").trim();
}

export function setPayoutInputSession(
  telegramId: string,
  data: { orderId: string; kind: PayoutInputKind }
): void {
  const key = keyOf(telegramId);
  if (!key || !data.orderId) return;
  sessions.set(key, {
    orderId: data.orderId,
    kind: data.kind,
    pendingPreview: null,
    createdAt: Date.now()
  });
}

/**
 * Fetch the customer's ACTIVE payout-input session (expired sessions are
 * dropped). Returns null when there is no session — the caller must then treat
 * the message as normal conversation/bill input, never as payout data.
 */
export function getPayoutInputSession(telegramId: string): CustomerPayoutSession | null {
  const key = keyOf(telegramId);
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(key);
    return null;
  }
  return s;
}

export function updatePayoutInputSession(
  telegramId: string,
  patch: Partial<CustomerPayoutSession>
): void {
  const s = getPayoutInputSession(telegramId);
  if (!s) return;
  sessions.set(keyOf(telegramId), { ...s, ...patch });
}

export function clearPayoutInputSession(telegramId: string): void {
  sessions.delete(keyOf(telegramId));
}
