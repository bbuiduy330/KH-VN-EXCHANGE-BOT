/**
 * Deterministic bank-transfer reference (memo) generator.
 *
 * This is a truthful transaction reference shown to the customer for their
 * bank transfer — NEVER AI-generated, NEVER includes bank/account numbers,
 * always short and sanitized. Uses the configured template with safe variables.
 */

export const TRANSFER_MEMO_MAX_LENGTH = 20;
export const DEFAULT_TRANSFER_MEMO_TEMPLATE = "{shortOrder} CK";

/** Sanitize a single token for use in a memo (safe charset, trimmed). */
export function sanitizeMemoToken(input: string): string {
  const cleaned = String(input || "")
    // keep unicode letters/numbers, convert runs of other chars to a single space
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return cleaned;
}

/** Deterministic short order token (# + last 6 of order id, UI-consistent). */
export function shortOrderToken(orderId: string): string {
  const base = String(orderId || "").replace(/^ORD-/i, "");
  return `#${base.slice(-6).toUpperCase()}`;
}

/** Short telegram identifier token (digits only, last 4; "" when absent). */
export function telegramShortToken(telegramId: string): string {
  return String(telegramId || "").replace(/\D/g, "").slice(-4);
}

/**
 * Generate the final transfer memo for an order.
 * Supported template variables:
 *  {username}      -> sanitized username; safe fallback chain:
 *                     username -> telegramShort -> shortOrder (never empty)
 *  {shortOrder}    -> #ABC123 (last 6 of order id, UI-consistent)
 *  {telegramShort} -> last 4 digits of the customer's Telegram id ("" if absent)
 * Unknown variables are dropped. Output is sanitized (safe charset, collapsed
 * whitespace), uppercased, deterministic and length-capped. NEVER AI-generated
 * and NEVER contains bank/account data.
 */
export function generateTransferMemo(
  template: string,
  vars: { orderId: string; username?: string | null; telegramId?: string | null }
): string {
  const tpl = String(template || DEFAULT_TRANSFER_MEMO_TEMPLATE);

  const username = sanitizeMemoToken(vars.username || "").toUpperCase();
  const shortOrder = shortOrderToken(vars.orderId || "");
  const telegramShort = telegramShortToken(vars.telegramId || "");

  // Safe fallback chain for {username} (requirement: never empty/garbage).
  const usernameToken = username || telegramShort || shortOrder;
  const telegramToken = telegramShort || usernameToken;

  const mapped = tpl
    .replace(/\{username\}/g, usernameToken)
    .replace(/\{shortOrder\}/g, shortOrder)
    .replace(/\{telegramShort\}/g, telegramToken);

  // Drop unresolved/unknown placeholders and collapse whitespace.
  const collapsed = mapped
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Final deterministic fallback + length cap.
  let memo = sanitizeMemoToken(collapsed).toUpperCase();
  if (!memo) memo = shortOrderToken(vars.orderId || "");
  return memo.slice(0, TRANSFER_MEMO_MAX_LENGTH);
}

/**
 * Validate an Admin-supplied template BEFORE saving (C requirement: preview
 * before save). Returns a sample preview rendered with sample data so Admin
 * sees exactly what customers will get.
 */
export function validateTransferMemoTemplate(template: string): {
  ok: boolean;
  error?: string;
  sanitized?: string;
} {
  const tpl = String(template || "").trim();
  if (!tpl) {
    return { ok: false, error: "Template không được để trống." };
  }
  if (tpl.length > 120) {
    return { ok: false, error: "Template quá dài (tối đa 120 ký tự)." };
  }
  const allowed = ["{shortorder}", "{username}", "{telegramshort}"];
  const found = tpl.match(/\{(\w+)\}/g) || [];
  for (const raw of found) {
    if (!allowed.includes(raw.toLowerCase())) {
      return {
        ok: false,
        error: `Biến không được hỗ trợ: ${raw}. Chỉ cho phép {username}, {shortOrder}, {telegramShort}.`
      };
    }
  }
  const preview = generateTransferMemo(tpl, {
    orderId: "ORD-SAMPLE12-AB34CD",
    username: "sample_user",
    telegramId: "123456789"
  });
  if (!preview) {
    return { ok: false, error: "Template sinh ra nội dung rỗng." };
  }
  return { ok: true, sanitized: preview };
}
