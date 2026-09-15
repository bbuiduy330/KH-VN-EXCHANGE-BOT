import type { InlineKeyboard } from "grammy";

/**
 * Button element type derived from grammY's OWN InlineKeyboard class property
 * (the installed grammy version does not re-export `InlineKeyboardButton`
 * directly, but its keyboard markup type references the same union from
 * @grammyjs/types). Structurally: text always present; callback_data only on
 * the callback variant.
 */
type InlineButton = InstanceType<typeof InlineKeyboard>["inline_keyboard"][number][number];

/**
 * Test type guard: narrows an inline button to the callback_data variant
 * (InlineKeyboardButton is a union — not every member carries callback_data).
 * Fails loudly instead of silently returning undefined.
 */
export function requireCallbackButton(btn: InlineButton | undefined | null) {
  if (!btn || !("callback_data" in btn)) {
    throw new Error("Expected a callback button");
  }
  return btn;
}