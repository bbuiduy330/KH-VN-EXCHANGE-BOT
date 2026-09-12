/**
 * Per-CTV payout-destination input session (PART J).
 * Scoped strictly by PARTNER TELEGRAM ID. Short-lived (10 min), in-memory.
 * Only the partner's OWN payout destination can ever be written through it.
 *
 * V2: the destination is FREE-FORM reference text (Admin manually reviews and
 * pays). No bank/account format validation — only non-empty, length cap,
 * control-char stripping and a command-injection guard.
 */
export const PAYOUT_DESTINATION_MAX_LEN = 500;

export interface PartnerPayoutSession {
  partnerId: string;
  /** Free-form destination candidate awaiting ✅ confirm — not yet persisted. */
  pending: { text: string } | null;
  /** When true, the partner's next photo/image-document is stored as their payout QR. */
  awaitingQr?: boolean;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, PartnerPayoutSession>();

export function setPartnerPayoutSession(telegramId: string, partnerId: string): void {
  const key = String(telegramId || "").trim();
  if (!key || !partnerId) return;
  sessions.set(key, { partnerId, pending: null, createdAt: Date.now() });
}

export function getPartnerPayoutSession(telegramId: string): PartnerPayoutSession | null {
  const s = sessions.get(String(telegramId || "").trim());
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(String(telegramId || "").trim());
    return null;
  }
  return s;
}

export function updatePartnerPayoutSession(
  telegramId: string,
  pending: { text: string }
): void {
  const s = sessions.get(String(telegramId || "").trim());
  if (!s) return;
  sessions.set(String(telegramId || "").trim(), { ...s, pending, awaitingQr: false });
}

/** Arm/disarm the payout-QR media intake for this partner session. */
export function setPartnerPayoutQrAwaiting(telegramId: string, awaitingQr: boolean): void {
  const key = String(telegramId || "").trim();
  const s = sessions.get(key);
  if (!s) return;
  sessions.set(key, { ...s, awaitingQr, pending: null });
}

export function clearPartnerPayoutSession(telegramId: string): void {
  sessions.delete(String(telegramId || "").trim());
}

/** Strip C0 control chars (keep \n \r \t for multi-line formatting) + DEL. */
export function sanitizePayoutDestinationText(raw: string): string {
  return String(raw || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Free-form destination parser (reference info only — Admin reviews manually).
 * Accepts anything human-readable: "ABA 001234567 - BUI DUY",
 * "Bakong: abc@bakong", "012345678", 3-line bank blocks, etc.
 * Rejects ONLY: empty, >500 chars, command-like input beginning with "/".
 * Returns null when rejected (caller replies with an explicit message).
 */
export function parsePayoutDestinationFreeForm(text: string): string | null {
  const cleaned = sanitizePayoutDestinationText(text);
  if (!cleaned) return null;
  if (cleaned.startsWith("/")) return null; // command/control injection guard
  if (cleaned.length > PAYOUT_DESTINATION_MAX_LEN) return null;
  return cleaned;
}