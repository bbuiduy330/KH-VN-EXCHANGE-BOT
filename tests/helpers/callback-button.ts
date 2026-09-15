import type { InlineKeyboardButton } from "grammy";

/**
 * Test type guard: narrows an InlineKeyboardButton to the callback_data
 * variant (InlineKeyboardButton is a union — not every member carries
 * callback_data). Fails loudly instead of silently returning undefined.
 */
export function requireCallbackButton(btn: InlineKeyboardButton | undefined | null) {
  if (!btn || !("callback_data" in btn)) {
    throw new Error("Expected a callback button");
  }
  return btn;
}