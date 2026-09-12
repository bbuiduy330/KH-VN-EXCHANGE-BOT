/**
 * Per-CTV payout-destination input session (PART J).
 * Scoped strictly by PARTNER TELEGRAM ID. Short-lived (10 min), in-memory.
 * Only the partner's OWN payout destination can ever be written through it.
 */
export interface PartnerPayoutSession {
  partnerId: string;
  /** Parsed candidate awaiting ✅ confirm — not yet persisted. */
  pending: { bankName: string; accountNumber: string; accountName: string } | null;
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
  pending: { bankName: string; accountNumber: string; accountName: string }
): void {
  const s = sessions.get(String(telegramId || "").trim());
  if (!s) return;
  sessions.set(String(telegramId || "").trim(), { ...s, pending });
}

export function clearPartnerPayoutSession(telegramId: string): void {
  sessions.delete(String(telegramId || "").trim());
}

/** Parse "Bank\nAccount number\nAccount holder" (3 non-empty lines). */
export function parsePayoutDestinationInput(text: string): { bankName: string; accountNumber: string; accountName: string } | null {
  const parts = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const [bankName, accountNumber, accountName] = parts as [string, string, string];
  if (bankName.length < 2 || accountNumber.length < 4 || accountName.length < 2) return null;
  return { bankName, accountNumber, accountName };
}