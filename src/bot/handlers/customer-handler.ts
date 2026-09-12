import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../database/client.js";
import { CustomerService } from "../../modules/customer/customer-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { ConversationalAIService } from "../../modules/ai/customer-ai-service.js";
import { FileService } from "../../modules/files/file-service.js";
import { RuntimeConfigService } from "../../modules/system-config/runtime-config-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { sendToStaff, sendToAdminNotificationChat, copyMessageToStaff, copyMessageToChat, notifyEligibleStaff, notifyOrderCreated, notifyBillReceived, sendToCustomer, notifyPayoutReady, shouldNotifyPayoutReady } from "../notifications.js";
import { SystemConfigService } from "../../modules/system-config/system-config-service.js";
import { generateTransferMemo } from "../../modules/orders/transfer-memo.js";
import { parsePayoutDestinationText, parsePayoutDestinationPipe, parsePayoutDestinationWithAi, decodePayoutQrImage } from "../../modules/orders/payout-destination.js";
import { getPayoutInputSession, setPayoutInputSession, updatePayoutInputSession, clearPayoutInputSession } from "../state/customer-session.js";
import { setPendingBillSession, clearPendingBillSession, takePendingBillSession, finishPendingBill } from "../state/pending-bill-session.js";
import { clearCustomerTelegramChat } from "../../modules/telegram/clear-chat-service.js";
import { PaymentQrService } from "../../modules/payment-qr/payment-qr-service.js";

/** Mask a payout account number for customer-facing previews (**** + last 4). */
function maskPayoutAccount(accountNumber: string): string {
  const n = String(accountNumber || "");
  if (n.length <= 4) return "****";
  return `****${n.slice(-4)}`;
}
import {
  getCustomerMenuKeyboard,
  getLanguageSelectorKeyboard,
  getCustomerReplyKeyboard,
  renderCustomerWelcomeText,
  renderActiveOrderText,
  renderQuoteCard,
  renderSupportActiveText,
  getActiveOrderActionKeyboard
} from "../menus/customer-menu.js";
import { resolveEvidenceMime, logEvidenceDiagnostics } from "../../modules/files/media-validation.js";
import {
  notifyOrderCancelledByCustomer,
  notifyLateBillOnCancelledOrder
} from "../notifications.js";
import {
  LOCALE_LABELS,
  SupportedLocale,
  detectMessageLocale,
  isSupportedLocale,
  t
} from "../../modules/i18n/locales.js";


/** Resolve customer locale from persisted Customer.language. */
function locOf(customer: { language?: string | null } | null | undefined): SupportedLocale {
  return CustomerService.getLocale(customer);
}

/** Non-blocking UI language suggestion. Never auto-persists. */
async function maybeSuggestLanguageSwitch(
  ctx: BotContext,
  customer: { id: string; language?: string | null },
  text: string
): Promise<void> {
  const current = locOf(customer);
  const detected = detectMessageLocale(text);
  if (!detected || detected === current) return;
  try {
    await ctx.reply(t(current, "lang.suggest", { label: LOCALE_LABELS[detected] }), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text(t(current, "lang.switch_to", { label: LOCALE_LABELS[detected] }), `customer:lang:${detected}`)
        .text(t(current, "lang.keep"), "customer:lang:keep")
    });
  } catch {
    // non-fatal
  }
}


/**
 * Staff/Admin-facing display label: @username → display name → Telegram ID.
 * Uses the persisted Customer.telegramId (Prisma: String, non-nullable);
 * never falls back to the internal CUID.
 */
function staffCustomerLabel(customer: {
  fullName?: string | null;
  username?: string | null;
  telegramId: string;
}): string {
  const username = customer.username?.trim();
  const fullName = customer.fullName?.trim();
  if (username) return `@${username}`;
  if (fullName) return fullName;
  return `Telegram ID ${customer.telegramId || "không có"}`;
}

/**
 * HUMAN-mode media relay to the assigned staff only.
 * Uses Telegram-native copyMessage (no download/re-upload/OCR/STT).
 * If no staff is claimed, acknowledges waiting — never broadcasts.
 */
async function relayCustomerMediaToStaff(
  ctx: BotContext,
  customer: { id: string; fullName?: string | null; username?: string | null; telegramId: string; language?: string | null },
  kind: "photo" | "voice" | "document"
): Promise<boolean> {
  const conv = await ConversationService.getOrCreateConversation(customer.id);
  if (conv.mode !== "HUMAN") return false;

  const locale = locOf(customer);
  const messageId = ctx.message?.message_id;
  const fromChatId = ctx.chat?.id;

  if (conv.claimedById && messageId && fromChatId) {
    // Notify staff with a short text header, then native-copy the media.
    await sendToStaff(
      conv.claimedById,
      `📎 <b>Media (${kind}) từ khách ${staffCustomerLabel(customer)}:</b>\n` +
        `Trả lời trực tiếp trong khung chat riêng với bot.`,
      { parse_mode: "HTML" }
    );
    const copied = await copyMessageToStaff(conv.claimedById, fromChatId, messageId);
    if (copied) {
      await ctx.reply(t(locale, "support.media_relayed"), { parse_mode: "HTML" });
    } else {
      await ctx.reply(t(locale, "error.generic"), { parse_mode: "HTML" });
    }
    return true;
  }

  // Unassigned HUMAN ticket — do not broadcast.
  await ctx.reply(t(locale, "support.media_waiting"), { parse_mode: "HTML" });
  return true;
}

export const customerHandler = new Composer<BotContext>();

// Helper to handle customer start:
// shows ACTIVE context first (order -> unexpired quote -> HUMAN support),
// otherwise the rates-first welcome.
export async function showCustomerStart(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: ctx.from?.username,
    fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" "),
    // Telegram language_code is ONLY an initial default for brand-new customers.
    language: (ctx.from as { language_code?: string } | undefined)?.language_code
  });
  const locale = locOf(customer);
  const keyboard = getCustomerMenuKeyboard(locale);

  // 1. Active order -> show/resume order status.
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  if (activeOrder) {
    // Requirement N: for an active unpaid order show 💳 transfer info /
    // 📷 send bill / 💬 support / ❌ cancel. The cancel action disappears
    // automatically once the order is no longer WAITING_PAYMENT.
    const orderKb = getActiveOrderActionKeyboard(activeOrder as any, locale);
    // Payout destination is requested ONLY after the incoming payment is
    // verified (WAITING_PAYOUT) and only while no confirmed destination
    // exists. Never before verification.
    if (
      activeOrder.status === "WAITING_PAYOUT" &&
      !OrderService.isPayoutReady(activeOrder as any)
    ) {
      orderKb.row().text(
        t(locale, "order.bank_btn", { currency: activeOrder.targetCurrency }),
        `customer:payout:choose:${activeOrder.id}`
      );
    }
    await ctx.reply(await renderActiveOrderText(activeOrder, locale), {
      parse_mode: "HTML",
      reply_markup: orderKb
    });
    return;
  }

  // 2. Active unexpired quote -> show/resume that quote
  const activeQuote = await QuoteService.getLatestActiveQuote(customer.id);
  if (activeQuote) {
    const remainingMinutes = Math.max(
      1,
      Math.ceil((new Date(activeQuote.expiresAt).getTime() - Date.now()) / 60000)
    );
    await ctx.reply(renderQuoteCard(activeQuote, remainingMinutes, locale), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(
        t(locale, "quote.confirm_btn"),
        `customer:quote:confirm:${activeQuote.id}`
      )
    });
    return;
  }

  // 3. Active HUMAN support -> do not interrupt; always offer exit
  const conv = await ConversationService.getOrCreateConversation(customer.id);
  if (conv.mode === "HUMAN") {
    await ctx.reply(renderSupportActiveText(locale), {
      parse_mode: "HTML",
      reply_markup: getCustomerReplyKeyboard(locale, true)
    });
    return;
  }

  // 4. Default: two-way USD/VND rates first (localized labels)
  const text = await renderCustomerWelcomeText(customer.fullName || "Guest", locale);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, false) });
}

// /help command
customerHandler.command("help", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  await ctx.reply(t(locale, "help.body"), {
    parse_mode: "HTML",
    reply_markup: getCustomerMenuKeyboard(locale)
  });
});

// /orders command — P SIMPLIFICATION: concise history (active Order is shown
// first by /start). Max 5 short lines, friendly localized status labels.
customerHandler.command("orders", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  // My Orders = ACTIVE ONLY (no terminal COMPLETED/CANCELLED history).
  const myOrders = await OrderService.getActiveOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply(t(locale, "order.active_empty"), {
      reply_markup: getCustomerMenuKeyboard(locale)
    });
  }

  let msg = `${t(locale, "order.history_title")}\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg += `#${o.id.slice(-6)} · ${srcAmt} ${o.sourceCurrency} → ${tgtAmt} ${o.targetCurrency} · ${t(locale, `status.${o.status}`)}\n`;
  }

  // E: active unpaid orders keep their full action set reachable from
  // history (💳 info / 📷 bill / 💬 support / ❌ cancel).
  const actionable = myOrders.find((o: any) => OrderService.canCustomerCancel(o).allowed);
  await ctx.reply(msg, {
    parse_mode: "HTML",
    reply_markup: actionable ? getActiveOrderActionKeyboard(actionable, locale) : getCustomerMenuKeyboard(locale)
  });
});

// ===========================================================================
// CUSTOMER ORDER CANCELLATION (requirement A) — two-step, localized, safe.
// Tap ❌ Huỷ đơn → warning (if money already transferred: DO NOT cancel, send
// bill / contact support) → ✅ Confirm → authoritative order RELOADED from DB
// → cancel only if still eligible. The first tap NEVER mutates anything.
// ===========================================================================

/** Shared eligibility → localized message helper. Returns null when allowed. */
function customerCancelBlockedText(
  order: any,
  locale: SupportedLocale
): string | null {
  const decision = OrderService.canCustomerCancel(order);
  if (decision.allowed) return null;
  if (decision.code === "ALREADY_CANCELLED") {
    return t(locale, "order.cancel_already", { id: order.id });
  }
  if (decision.code === "BILL_EXISTS") {
    return t(locale, "order.cancel_blocked_bill");
  }
  return t(locale, "order.cancel_blocked_status", {
    id: order.id,
    status: t(locale, `status.${order.status}`)
  });
}

/** Step 1: /cancel or ❌ Huỷ đơn button → warning preview (NO mutation). */
async function showCustomerCancelWarning(ctx: BotContext, orderId: string): Promise<void> {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const order = await OrderService.getOrder(orderId);

  if (!order || order.customerId !== customer.id) {
    return void ctx.reply(t(locale, "order.cancel_none"));
  }

  const blocked = customerCancelBlockedText(order, locale);
  if (blocked) {
    // BILL_EXISTS / confirmed payment / completed / cancelled → no cancel UI.
    return void ctx.reply(blocked, { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) });
  }

  const amount = `${MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency)} ${order.sourceCurrency}`;
  const kb = new InlineKeyboard()
    .text(t(locale, "order.cancel_confirm_btn"), `customer:order:cancel:confirm:${order.id}`)
    .text(t(locale, "order.cancel_keep_btn"), `customer:order:keep:${order.id}`);

  await ctx.reply(
    `${t(locale, "order.cancel_warn_title")}\n\n${t(locale, "order.cancel_warn_body", { id: order.id, amount })}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

customerHandler.command("cancel", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  const locale = locOf(customer);
  if (!activeOrder) {
    return ctx.reply(t(locale, "order.cancel_none"));
  }
  await showCustomerCancelWarning(ctx, activeOrder.id);
});

customerHandler.callbackQuery(/^customer:order:cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await showCustomerCancelWarning(ctx, ctx.match?.[1] || "");
});

/** Keep button — pure navigation, never mutates the order. */
customerHandler.callbackQuery(/^customer:order:keep:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const locale = locOf(await CustomerService.getOrCreateCustomer({ telegramId: String(ctx.from?.id || "") }));
  await ctx.reply(t(locale, "order.keep_note", { id: orderId }), { parse_mode: "HTML" }).catch(() => {});
});

/** Step 2: final confirm — reload authoritative state, cancel only if eligible. */
customerHandler.callbackQuery(/^customer:order:cancel:confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);

  // Reload the AUTHORITATIVE order right before mutating (stale callbacks must
  // not cancel an order that changed since the warning was shown).
  const order = await OrderService.getOrder(orderId);
  if (!order || order.customerId !== customer.id) {
    return void ctx.reply(t(locale, "order.cancel_none"));
  }

  if (order.status === "CANCELLED") {
    return void ctx.reply(t(locale, "order.cancel_already", { id: order.id }), { parse_mode: "HTML" });
  }

  const blocked = customerCancelBlockedText(order, locale);
  if (blocked) {
    return void ctx.reply(blocked, { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) });
  }

  try {
    // OrderService.cancelOrder re-checks the centralized rules inside the
    // transaction — customer flow, admin flow and scheduler share ONE rule set.
    await OrderService.cancelOrder(
      orderId,
      customer.id,
      "CUSTOMER",
      "CUSTOMER_CANCELLED",
      { source: "CUSTOMER_CANCELLED" }
    );
    await ctx.reply(t(locale, "order.cancel_success", { id: order.id }), {
      parse_mode: "HTML",
      reply_markup: getCustomerMenuKeyboard(locale)
    });
    // Admin notification chat (Vietnamese) — audit already recorded in service.
    const fresh = await OrderService.getOrder(orderId);
    if (fresh) await notifyOrderCancelledByCustomer(fresh);
  } catch (err: any) {
    if (String(err?.message || "").includes("BILL_EXISTS")) {
      await ctx.reply(t(locale, "order.cancel_blocked_bill"), { parse_mode: "HTML" });
      return;
    }
    await ctx.reply(t(locale, "order.cancel_error", { error: err.message }), { parse_mode: "HTML" });
  }
});

// /bank command (supports pipe syntax or button wizard).
// NOTE: this only stores the customer's saved default payout account
// (CustomerPayoutBank). It is NOT attached to any Order — per the payout
// lifecycle, the per-order destination is requested only after incoming
// payment verification.
customerHandler.command("bank", async (ctx) => {
  const locale = locOf(await CustomerService.getOrCreateCustomer({ telegramId: String(ctx.from?.id || "") }));
  const text = ctx.match?.trim();
  if (!text) {
    const kb = new InlineKeyboard()
      .text("🇻🇳 VND", "customer:bank:wiz:VND")
      .text("🇺🇸 USD", "customer:bank:wiz:USD");

    return ctx.reply(t(locale, "bank.currency_choice"), { parse_mode: "HTML", reply_markup: kb });
  }

  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 4) {
    return ctx.reply(t(locale, "bank.missing_info"), { parse_mode: "HTML" });
  }

  const [currency, bankName, accountName, accountNumber] = parts as [string, string, string, string];
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  await CustomerService.setPayoutBank({
    customerId: customer.id,
    currency,
    bankName,
    accountName,
    accountNumber
  });

  await ctx.reply(
    `${t(locale, "bank.saved_title", { currency: currency.toUpperCase() })}\n` +
      `${t(locale, "order.pay_bank", { bank: bankName })}\n` +
      `${t(locale, "order.pay_name", { name: accountName })}\n` +
      `${t(locale, "order.pay_number", { number: accountNumber })}`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) }
  );
});

// Menu callbacks
// Customer exits HUMAN support themselves ("↩️ Quay lại dổi tiền").
// Acknowledge the callback FIRST, then do the DB work.

// 🌐 Language menu
customerHandler.callbackQuery("customer:menu:language", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  await ctx.reply(t(locale, "lang.selector_title"), {
    parse_mode: "HTML",
    reply_markup: getLanguageSelectorKeyboard()
  });
});

// Explicit language selection — answer FIRST, then persist, then re-render start.
customerHandler.callbackQuery(/^customer:lang:(vi|en|km|zh)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chosen = ctx.match?.[1];
  if (!chosen || !isSupportedLocale(chosen)) return;

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  await CustomerService.setLanguage(customer.id, chosen);

  // Re-fetch so subsequent renders see the new language.
  const updated = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(updated);
  const convNow = await ConversationService.getOrCreateConversation(updated.id);
  await ctx.reply(t(locale, "lang.changed", { label: LOCALE_LABELS[locale] }), {
    parse_mode: "HTML",
    reply_markup: getCustomerReplyKeyboard(locale, convNow.mode === "HUMAN")
  });
  // Immediately render normal customer start flow in the selected language.
  await showCustomerStart(ctx);
});

// Optional "keep current language" on detection suggestion.
customerHandler.callbackQuery("customer:lang:keep", async (ctx) => {
  await ctx.answerCallbackQuery();
});
customerHandler.callbackQuery("customer:support:exit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  await ConversationService.releaseByCustomer(customer.id);
  await ctx.reply(t(locOf(customer), "support.exited"), { parse_mode: "HTML" });

  // Re-render the normal start screen: active order -> active quote -> rates welcome
  await showCustomerStart(ctx);
});

customerHandler.callbackQuery("customer:menu:quote", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // Explicit customer action: leaving HUMAN support before entering the
  // automatic exchange flow, so subsequent texts reach the quote parser
  // instead of the staff relay.
  const conv = await ConversationService.getOrCreateConversation(customer.id);
  if (conv.mode === "HUMAN") {
    await ConversationService.releaseByCustomer(customer.id);
    await ctx.reply(t(locOf(customer), "support.exited"), { parse_mode: "HTML" });
  }

  const localeQuote = locOf(customer);
  await ctx.reply(t(localeQuote, "exchange.instructions"), {
    parse_mode: "HTML",
    reply_markup: getCustomerMenuKeyboard(localeQuote)
  });
});

// 🧹 CLEAR CHAT — TELEGRAM MESSAGE CLEANUP ONLY. Two-step flow: confirmation
// screen first (explicit bullets), execution only on the explicit ✅ callback.
// NEVER touches any business record: the only backend operation is a READ of
// recorded telegramMessageId values; deletions happen via the Telegram API
// only, on the customer's own private chat.
customerHandler.callbackQuery("customer:menu:clearchat", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const kb = new InlineKeyboard()
    .text(t(locale, "clearchat.btn"), "customer:clearchat:go")
    .text(t(locale, "clearchat.back"), "customer:clearchat:back");
  await ctx.reply(
    t(locale, "clearchat.title") + "\n\n" +
      t(locale, "clearchat.point1") + "\n" +
      t(locale, "clearchat.point2") + "\n" +
      t(locale, "clearchat.point3"),
    { parse_mode: "HTML", reply_markup: kb }
  );
});

customerHandler.callbackQuery("customer:clearchat:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const customer = await CustomerService.getOrCreateCustomer({ telegramId: String(ctx.from?.id || "") });
  const locale = locOf(customer);
  await ctx.reply(t(locale, "order.active_empty"), { reply_markup: getCustomerMenuKeyboard(locale) }).catch(() => {});
});

customerHandler.callbackQuery("customer:clearchat:go", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  try {
    // Telegram-only cleanup: batch-deletes the bot's recorded message ids in
    // the customer's private chat. Backend rows are READ, never deleted.
    const result = await clearCustomerTelegramChat(customer.id);
    if (result.requested === 0) {
      await ctx.reply(t(locale, "clearchat.nothing"), { reply_markup: getCustomerMenuKeyboard(locale) });
      return;
    }
    // Telegram can refuse older (>48h) messages — the wording only claims what
    // was actually deleted.
    const key = result.failed > 0 ? "clearchat.done_partial" : "clearchat.done";
    await ctx.reply(t(locale, key), { reply_markup: getCustomerMenuKeyboard(locale) });
  } catch (err: any) {
    // Failure cleanup must never affect financial data — report and continue.
    logger.warn({ err: err?.message }, "Clear chat: cleanup failed (business data untouched)");
    await ctx.reply(t(locale, "clearchat.done_partial"), { reply_markup: getCustomerMenuKeyboard(locale) });
  }
});

customerHandler.callbackQuery("customer:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  // My Orders = ACTIVE ONLY: terminal COMPLETED/CANCELLED Orders are never
  // shown to the customer (history stays in the DB for audit/disputes).
  const myOrders = await OrderService.getActiveOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply(t(locale, "order.active_empty"), { reply_markup: getCustomerMenuKeyboard(locale) });
  }

  // P — concise history lines (active Order is shown first via /start).
  let msg = `${t(locale, "order.history_title")}\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg += `#${o.id.slice(-6)} · ${srcAmt} ${o.sourceCurrency} → ${tgtAmt} ${o.targetCurrency} · ${t(locale, `status.${o.status}`)}\n`;
  }
  const actionable = myOrders.find((o: any) => OrderService.canCustomerCancel(o).allowed);
  await ctx.reply(msg, {
    parse_mode: "HTML",
    reply_markup: actionable ? getActiveOrderActionKeyboard(actionable, locale) : getCustomerMenuKeyboard(locale)
  });
});

customerHandler.callbackQuery("customer:menu:bank", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const kb = new InlineKeyboard()
    .text("🇻🇳 VND", "customer:bank:wiz:VND")
    .text("🇺🇸 USD", "customer:bank:wiz:USD");

  await ctx.reply(t(locale, "bank.currency_choice"), { parse_mode: "HTML", reply_markup: kb });
});

customerHandler.callbackQuery(/^customer:bank:wiz:(VND|USD)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // Strict-null fix (noUncheckedIndexedAccess): the regex only matches
  // VND|USD, so narrowing on the literal is a proven-safe determination —
  // anything absent/unexpected falls back to the default VND.
  const currency = ctx.match?.[1] === "USD" ? "USD" : "VND";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  await ctx.reply(
    `${t(locale, "bank.wiz_title", { currency })}\n\n` +
      t(locale, "bank.wiz_example", { currency }),
    { parse_mode: "HTML" }
  );
});

customerHandler.callbackQuery("customer:menu:support", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  await ConversationService.getOrCreateConversation(customer.id);
  await ConversationService.addMessage({
    customerId: customer.id,
    senderType: "CUSTOMER",
    content: "[YÊU CẦU GẶP CSKH TRỰC TIẾP]"
  });

  const locale = locOf(customer);
  await ctx.reply(t(locale, "support.requested"), { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) });

  const notifyText =
    `🛎 <b>YÊU CẦU HỖ TRỢ TỪ KHÁCH HÀNG:</b>\n` +
    `• Khách: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
    `• Telegram ID: <code>${customer.telegramId}</code>`;
  const notifyKb = new InlineKeyboard()
    .text("👀 Xem khách", `cskh:preview:${customer.id}`)
    .text("🙋 Nhận khách", `cskh:ticket:claim:${customer.id}`);

  // Support-group broadcast (kept) + direct DM to eligible active staff (C3).
  await sendToAdminNotificationChat(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
  await notifyEligibleStaff(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
});

// --- 💳 Transfer info + 📷 bill instruction callbacks (requirement N) ---

/** 💳 View transfer details for an active unpaid order (localized re-render). */
customerHandler.callbackQuery(/^customer:order:payinfo:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const order = await OrderService.getOrder(orderId);

  if (!order || order.customerId !== customer.id) {
    return void ctx.reply(t(locale, "order.cancel_none"));
  }
  if (order.status !== "WAITING_PAYMENT") {
    return void ctx.reply(t(locale, "order.cancel_blocked_status", {
      id: order.id,
      status: t(locale, `status.${order.status}`)
    }), { parse_mode: "HTML" });
  }

  // Dynamic Payment QR V1 — the 💳 re-display uses the SAME shared renderer
  // as quote confirmation: one message with the Order QR (dynamic/static) and
  // the FROZEN Order.transferMemo — never a regenerated memo from current
  // SystemSetting.
  await sendOrderPaymentCard(ctx, order as any, locale);
});

/** 📷 Send bill — localized instruction (Telegram UX cannot open a file picker). */
customerHandler.callbackQuery(/^customer:bill:upload:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const order = await OrderService.getOrder(orderId);

  if (!order || order.customerId !== customer.id) {
    return void ctx.reply(t(locale, "bill.none"));
  }
  if (order.status !== "WAITING_PAYMENT") {
    return void ctx.reply(t(locale, "bill.not_eligible"), { parse_mode: "HTML" });
  }
  await ctx.reply(t(locale, "order.bill_instruction", { id: order.id }), { parse_mode: "HTML" });
});

// Quote confirmation callback (persisted Quote in DB)
customerHandler.callbackQuery(/^(?:customer:quote:confirm:|confirm_quote:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const quoteId = ctx.match ? ctx.match[1] : undefined;
  if (!quoteId) return;

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  try {
    // Atomically confirm quote in database
    const confirmedQuote = await QuoteService.confirmQuote(quoteId, customer.id);
    const order = await OrderService.createOrderFromQuote(customer.id, confirmedQuote);

    const locale = locOf(customer);

    // Dynamic Payment QR V1 — confirming the quote IMMEDIATELY generates and
    // sends the Order's payment QR as ONE message (photo + concise caption,
    // or the text card when no QR is available). NO separate "Get QR" step.
    // Memo/amount come from the FROZEN Order (Order.transferMemo/sourceAmount).
    await sendOrderPaymentQrOnConfirm(ctx, order as any, locale);

    // Notify admins (order already durably created + audited above).
    await notifyOrderCreated(order, customer);
  } catch (err: any) {
    // FINANCIAL SAFETY / LOCALIZATION FIX: an expired quote must never leak
    // the raw Vietnamese service exception ("Báo giá đã hết hạn...") into
    // en/km/zh flows. Expiry gets a fully localized customer message; other
    // known service errors keep their existing handling.
    const errText = String(err?.message || "");
    if (/hết hạn|expired/i.test(errText)) {
      const locale = locOf(customer);
      await ctx.reply(t(locale, "quote.expired_notice"), {
        parse_mode: "HTML",
        reply_markup: getCustomerMenuKeyboard(locale)
      });
      return;
    }
    // Friendly error when the DESK receiving account is missing (system
    // payment account is operator-side config, not a customer problem).
    if (errText.includes("Không tìm thấy tài khoản nhận")) {
      const locale = locOf(customer);
      await ctx.reply(t(locale, "order.missing_desk_account", { currency: confirmedQuoteCurrency(err) }), {
        parse_mode: "HTML",
        reply_markup: getCustomerMenuKeyboard(locale)
      });
      return;
    }
    await ctx.reply(t(locOf(customer), "order.create_error", { error: err.message }));
  }
});

/** Best-effort source currency for the missing-desk-account message. */
function confirmedQuoteCurrency(err: any): string {
  const m = String(err?.message || "").match(/đồng ([A-Z]{3})/);
  // Strict-null fix: a capture group is string | undefined even on a match.
  const code = m?.[1];
  return code ?? "";
}

// Attach pending bill media to the EXPLICITLY selected order.
// FINANCIAL SAFETY + RELIABILITY:
//   - The media reference lives in the per-customer PENDING-BILL session
//     (never attached to an arbitrary Order before selection).
//   - takePendingBillSession atomically MOVES the session into an in-flight
//     slot: a double-click cannot double-attach (second click sees
//     bill.processing) and the media is owned by exactly ONE attempt.
//   - The session is only RELEASED (cleared for good) AFTER the bill is
//     durably persisted. On ANY failure it is RESTORED with its ORIGINAL
//     media reference — the customer retries by tapping the same order
//     button again and NEVER re-sends the image.
customerHandler.callbackQuery(/^customer:bill:attach:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);

  // 1+2+3. Atomic take: prevents concurrent/double processing of the same
  // session. A repeated click while one attempt is running gets a "processing"
  // note; a click with no session at all sees "expired".
  const take = takePendingBillSession(telegramId);
  if (take.state === "in_flight") {
    return void ctx.reply(t(locale, "bill.processing"));
  }
  if (take.state === "none") {
    return void ctx.reply(t(locale, "bill.session_expired"));
  }
  const pending = take.session;

  try {
    const order = await OrderService.getOrder(orderId);
    if (!order || order.customerId !== customer.id) {
      finishPendingBill(telegramId, pending, true); // media stays recoverable
      return void ctx.reply(t(locale, "bill.none"));
    }
    // Billable statuses = the statuses submitCustomerBill() accepts.
    const allowedStatuses = ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW"];
    if (!allowedStatuses.includes(order.status as string)) {
      finishPendingBill(telegramId, pending, true); // media stays recoverable
      return void ctx.reply(t(locale, "bill.not_eligible"), { parse_mode: "HTML" });
    }

    // 4. Process/download/store the ORIGINAL media. processBillUpload replies
    // to the customer itself and returns TRUE only after durable persistence.
    let stored = false;
    try {
      stored = await processBillUpload(ctx, orderId, pending.fileId, telegramId, {
        type: pending.mediaType,
        telegramMime: pending.telegramMime ?? null,
        fileName: pending.fileName ?? null
      });
    } catch (processErr: any) {
      logger.error(
        { err: processErr?.message, orderRef: orderId.slice(-6) },
        "Pending-bill attach threw — original media kept for retry"
      );
      stored = false;
    }

    if (!stored) {
      // 5-failure. Persist failed (download/storage/DB) — restore the ORIGINAL
      // pending media so the customer can retry by tapping the same button.
      finishPendingBill(telegramId, pending, true);
      return void ctx.reply(t(locale, "bill.retry_kept"), { parse_mode: "HTML" });
    }

    // 5-success. Bill persisted exactly once — release the session for good.
    finishPendingBill(telegramId, pending, false);
  } catch (unexpectedErr: any) {
    // Defensive: any unexpected error must never lose the original media.
    logger.error({ err: unexpectedErr?.message }, "Pending-bill attach crashed — session restored for retry");
    finishPendingBill(telegramId, pending, true);
    await ctx.reply(t(locale, "bill.retry_kept"), { parse_mode: "HTML" }).catch(() => {});
  }
});

/** Reserved navigation labels recognized across ALL locales so a stale
 *  old-language button still routes correctly. */
export function matchReservedAction(text: string): "exchange" | "orders" | "support" | "support_active" | "language" | "exit_support" | null {
  const cur = text.trim();
  for (const loc of ["vi", "en", "km", "zh"] as const) {
    if (cur === t(loc, "menu.exchange")) return "exchange";
    if (cur === t(loc, "menu.orders")) return "orders";
    if (cur === t(loc, "menu.support")) return "support";
    if (cur === t(loc, "menu.support_active")) return "support_active";
    if (cur === t(loc, "menu.language")) return "language";
    if (cur === t(loc, "menu.exit_support")) return "exit_support";
  }
  return null;
}

/**
 * Reserved persistent-keyboard control texts — navigation, NEVER parsed as
 * an exchange/AI request. Returns true when handled.
 */
async function handleReservedCustomerControl(
  ctx: BotContext,
  customer: { id: string; language?: string | null; fullName?: string | null; username?: string | null; telegramId?: string | null },
  text: string
): Promise<boolean> {
  const action = matchReservedAction(text);
  if (!action) return false;

  const locale = locOf(customer as { language?: string | null });
  const conv = await ConversationService.getOrCreateConversation(customer.id);
  const inHuman = conv.mode === "HUMAN";

  switch (action) {
    case "exchange": {
      if (inHuman) {
        await ConversationService.releaseByCustomer(customer.id);
      }
      const welcomeText = await renderCustomerWelcomeText(customer.fullName || "Guest", locale);
      await ctx.reply(welcomeText, { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, false) });
      return true;
    }
    case "orders": {
      // My Orders = ACTIVE ONLY (no terminal COMPLETED/CANCELLED history).
      const myOrders = await OrderService.getActiveOrdersForCustomer(customer.id, 10);
      if (myOrders.length === 0) {
        await ctx.reply(t(locale, "order.active_empty"), { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, inHuman) });
      } else {
        let msg = `${t(locale, "order.list_recent_title")}\n\n`;
        for (const o of myOrders.slice(0, 5)) {
          const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
          const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
          msg +=
            `${t(locale, "order.exchange", { src: `${srcAmt} ${o.sourceCurrency}`, tgt: `${tgtAmt} ${o.targetCurrency}` })}\n` +
            `${t(locale, "order.status", { status: t(locale, `status.${o.status}`) })}\n\n`;
        }
        await ctx.reply(msg, { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, inHuman) });
      }
      return true;
    }
    case "support":
    case "support_active": {
      if (inHuman) {
        // Already HUMAN: show current support state only — no new request/notify.
        await ctx.reply(renderSupportActiveText(locale), { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, true) });
        return true;
      }
      // Enter HUMAN support request.
      await ConversationService.addMessage({
        customerId: customer.id,
        senderType: "CUSTOMER",
        content: "[YÊU CẦU GẶP CSKH TRỰC TIẾP]"
      });
      await ctx.reply(t(locale, "support.requested"), { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, true) });

      const notifyText =
        `🛎 <b>YÊU CẦU HỖ TRỢ TỪ KHÁCH HÀNG:</b>\n` +
        `• Khách: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
        `• Telegram ID: <code>${customer.telegramId}</code>`;
      const notifyKb = new InlineKeyboard()
        .text("👀 Xem khách", `cskh:preview:${customer.id}`)
        .text("🙋 Nhận khách", `cskh:ticket:claim:${customer.id}`);
      await sendToAdminNotificationChat(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
      await notifyEligibleStaff(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
      return true;
    }
    case "language": {
      await ctx.reply(t(locale, "lang.selector_title"), { parse_mode: "HTML", reply_markup: getLanguageSelectorKeyboard() });
      return true;
    }
    case "exit_support": {
      await ConversationService.releaseByCustomer(customer.id);
      await ctx.reply(t(locale, "support.exited"), { parse_mode: "HTML" });
      await showCustomerStart(ctx);
      return true;
    }
  }
  return false;
}


// Customer text message handler
// ---------------------------------------------------------------------------
// DETERMINISTIC ORDER-STATUS INTENT (financial-safety requirement):
// status questions are answered from the Order state machine with the real
// display name + Order reference — NEVER by the conversational AI, and the
// reply NEVER mentions a SYSTEM receiving account (KHQR UPAY / BIDV /
// PaymentAccount) as if it were the customer's payout destination.
// ---------------------------------------------------------------------------
const STATUS_INTENT_RE =
  /trạng\s*thái|đơn\s*hàng|kiểm\s*tra\s*(đơn|tiền|giao\s*dịch)|khi\s*nào|xác\s*nhận\s*(chưa|tiền)|nhận\s*tiền\s*chưa|chưa\s*nhận\s*được|biên\s*lai|bill\s*(chưa|khi|của|được)|order\s*status|status\s*of\s*(my\s*)?(order|payment)|my\s*order|when\s*will\s*(i|you)\s*(receive|transfer|send)|payment\s*status|still\s*processing|订单|状态|什么时候|到账|ស្ថានភាព|ការបញ្ជាទិញ/i;

export function isOrderStatusQuestion(text: string): boolean {
  return STATUS_INTENT_RE.test(String(text || ""));
}

function statusReplyKey(status: string): string | null {
  switch (status) {
    case "WAITING_PAYMENT":
      return "order.status_reply_wait_pay";
    // Bill received and being verified (incl. review states) — the required
    // deterministic reply for the WAITING_ADMIN_VERIFY runtime scenario.
    case "CUSTOMER_SENT_BILL":
    case "WAITING_ADMIN_VERIFY":
    case "MANUAL_REVIEW":
    case "SUSPICIOUS":
    case "PAYMENT_MISMATCH":
      return "order.status_reply_verifying";
    case "PAYMENT_CONFIRMED":
      return "order.status_reply_confirmed";
    case "WAITING_PAYOUT":
      return "order.status_reply_payout_info";
    case "PAYOUT_SENT":
      return "order.status_reply_payout_sent";
    default:
      return null; // terminal states never reach here (active-only lookup)
  }
}

export async function handleCustomerTextMessage(ctx: BotContext, text: string) {
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: ctx.from?.username,
    fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")
  });

  // Reserved persistent-keyboard controls are navigation, never freeform
  // input — they win even while a payout session is active.
  if (await handleReservedCustomerControl(ctx, customer, text)) return;

  // 0a. J — RESERVED FINANCIAL ROUTING PRECEDENCE: an active payout-destination
  // input session is a reserved financial action and MUST be intercepted
  // BEFORE generic HUMAN support relay. A customer talking to CSKH while
  // entering payout details still gets the payout flow, never a plain
  // forward of bank data into the support chat.
  const payoutSession = getPayoutInputSession(telegramId);
  if (payoutSession) {
    const handled = await handlePayoutTextInput(ctx, customer, payoutSession, text);
    if (handled) return;
  } else if (await tryBindPayoutTextInputFromState(ctx, customer, text)) {
    // L — session-loss safe: a plain bank line ("vcb 0123456789 nguyen van a")
    // sent right after payment verification is parsed deterministically and
    // bound to the ONE eligible WAITING_PAYOUT order via DB state.
    return;
  }

  const conv = await ConversationService.getOrCreateConversation(customer.id);
  await ConversationService.addMessage({
    customerId: customer.id,
    senderType: "CUSTOMER",
    content: text
  });

  if (conv.mode === "HUMAN") {
    logger.info({ customerId: customer.id }, "Conversation in HUMAN mode; AI reply paused");

    if (conv.claimedById) {
      await sendToStaff(
        conv.claimedById,
        `💬 <b>Tin nhắn từ ${customer.fullName || (customer.username ? "@" + customer.username : `Telegram ID ${customer.telegramId}`)}:</b>\n\n` +
          `"${text}"`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  // Check active order context
  // SECURITY: the conversational-AI context carries NO receiving-account
  // data. SYSTEM receiving accounts (KHQR UPAY / BIDV / PaymentAccount /
  // receivingAccountSnapshot) are the bot's INCOMING payment rails — they are
  // NOT the customer's payout destination, and the AI must never mention them
  // as one. Financial-state answers are built deterministically below.
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  let activeOrderContext = null;
  if (activeOrder) {
    activeOrderContext = {
      orderId: activeOrder.id,
      status: activeOrder.status,
      sourceAmount: activeOrder.sourceAmount,
      sourceCurrency: activeOrder.sourceCurrency,
      targetAmount: activeOrder.targetAmount,
      targetCurrency: activeOrder.targetCurrency
    };
  }

  // 0c. DETERMINISTIC order-status response (before ANY AI involvement).
  // When the customer asks about their order/payment status, the bot answers
  // from the AUTHORITATIVE Order state with the actual display name + Order
  // reference. The conversational AI never constructs this financial reply.
  if (activeOrder && isOrderStatusQuestion(text)) {
    const locale = locOf(customer);
    const displayName = (customer.fullName || customer.username || "quý khách").trim();
    const key = statusReplyKey(activeOrder.status as string) || "order.status_reply_verifying";
    await ctx.reply(
      t(locale, key, { name: displayName, id: activeOrder.id }),
      {
        parse_mode: "HTML",
        reply_markup:
          activeOrder.status === "WAITING_PAYMENT"
            ? getActiveOrderActionKeyboard(activeOrder as any, locale)
            : getCustomerMenuKeyboard(locale)
      }
    );
    await ConversationService.addMessage({
      customerId: customer.id,
      // Deterministic bot answer — NOT AI-generated. `BOT` is a documented
      // Message.senderType convention (prisma schema comment) so the history
      // never attributes this financial-state reply to the conversational AI.
      senderType: "BOT",
      content: t(locale, key, { name: displayName, id: activeOrder.id })
    });
    return;
  }
  if (!activeOrder && isOrderStatusQuestion(text)) {
    // Status question with nothing in progress → deterministic empty answer
    // (still no AI, no bank/account invention).
    const locale = locOf(customer);
    await ctx.reply(t(locale, "order.active_empty"), {
      parse_mode: "HTML",
      reply_markup: getCustomerMenuKeyboard(locale)
    });
    return;
  }

  // 0a (moved above): the payout-input session is intercepted BEFORE the
  // HUMAN relay — nothing left to do here in AUTO mode.

  // 0b. Conversational saved-default-account capture (customer-initiated;
  // stores CustomerPayoutBank only — it is NOT attached to any Order):
  // "VND | Vietcombank | NGUYEN VAN A | 0123456789"
  const bankCapture = text.match(/^(VND|USD)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)$/i);
  if (bankCapture) {
    const [, currency, bankName, accountName, accountNumber] = bankCapture as [
      string,
      string,
      string,
      string,
      string
    ];
    const locale = locOf(customer);
    await CustomerService.setPayoutBank({
      customerId: customer.id,
      currency: currency.toUpperCase(),
      bankName: bankName.trim(),
      accountName: accountName.trim(),
      accountNumber: accountNumber.trim()
    });
    await ctx.reply(
      `${t(locale, "bank.saved_title", { currency: currency.toUpperCase() })}\n` +
        `${t(locale, "order.pay_bank", { bank: bankName.trim() })}\n` +
        `${t(locale, "order.pay_name", { name: accountName.trim() })}\n` +
        `${t(locale, "order.pay_number", { number: accountNumber.trim() })}`,
      { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) }
    );
    return;
  }

  // 1. Check exchange intent
  const intent = await AiProvider.parseExchangeIntent(text);
  if (intent) {
    try {
      // Persist Quote in DB. Target-amount intents ("doi VND lay 100 USD",
      // "y anh la nhan 100 do") compute the required source amount instead.
      const quote =
        intent.amountSide === "target"
          ? await QuoteService.createQuoteFromTarget(
              customer.id,
              intent.sourceCurrency,
              intent.targetCurrency,
              intent.amount
            )
          : await QuoteService.createQuote(
              customer.id,
              intent.sourceCurrency,
              intent.targetCurrency,
              intent.amount
            );

      const keyboard = new InlineKeyboard().text(t(locOf(customer), "common.confirm_btn"), `customer:quote:confirm:${quote.id}`);
      const expiryMinutes = RuntimeConfigService.getQuoteExpiryMinutes();

      await ctx.reply(renderQuoteCard(quote, expiryMinutes, locOf(customer)), { parse_mode: "HTML", reply_markup: keyboard });
      await maybeSuggestLanguageSwitch(ctx, customer, text);
      return;
    } catch (err: any) {
      await ctx.reply(`⚠️ ${err.message}`);
      return;
    }
  }

  // 2. General conversation -> AI (Stored with senderType = "AI")
  let aiReply: string | null = null;
  const isAvailable = await AiProvider.isAvailable();
  if (isAvailable) {
    try {
      aiReply = await ConversationalAIService.generateReply({
        customerMessage: text,
        customerName: customer.fullName || customer.username || "Quý khách",
        customerId: customer.id,
        activeOrderContext
      });
    } catch (err) {
      logger.warn({ err }, "Failed to generate AI consultation reply");
    }
  }

  if (aiReply) {
    await ConversationService.addMessage({
      customerId: customer.id,
      senderType: "AI", // Correct senderType AI (Requirement P1)
      content: aiReply
    });

    await ctx.reply(aiReply, {
      reply_markup: getCustomerMenuKeyboard()
    });
    return;
  }

  await ctx.reply(t(locOf(customer), "customer.fallback"), {
    parse_mode: "HTML",
    reply_markup: getCustomerMenuKeyboard(locOf(customer))
  });
}

// Hardened Telegram File Downloader & Bill Processor
//
// ROOT CAUSE FIX (requirement F): the previous implementation derived the
// MIME type ONLY from the Telegram file-server `Content-Type` response header,
// which is frequently `application/octet-stream` for valid images (especially
// `document` uploads and photos without an original filename). That rejected
// perfectly valid customer bills with "Định dạng tệp không được hỗ trợ".
// MIME is now resolved safely: Telegram metadata → magic-byte sniffing →
// file extension → download header (see media-validation.ts). A Telegram
// compressed `photo` has NO filename — that alone is never a rejection reason.
async function processBillUpload(
  ctx: BotContext,
  orderId: string,
  fileId: string,
  telegramId: string,
  media?: { type: "photo" | "document"; telegramMime?: string | null; fileName?: string | null }
): Promise<boolean> {
  // RELIABILITY CONTRACT: returns TRUE only when the evidence was durably
  // persisted to the Order (WAITING_ADMIN_VERIFY / MANUAL_REVIEW /
  // SUSPICIOUS / LATE_BILL_CANCELLED — all store evidence rows). Every
  // rejection/failure path (wrong owner, too large, download failed,
  // unsupported type, non-billable state) returns FALSE so the caller can
  // keep the original pending media recoverable and offer a retry.
  const maxBytes = (env.MAX_UPLOAD_MB || 15) * 1024 * 1024;
  const mediaType = media?.type || (ctx.message?.document ? "document" : "photo");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);

  // FINANCIAL SAFETY (audit fix): the target Order must belong to THIS
  // customer. The orderId always comes from an explicit bound selection
  // (single eligible order or the customer's own picker buttons) — a random
  // photo can never be attached to an arbitrary/cross-customer Order.
  const target = await OrderService.getOrder(orderId);
  if (!target || target.customerId !== customer.id) {
    await ctx.reply(t(locale, "bill.none"));
    return false;
  }

  const file = await ctx.api.getFile(fileId);

  if (file.file_size && file.file_size > maxBytes) {
    await ctx.reply(t(locale, "bill.too_large", { limit: String(env.MAX_UPLOAD_MB || 15) }));
    return false;
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);

  if (!res.ok) {
    logEvidenceDiagnostics(logger, {
      event: "bill_download_error", orderRef: orderId.slice(-6), mediaType,
      mimeType: "unknown", bytes: 0, reason: "EMPTY_FILE"
    });
    await ctx.reply(t(locale, "bill.download_failed"));
    return false;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    await ctx.reply(t(locale, "bill.download_failed"));
    return false;
  }
  if (buffer.length > maxBytes) {
    logEvidenceDiagnostics(logger, {
      event: "bill_rejected", orderRef: orderId.slice(-6), mediaType,
      mimeType: "unknown", bytes: buffer.length, reason: "UNSUPPORTED_TYPE"
    });
    await ctx.reply(t(locale, "bill.too_large", { limit: String(env.MAX_UPLOAD_MB || 15) }));
    return false;
  }

  // Safe MIME resolution — never requires a filename, never trusts the
  // download Content-Type alone, never involves OCR/AI success.
  const resolved = resolveEvidenceMime({
    telegramMime: media?.telegramMime || (ctx.message as any)?.document?.mime_type,
    fileNameOrPath: media?.fileName || file.file_path,
    responseMime: res.headers.get("content-type"),
    buffer
  });

  logEvidenceDiagnostics(logger, {
    event: resolved.accepted ? "bill_accepted" : "bill_rejected",
    orderRef: orderId.slice(-6), mediaType,
    mimeType: resolved.mimeType, bytes: buffer.length, reason: resolved.reason
  });

  if (!resolved.accepted) {
    await ctx.reply(t(locale, "bill.unsupported"));
    return false;
  }

  const safeExt =
    resolved.mimeType === "application/pdf" ? "pdf" :
    resolved.mimeType === "image/png" ? "png" :
    resolved.mimeType === "image/webp" ? "webp" :
    resolved.mimeType === "image/gif" ? "gif" : "jpg";
  const sanitizedFileName = `bill_${orderId}_${Date.now()}.${safeExt}`;

  let result: any;
  try {
    result = await OrderService.submitCustomerBill(
      orderId,
      buffer,
      sanitizedFileName,
      resolved.mimeType,
      telegramId
    );
  } catch (err: any) {
    // Order in a non-billable state (e.g. confirmed payment) — safe message,
    // never a raw Vietnamese service error in a localized flow.
    await ctx.reply(t(locale, "bill.not_eligible"), { parse_mode: "HTML" });
    return false;
  }

  // RUNTIME HARDENING: the bill/evidence is ALREADY durably stored at this
  // point. Admin notification failures must never surface as a customer
  // error (and never lose the evidence) — wrapped best-effort with logging.
  const notifyAdminBill = async (o: any, risk?: "DUPLICATE_BILL" | "ADDITIONAL_BILL") => {
    try {
      await notifyBillReceived(o, risk ? { risk } : undefined);
    } catch (notifyErr: any) {
      logger.error(
        { err: notifyErr?.message, orderRef: orderId.slice(-6) },
        "Admin bill notification failed — bill IS stored, Admin must check the Operations Center"
      );
    }
  };

  if (result.status === "SUSPICIOUS") {
    // I — DUPLICATE/RISKY BILL: the customer gets a NEUTRAL success message
    // (no accusation, no "duplicate" wording). The risk flag is an ADMIN-ONLY
    // signal in the bill notification; all evidence and flags are preserved.
    await ctx.reply(t(locale, "bill.wait_verify", { id: orderId }), { parse_mode: "HTML" });
    const suspiciousOrder = await OrderService.getOrder(orderId);
    if (suspiciousOrder) {
      await notifyAdminBill(suspiciousOrder, "DUPLICATE_BILL");
    }
    return true; // evidence durably stored (flagged for review)
  } else if (result.status === "MANUAL_REVIEW") {
    // I — additional/re-uploaded bill: neutral customer message; Admin-only
    // additional-bill warning. Evidence preserved (MANUAL_REVIEW state).
    await ctx.reply(t(locale, "bill.wait_verify", { id: orderId }), { parse_mode: "HTML" });
    const additionalBillOrder = await OrderService.getOrder(orderId);
    if (additionalBillOrder) {
      await notifyAdminBill(additionalBillOrder, "ADDITIONAL_BILL");
    }
    return true; // evidence durably stored (additional-bill review)
  } else if (result.status === "LATE_BILL_CANCELLED") {
    // Late bill after auto-cancel (requirement E): acknowledge locally, the
    // evidence is already stored — route to manual review, never reopen.
    await ctx.reply(t(locale, "bill.late_cancelled_customer", { id: orderId }), { parse_mode: "HTML" });
    const lateOrder = await OrderService.getOrder(orderId);
    if (lateOrder) {
      try {
        await notifyLateBillOnCancelledOrder(lateOrder);
      } catch (notifyErr: any) {
        logger.error({ err: notifyErr?.message, orderRef: orderId.slice(-6) }, "Late-bill Admin notification failed");
      }
    }
    return true; // evidence durably stored (manual-review trail)
  } else {
    // Per the payout lifecycle: the payout destination is requested ONLY
    // after Admin verifies the incoming payment. Here we acknowledge the
    // bill and explain what happens next — we do NOT ask for payout info.
    await ctx.reply(t(locale, "bill.wait_verify", { id: orderId }), { parse_mode: "HTML" });

    const billedOrderForNotify = await OrderService.getOrder(orderId);
    if (billedOrderForNotify) {
      await notifyAdminBill(billedOrderForNotify);
    }
    return true; // evidence durably stored (first bill / re-upload)
  }
}

// ===========================================================================
// CUSTOMER PAYOUT DESTINATION (only AFTER incoming payment verification)
// ===========================================================================
//
// Lifecycle rule: the payout destination is requested ONLY when the order is
// in WAITING_PAYOUT (Admin verified the incoming payment) and has no valid
// destination yet. WAITING_PAYOUT + no destination = waiting for customer
// payout info; WAITING_PAYOUT + valid destination = payout-ready.
//
// State binding (security): input text / QR photos are bound to ONE explicit
// Order via the per-customer session. Nothing global is shared between
// customers; multiple eligible orders require explicit selection.

/** All of THIS customer's own WAITING_PAYOUT orders without a valid destination. */
async function getEligiblePayoutOrdersForCustomer(customerId: string): Promise<any[]> {
  const orders = await OrderService.getOrdersForCustomer(customerId, 20);
  return orders.filter(
    (o: any) => o.status === "WAITING_PAYOUT" && !OrderService.isPayoutReady(o as any)
  );
}

/** Human label for a destination snapshot: "🏦 VCB ••••6789 — NGUYEN VAN A". */
function destinationLabel(dest: any): string {
  if (dest?.type === "qr") return "📷 QR";
  const bank = String(dest?.bankName || "").toUpperCase();
  return `🏦 ${bank} ${maskPayoutAccount(dest?.accountNumber || "")} — ${dest?.accountName || ""}`.trim();
}

/** Localized confirmation preview for a payout destination (never auto-persisted). */
function renderPayoutDestinationPreview(
  dest: { type: "text" | "qr"; [k: string]: any },
  locale: SupportedLocale
): string {
  let msg = `${t(locale, "payout.preview_title")}\n`;
  if (dest.type === "qr") {
    msg += `${t(locale, "payout.preview_qr")}\n`;
  } else {
    msg +=
      `${t(locale, "payout.preview_bank", { bank: dest.bankName })}\n` +
      `${t(locale, "payout.preview_account", { number: maskPayoutAccount(dest.accountNumber) })}\n` +
      `${t(locale, "payout.preview_holder", { name: dest.accountName })}\n`;
  }
  msg += `\n${t(locale, "payout.confirm_hint")}`;
  return msg;
}

/** Keyboard for the destination confirmation preview. */
function payoutPreviewKeyboard(orderId: string, locale: SupportedLocale): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, "payout.confirm_btn"), `customer:payout:confirm:${orderId}`)
    .text(t(locale, "payout.edit_btn"), `customer:payout:edit:${orderId}`)
    .row()
    .text(t(locale, "payout.support_btn"), `customer:payout:support:${orderId}`);
}

/**
 * Chooser — B SIMPLIFICATION: NO recent/saved accounts, NO history
 * suggestions. Every Order requests FRESH payout information after incoming
 * payment is verified. Historical Order payout snapshots stay in the DB for
 * audit/history only. Customer options are exactly:
 *   ⌨️ Gửi tài khoản nhận / 📷 Gửi QR nhận / 💬 Hỗ trợ
 */
async function buildPayoutChooser(
  order: any,
  customer: { id: string; username?: string | null; telegramId?: string | null },
  locale: SupportedLocale
): Promise<{ text: string; kb: InlineKeyboard }> {
  void customer;
  const kb = new InlineKeyboard();
  const text =
    `${t(locale, "payout.choose_title")}\n\n` +
    `${t(locale, "payout.ask_hint")}`;

  kb.text(t(locale, "payout.new_text"), `customer:payout:newtext:${order.id}`)
    .text(t(locale, "payout.new_qr"), `customer:payout:newqr:${order.id}`)
    .row()
    .text(t(locale, "payout.support_btn"), `customer:payout:support:${order.id}`);

  return { text, kb };
}

/**
 * Send the localized payout-destination prompt for a verified order.
 * Used by Admin actions (payment verification / nudge) via notifications bot.
 * If the customer has MULTIPLE eligible orders, they must explicitly pick one.
 */
export async function sendPayoutDestinationPromptToCustomer(
  customerTelegramId: string,
  orderId: string
): Promise<boolean> {
  const order = await OrderService.getOrder(orderId);
  if (!order || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    return false;
  }
  const customer = order.customer;
  if (!customer || String(customer.telegramId) !== String(customerTelegramId)) return false;
  const locale = locOf(customer);

  // Multiple eligible orders → require explicit selection first.
  const eligible = await getEligiblePayoutOrdersForCustomer(customer.id);
  let text: string;
  let kb: InlineKeyboard;
  if (eligible.length > 1) {
    kb = new InlineKeyboard();
    const lines = [t(locale, "payout.choose_title"), "", t(locale, "bill.multi_hint")];
    for (const o of eligible.slice(0, 5)) {
      const amount = `${MoneyService.formatAmount(o.targetAmount, o.targetCurrency)} ${o.targetCurrency}`;
      lines.push(`📦 #${o.id.slice(-6)} · ${amount}`);
      kb.text(`📦 #${o.id.slice(-6)} (${amount})`, `customer:payout:choose:${o.id}`).row();
    }
    text = lines.join("\n");
  } else {
    const chooser = await buildPayoutChooser(order, customer, locale);
    text = chooser.text;
    kb = chooser.kb;
  }

  const sent = await sendToCustomer(customerTelegramId, text, { parse_mode: "HTML", reply_markup: kb });
  return Boolean(sent);
}

/** Entry callback: render the chooser for an explicitly selected order. */
customerHandler.callbackQuery(/^customer:payout:choose:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const order = await OrderService.getOrder(orderId);
  const locale = locOf(customer);

  if (!order || order.customerId !== customer.id) {
    return ctx.reply(t(locale, "payout.no_eligible"));
  }
  if (order.status !== "WAITING_PAYOUT") {
    return ctx.reply(t(locale, "payout.not_ready"));
  }
  if (OrderService.isPayoutReady(order as any)) {
    // Already has a confirmed destination — nothing to choose.
    return ctx.reply(t(locale, "payout.saved", { id: order.id }), { parse_mode: "HTML" });
  }

  const chooser = await buildPayoutChooser(order, customer, locale);
  await ctx.reply(chooser.text, { parse_mode: "HTML", reply_markup: chooser.kb });
});

// B REMOVAL: the historical "recent destination" chooser
// (customer:payout:use) is intentionally GONE from the runtime flow.
// Every Order collects FRESH payout info; snapshots remain in the DB for
// audit/history only.

/** Customer chose "new text" → bind session to this order and prompt. */
customerHandler.callbackQuery(/^customer:payout:newtext:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const order = await OrderService.getOrder(orderId);

  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    return ctx.reply(t(locale, "payout.not_ready"));
  }

  setPayoutInputSession(telegramId, { orderId, kind: "text" });
  await ctx.reply(t(locale, "payout.text_input_hint"), { parse_mode: "HTML" });
});

/** Customer chose "new QR" → bind session to this order and prompt for photo. */
customerHandler.callbackQuery(/^customer:payout:newqr:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const order = await OrderService.getOrder(orderId);

  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    return ctx.reply(t(locale, "payout.not_ready"));
  }

  setPayoutInputSession(telegramId, { orderId, kind: "qr" });
  await ctx.reply(t(locale, "payout.qr_input_hint"), { parse_mode: "HTML" });
});

/** FINAL step: only customer confirmation persists the destination. */
customerHandler.callbackQuery(/^customer:payout:confirm:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);

  const session = getPayoutInputSession(telegramId);
  if (!session || session.orderId !== orderId || !session.pendingPreview) {
    return ctx.reply(t(locale, "payout.session_expired"));
  }

  const order = await OrderService.getOrder(orderId);
  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT") {
    clearPayoutInputSession(telegramId);
    return ctx.reply(t(locale, "payout.not_ready"));
  }
  if (OrderService.isPayoutReady(order as any)) {
    clearPayoutInputSession(telegramId);
    return ctx.reply(t(locale, "payout.saved", { id: order.id }), { parse_mode: "HTML" });
  }

  try {
    const updated = await OrderService.attachPayoutDestination(orderId, customer.id, session.pendingPreview as any);
    clearPayoutInputSession(telegramId);

    if (session.pendingPreview.type === "qr") {
      await ctx.reply(t(locale, "payout.qr_attached", { id: orderId }), { parse_mode: "HTML" });
    } else {
      await ctx.reply(t(locale, "payout.saved", { id: orderId }), { parse_mode: "HTML" });
    }

    // NOW the order is truly payout-ready → admin notification (event-driven).
    if (shouldNotifyPayoutReady(updated)) {
      await notifyPayoutReady(updated);
    }
  } catch (err: any) {
    await ctx.reply(t(locale, "error.generic"));
    logger.warn({ err, orderId }, "Failed to attach payout destination");
  }
});

/** Edit → re-enter text input (session kept, preview cleared). */
customerHandler.callbackQuery(/^customer:payout:edit:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const session = getPayoutInputSession(telegramId);
  if (!session || session.orderId !== orderId) {
    return ctx.reply(t(locale, "payout.session_expired"));
  }
  updatePayoutInputSession(telegramId, { kind: "text", pendingPreview: null });
  await ctx.reply(t(locale, "payout.text_input_hint"), { parse_mode: "HTML" });
});

/** Cancel destination input → drop session, back to chooser. */
customerHandler.callbackQuery(/^customer:payout:cancel:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] ?? "";
  const telegramId = String(ctx.from?.id || "");
  clearPayoutInputSession(telegramId);
  await sendPayoutDestinationPromptToCustomerCtx(ctx, orderId);
});

/** 💬 Support from within the payout flow (any stage). */
customerHandler.callbackQuery(/^customer:payout:support:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);

  await ConversationService.getOrCreateConversation(customer.id);
  await ConversationService.addMessage({
    customerId: customer.id,
    senderType: "CUSTOMER",
    content: "[YÊU CẦU GẶP CSKH TRỰC TIẾP]"
  });
  await ctx.reply(t(locale, "support.requested"), { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, true) });

  const notifyText =
    `🛎 <b>YÊU CẦU HỖ TRỢ TỪ KHÁCH HÀNG (luồng nhận tiền):</b>\n` +
    `• Khách: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
    `• Telegram ID: <code>${customer.telegramId}</code>`;
  const notifyKb = new InlineKeyboard()
    .text("👀 Xem khách", `cskh:preview:${customer.id}`)
    .text("🙋 Nhận khách", `cskh:ticket:claim:${customer.id}`);
  await sendToAdminNotificationChat(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
  await notifyEligibleStaff(notifyText, { parse_mode: "HTML", reply_markup: notifyKb });
});

/** ctx-bound variant of the destination prompt (chooser re-render). */
async function sendPayoutDestinationPromptToCustomerCtx(
  ctx: BotContext,
  orderId: string
): Promise<void> {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const order = await OrderService.getOrder(orderId);
  const locale = locOf(customer);
  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    await ctx.reply(t(locale, "payout.not_ready"));
    return;
  }
  const chooser = await buildPayoutChooser(order, customer, locale);
  await ctx.reply(chooser.text, { parse_mode: "HTML", reply_markup: chooser.kb });
}

/**
 * State-aware payout TEXT input. Returns true when the message was consumed
 * as payout-destination data. Deterministic parser first; AI only as strict
 * structured-extraction fallback; ALWAYS a confirmation preview; persistence
 * happens ONLY on the explicit ✅ Confirm callback.
 */
/**
 * L — DB-state binding for payout TEXT input when no explicit session exists.
 * Conservative: only fires when the DETERMINISTIC parser matches AND this
 * customer has EXACTLY ONE eligible (WAITING_PAYOUT, no destination) order.
 * Never guesses across multiple orders; never persists without the ✅ preview.
 * Returns true when the message was consumed.
 */
async function tryBindPayoutTextInputFromState(
  ctx: BotContext,
  customer: { id: string; telegramId: string; language?: string | null },
  text: string
): Promise<boolean> {
  const parsed = parsePayoutDestinationText(text) || parsePayoutDestinationPipe(text);
  if (!parsed) return false;

  const eligible = await getEligiblePayoutOrdersForCustomer(customer.id);
  if (eligible.length === 0) return false;

  const locale = locOf(customer);
  const telegramId = String(customer.telegramId);

  if (eligible.length > 1) {
    const kb = new InlineKeyboard();
    const lines = [t(locale, "payout.choose_title"), "", t(locale, "bill.multi_hint")];
    for (const o of eligible.slice(0, 5)) {
      const amount = `${MoneyService.formatAmount(o.targetAmount, o.targetCurrency)} ${o.targetCurrency}`;
      lines.push(`📦 #${o.id.slice(-6)} · ${amount}`);
      kb.text(`⌨️ 📦 #${o.id.slice(-6)} (${amount})`, `customer:payout:newtext:${o.id}`).row();
    }
    kb.row().text(t(locale, "payout.support_btn"), "customer:menu:support");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
    return true;
  }

  setPayoutInputSession(telegramId, { orderId: eligible[0].id, kind: "text" });
  const session = getPayoutInputSession(telegramId);
  if (session) {
    await handlePayoutTextInput(ctx, customer, session, text);
  }
  return true;
}

async function handlePayoutTextInput(
  ctx: BotContext,
  customer: { id: string; telegramId: string; language?: string | null },
  session: { orderId: string; kind: string },
  text: string
): Promise<boolean> {
  const telegramId = String(customer.telegramId);
  const locale = locOf(customer);

  // Re-validate binding: the order must still belong to this customer, still
  // be in WAITING_PAYOUT and still lack a destination. Stale messages must
  // never overwrite payout details.
  const order = await OrderService.getOrder(session.orderId);
  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    clearPayoutInputSession(telegramId);
    await ctx.reply(t(locale, "payout.not_ready"));
    return true;
  }

  // 1. Deterministic parsers first (free-form + pipe syntax).
  let parsed = parsePayoutDestinationText(text) || parsePayoutDestinationPipe(text);

  // 2. AI structured-extraction fallback ONLY (never invents, never confirms).
  if (!parsed) {
    try {
      parsed = await parsePayoutDestinationWithAi(text, (prompt, sys) =>
        AiProvider.executeTextPrompt(prompt, sys)
      );
    } catch (err) {
      logger.warn({ err, customerId: customer.id }, "Payout AI extraction fallback failed");
      parsed = null;
    }
  }

  if (!parsed) {
    await ctx.reply(t(locale, "payout.invalid"), { parse_mode: "HTML" });
    return true;
  }

  updatePayoutInputSession(telegramId, {
    orderId: session.orderId,
    kind: "text",
    pendingPreview: {
      type: "text",
      currency: order.targetCurrency,
      bankName: parsed.bankName,
      accountNumber: parsed.accountNumber,
      accountName: parsed.accountName
    }
  });

  await ctx.reply(renderPayoutDestinationPreview(parsed as any, locale), {
    parse_mode: "HTML",
    reply_markup: payoutPreviewKeyboard(session.orderId, locale)
  });
  return true;
}

/**
 * Core payout-QR attach used by BOTH the explicit session path and the
 * DB-state fallback path (K). Deterministic decoding is unavailable, so the
 * ORIGINAL QR image is kept as the authoritative payout destination (no AI
 * fabrication). Re-validates ownership + WAITING_PAYOUT + not-ready.
 */
async function attachPayoutQrImage(
  ctx: BotContext,
  customer: { id: string; telegramId: string; language?: string | null },
  order: any,
  clearSession: boolean
): Promise<void> {
  const telegramId = String(customer.telegramId);
  const locale = locOf(customer);

  // Authoritative re-check (K): ownership + WAITING_PAYOUT + no confirmed
  // destination. A stale path must never overwrite payout details.
  const fresh = await OrderService.getOrder(order.id);
  if (!fresh || fresh.customerId !== customer.id || fresh.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(fresh as any)) {
    if (clearSession) clearPayoutInputSession(telegramId);
    await ctx.reply(t(locale, "payout.not_ready"));
    return;
  }
  order = fresh;

  const photo = ctx.message?.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : undefined;
  const document = (ctx.message as any)?.document as any;
  if (!photo && !document) return;

  // Reject obviously unsafe document types early (metadata only — safe check).
  if (!photo && document?.mime_type) {
    const declared = String(document.mime_type).toLowerCase();
    const safeImage = declared.startsWith("image/") || declared === "application/pdf";
    if (!safeImage) {
      await ctx.reply(t(locale, "payout.qr_invalid"), { parse_mode: "HTML" });
      return;
    }
  }

  try {
    const fileId = photo ? photo.file_id : document.file_id;
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer || buffer.length === 0) {
      await ctx.reply(t(locale, "payout.qr_invalid"), { parse_mode: "HTML" });
      return;
    }

    // Safe MIME resolution (magic bytes first) — a payout QR image document
    // with an unreliable Content-Type is still accepted, while a dangerous
    // payload (non-image) is rejected and never stored as a destination.
    const resolved = resolveEvidenceMime({
      telegramMime: document?.mime_type || null,
      fileNameOrPath: document?.file_name || file.file_path,
      responseMime: res.headers.get("content-type"),
      buffer
    });
    if (!resolved.accepted || resolved.mimeType === "application/pdf") {
      logEvidenceDiagnostics(logger, {
        event: "payout_qr_rejected", orderRef: order.id.slice(-6),
        mediaType: photo ? "photo" : "document", mimeType: resolved.mimeType,
        bytes: buffer.length, reason: resolved.reason
      });
      await ctx.reply(t(locale, "payout.qr_invalid"), { parse_mode: "HTML" });
      return;
    }

    const mimeType = resolved.mimeType;
    const evidence = await FileService.saveEvidenceFile(
      buffer,
      `payout_qr_${order.id}_${Date.now()}.${mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg"}`,
      "QR",
      mimeType,
      order.id
    );

    // Deterministic decode attempt — unavailable in this dependency set, so
    // the stored QR image remains the authoritative destination (never AI-
    // fabricated details).
    decodePayoutQrImage(buffer);

    const updated = await OrderService.attachPayoutDestination(order.id, customer.id, {
      type: "qr",
      qrFileId: evidence.id,
      qrFilePath: evidence.filePath,
      qrSha256: evidence.sha256,
      mimeType
    });
    if (clearSession) clearPayoutInputSession(telegramId);

    await ctx.reply(t(locale, "payout.qr_attached", { id: order.id }), { parse_mode: "HTML" });
    if (shouldNotifyPayoutReady(updated)) {
      await notifyPayoutReady(updated);
    }
  } catch (err: any) {
    logger.warn({ err, orderId: order.id }, "Failed to attach payout QR destination");
    await ctx.reply(t(locale, "payout.qr_invalid"), { parse_mode: "HTML" });
  }
}

/**
 * K — Explicit payout-QR session path (kept for wizard-bound uploads).
 */
async function handlePayoutQrUpload(
  ctx: BotContext,
  customer: { id: string; telegramId: string; language?: string | null },
  session: { orderId: string; kind: string }
): Promise<void> {
  const telegramId = String(customer.telegramId);
  const locale = locOf(customer);

  const order = await OrderService.getOrder(session.orderId);
  if (!order || order.customerId !== customer.id || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    clearPayoutInputSession(telegramId);
    await ctx.reply(t(locale, "payout.not_ready"));
    return;
  }

  // Requirement I: while the customer is EXPLICITLY in a payout-QR session,
  // both Telegram photos AND image documents are treated as payout QR. The
  // message is consumed here and can never fall through to bill handling.
  await attachPayoutQrImage(ctx, customer, order, true);
}

// S/X — Partner/CTV self-service: aggregate-only, NO customer data exposed.
// Invisible to normal customers (silent no-op) — attribution stays private.
customerHandler.command("ctv", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const { PartnerService } = await import("../../modules/partner/partner-service.js");
  const { getBotInstance } = await import("../notifications.js");
  const partner = await PartnerService.getPartnerByTelegramId(telegramId);
  if (!partner || partner.status !== "ACTIVE") {
    return; // non-partners: fully silent
  }
  const summary = await PartnerService.partnerSummary(partner.id);
  const me = (getBotInstance() as any)?.botInfo?.username as string | undefined;
  const link = me ? `https://t.me/${me}?start=${PartnerService.referralPayload(partner)}` : null;
  const usd = (d: any) => `$${Number(d ?? 0).toFixed(2)}`;
  await ctx.reply(
    `🤝 <b>CTV CỦA TÔI</b>\n\n` +
      `📦 Đơn hoàn tất đủ điều kiện: <b>${summary.eligibleCompleted}</b>\n` +
      `💵 Hoa hồng HELD: <b>${usd(summary.held)}</b>\n` +
      `💵 AVAILABLE: <b>${usd(summary.available)}</b>\n` +
      `💵 PAID: <b>${usd(summary.paid)}</b>\n\n` +
      (link ? `🔗 Link giới thiệu:\n<code>${link}</code>` : `🔗 Link giới thiệu: liên hệ Admin.`),
    { parse_mode: "HTML" }
  );
});

// O — OPTIONAL post-completion rating (never blocks financial completion).
// Stored as a best-effort audit record (no rating schema subsystem).
customerHandler.callbackQuery(/^customer:rate:skip:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const locale = locOf(await CustomerService.getOrCreateCustomer({ telegramId: String(ctx.from?.id || "") }));
  await ctx.reply(t(locale, "rate.thanks_skip"), { parse_mode: "HTML" }).catch(() => {});
});

customerHandler.callbackQuery(/^customer:rate:([a-zA-Z0-9_-]+):([1-5])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  const rating = Number(ctx.match?.[2] || "0");
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  try {
    await prisma.auditLog.create({
      data: {
        actorId: telegramId,
        actorRole: "CUSTOMER",
        action: "CUSTOMER_RATING",
        targetType: "ORDER",
        targetId: orderId,
        details: { rating }
      }
    });
  } catch {
    // Rating is best-effort only — never blocks or corrupts financial state.
  }
  await ctx.reply(t(locale, "rate.thanks"), { parse_mode: "HTML" }).catch(() => {});
});

// Dynamic Payment QR V1 — SHARED one-message payment card renderer.
// Used by BOTH quote confirmation and 💳 payment-info re-display.
// If a QR image is available (dynamic KHQR/VietQR or configured static QR),
// the card is sent as the photo CAPTION — one single message, no extra
// "Get QR" step. Without a QR it degrades to the concise text card.
export async function sendOrderPaymentCard(ctx: BotContext, order: any, locale: SupportedLocale): Promise<void> {
  const qr = await PaymentQrService.generateForOrder(order.id).catch(() => null);
  const memo = qr?.memo || (await OrderService.getOrderTransferMemo(order).catch(() => ""));
  const snap = (order.receivingAccountSnapshot || {}) as Record<string, any>;
  const ref = `#${order.id.slice(-6).toUpperCase()}`;
  const amount = qr?.amount || MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency);
  const kb = getActiveOrderActionKeyboard(order as any, locale);

  const lines: string[] = [
    `💳 <b>${ref}</b>`,
    t(locale, "paymentqr.pay_line", { amount, currency: order.sourceCurrency })
  ];
  if (snap.bankName) lines.push(t(locale, "order.pay_bank", { bank: snap.bankName }));
  if (snap.accountNumber) lines.push(t(locale, "order.pay_number", { number: snap.accountNumber }));
  lines.push(t(locale, "paymentqr.memo_line", { memo }));
  lines.push("", t(locale, "paymentqr.send_bill_hint"));
  const caption = lines.join("\n");

  // EXPIRED safety: after the Order payment deadline the bot presents NO
  // payment method — no dynamic QR, no static QR, no account details. The
  // 💳 payinfo recovery action obeys the same rule via this shared renderer.
  if (qr?.type === "EXPIRED") {
    await ctx.reply(t(locale, "paymentqr.expired", { ref }), { parse_mode: "HTML" });
    return;
  }

  if (qr?.imageBuffer) {
    // QR message carries a MINIMAL keyboard: the customer already HAS the QR —
    // only ❌ cancel (when safe) and 💬 support are useful here. No redundant
    // "payment-info/Get-QR" action under the QR itself. The 💳 payinfo
    // recovery action remains on the TEXT fallback card and /start view.
    const qrKb = new InlineKeyboard();
    if (OrderService.canCustomerCancel(order as any).allowed) {
      qrKb.text(t(locale, "order.cancel_btn"), `customer:order:cancel:${order.id}`);
      qrKb.text(t(locale, "menu.support"), "customer:menu:support");
    } else {
      qrKb.text(t(locale, "menu.support"), "customer:menu:support");
    }
    await ctx.replyWithPhoto(new InputFile(qr.imageBuffer), {
      caption,
      parse_mode: "HTML",
      reply_markup: qrKb
    });
    return;
  }
  // Text fallback keeps the FULL action keyboard (incl. 💳 payinfo recovery).
  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb });
}

// Dynamic Payment QR V1 — quote confirmation: IMMEDIATELY generate and send
// the Order's payment QR (no extra "Get QR"/"Show QR" step exists).
export async function sendOrderPaymentQrOnConfirm(ctx: BotContext, order: any, locale: SupportedLocale): Promise<void> {
  await sendOrderPaymentCard(ctx, order, locale);
}

//
// J — RESERVED FINANCIAL ROUTING PRECEDENCE:
//   1. Active payout-QR session  -> payout QR (never bill, never CSKH relay)
//   2. Billable order (WAITING_PAYMENT) -> bill evidence (works even while the
//      customer is in HUMAN support; CSKH/Admin are notified separately)
//   3. ONLY THEN generic HUMAN media relay to the assigned staff.
// A customer talking to CSKH while sending a payment bill therefore STILL
// gets the bill stored on the order — it is not swallowed as a support
// attachment, and a payout QR never becomes a bill or a relayed photo.
export async function handleCustomerPhoto(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // 1. State-aware payout QR: an active payout-input session BINDS this photo
  // to ONE explicit eligible Order. Without a session, a photo is never
  // treated as a payout QR (arbitrary photos can never overwrite details).
  const payoutSession = getPayoutInputSession(telegramId);
  if (payoutSession && payoutSession.kind === "qr") {
    await handlePayoutQrUpload(ctx, customer as any, payoutSession);
    return;
  }

  const locale = locOf(customer);

  // 2. K — DB-STATE payout routing (session-loss safe). If the customer has
  // exactly ONE Order in WAITING_PAYOUT without a confirmed destination, an
  // incoming safe image IS the payout QR — even if the in-memory session was
  // lost (restart). Never falls into bill handling or the "no billable order"
  // dead end. Multiple eligible orders → explicit selection, no guessing.
  const payoutEligible = await getEligiblePayoutOrdersForCustomer(customer.id);
  if (payoutEligible.length === 1) {
    await attachPayoutQrImage(ctx, customer as any, payoutEligible[0], false);
    return;
  }
  if (payoutEligible.length > 1) {
    const kb = new InlineKeyboard();
    const lines = [t(locale, "payout.choose_title"), "", t(locale, "bill.multi_hint")];
    for (const o of payoutEligible.slice(0, 5)) {
      const amount = `${MoneyService.formatAmount(o.targetAmount, o.targetCurrency)} ${o.targetCurrency}`;
      lines.push(`📦 #${o.id.slice(-6)} · ${amount}`);
      kb.text(`📷 📦 #${o.id.slice(-6)} (${amount})`, `customer:payout:newqr:${o.id}`).row();
    }
    kb.row().text(t(locale, "payout.support_btn"), "customer:menu:support");
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
    return;
  }

  // 3. Reserved bill evidence routing (beats the generic HUMAN relay).
  // BILL INTAKE SAFETY (multi-order):
  //   - EXACTLY ONE billable Order → attach immediately (unambiguous: its
  //     memo is in the QR the customer just scanned).
  //   - MULTIPLE billable Orders → NEVER guess newest/oldest in a financial
  //     system. The Telegram media reference is kept in a short-lived
  //     PENDING-BILL session and the customer chooses the Order
  //     (customer:bill:attach). No evidence is persisted to ANY Order before
  //     the explicit selection, and the customer never re-sends the image.
  //   "Billable" = every status submitCustomerBill() accepts
  //   (WAITING_PAYMENT + CUSTOMER_SENT_BILL / WAITING_ADMIN_VERIFY /
  //   MANUAL_REVIEW), so a SECOND bill photo is also ingested here — never
  //   swallowed by the HUMAN relay or the "bill.none" dead end.
  const awaitingOrders = await OrderService.getOrdersAwaitingBill(customer.id);

  if (awaitingOrders.length > 0) {
    let fileId: string | undefined;
    let mediaType: "photo" | "document" = "photo";
    if (ctx.message?.photo && ctx.message.photo.length > 0) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      if (photo) {
        fileId = photo.file_id;
        mediaType = "photo";
      }
    } else if (ctx.message?.document) {
      fileId = ctx.message.document.file_id;
      mediaType = "document";
    }

    if (fileId) {
      const mediaInfo = {
        type: mediaType,
        telegramMime: (ctx.message as any)?.document?.mime_type || null,
        fileName: (ctx.message as any)?.document?.file_name || null
      } as const;

      if (awaitingOrders.length === 1) {
        // Unambiguous target: attach immediately. A stale pending-bill
        // session (if any) is superseded by this direct attach.
        clearPendingBillSession(telegramId);
        const targetOrder = awaitingOrders[0];
        try {
          await processBillUpload(ctx, targetOrder.id, fileId, telegramId, mediaInfo);
        } catch (err: any) {
          logger.error({ err }, "Error processing customer bill");
          await ctx.reply(t(locale, "bill.error", { error: String(err?.message || err) }));
          return;
        }
        // J: the bill was accepted while the customer is in HUMAN support —
        // give the assigned staff a short heads-up (no media duplication;
        // Admin gets the full evidence via the bill notification). Best-effort:
        // a failure here must NEVER turn a stored bill into a silent error.
        try {
          const conv = await ConversationService.getOrCreateConversation(customer.id);
          if (conv.mode === "HUMAN" && conv.claimedById) {
            await sendToStaff(
              conv.claimedById,
              `📷 <b>Khách ${customer.fullName || (customer.username ? "@" + customer.username : `Telegram ID ${customer.telegramId}`)} vừa gửi bill cho đơn #${targetOrder.id.slice(-6).toUpperCase()}.</b>\nĐơn chuyển sang chờ Admin đối soát.`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          }
        } catch (convErr) {
          logger.warn({ err: convErr }, "Bill HUMAN heads-up failed (bill already stored)");
        }
        return;
      }

      // MULTIPLE billable Orders → do NOT guess. Preserve the media reference
      // (Telegram file_id — re-downloaded at submission) in a short-lived
      // session and ask the customer which Order the bill belongs to. The
      // ambiguous media is persisted NOWHERE until the customer selects.
      setPendingBillSession(telegramId, {
        fileId,
        mediaType,
        telegramMime: (ctx.message as any)?.document?.mime_type || null,
        fileName: (ctx.message as any)?.document?.file_name || null
      });
      const kb = new InlineKeyboard();
      for (const o of awaitingOrders.slice(0, 5)) {
        const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
        kb.text(
          t(locale, "bill.order_btn", { id: o.id.slice(-6), amount: `${srcAmt} ${o.sourceCurrency}` }),
          `customer:bill:attach:${o.id}`
        ).row();
      }
      await ctx.reply(
        `${t(locale, "bill.multi_title", { count: awaitingOrders.length })}\n\n` +
          `${t(locale, "bill.pending_kept")}\n\n` +
          t(locale, "bill.multi_hint"),
        { parse_mode: "HTML", reply_markup: kb }
      );
      return;
    }
  }

  // 3. Generic HUMAN-mode media relay — only AFTER reserved financial routing
  // declined the media.
  if (await relayCustomerMediaToStaff(ctx, customer, ctx.message?.document ? "document" : "photo")) {
    return;
  }

  if (awaitingOrders.length === 0) {
    return ctx.reply(t(locale, "bill.none"));
  }
}

// Customer voice handler
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function downloadVoiceBuffer(ctx: BotContext): Promise<Buffer | null> {
  const voice = ctx.message?.voice;
  if (!voice) return null;
  const file = await ctx.api.getFile(voice.file_id);
  logger.info({ fileId: voice.file_id, filePath: file.file_path, telegramFileSize: voice.file_size }, "voice: Telegram file metadata");
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const isOgg = buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS";
  logger.info({ bytes: buffer.length, isOgg, contentType: res.headers.get("content-type") }, "voice: downloaded buffer");
  if (buffer.length === 0 || !isOgg) {
    logger.warn({ bytes: buffer.length, isOgg }, "voice: invalid/empty audio buffer (likely HTML/error body)");
    return null;
  }
  return buffer;
}

/** HUMAN: original audio is primary; STT is assistive enrichment only. */
async function handleHumanVoice(ctx: BotContext, customer: { id: string; fullName?: string | null; username?: string | null; telegramId: string }, locale: string): Promise<void> {
  const conv = await ConversationService.getOrCreateConversation(customer.id);

  if (conv.claimedById) {
    // Claimed: forward original audio to assigned staff (relay handles copy + ack).
    await relayCustomerMediaToStaff(ctx, customer, "voice");
  } else {
    // Unclaimed HUMAN: notify support group + copy original audio to the group.
    const messageId = ctx.message?.message_id;
    const fromChatId = ctx.chat?.id;
    const adminChatId = SystemConfigService.getAdminNotificationChatId();
    const name = staffCustomerLabel(customer);
    if (messageId && fromChatId && adminChatId) {
      await copyMessageToChat(fromChatId, messageId, adminChatId);
    }
    await sendToAdminNotificationChat(
      `🎙 <b>Ghi âm từ khách ${escapeHtmlText(name)} · 🆔 Telegram ID ${customer.telegramId || "không có"}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("👀 Xem khách", `cskh:preview:${customer.id}`)
          .text("🙋 Nhận khách", `cskh:ticket:claim:${customer.id}`)
      }
    );
    await ctx.reply(t(locale, "support.media_waiting"), { parse_mode: "HTML" });
  }

  // STT assist — never a blocker, never mutates Quote/Order.
  try {
    const buffer = await downloadVoiceBuffer(ctx);
    if (!buffer) return;
    const transcript = await AiProvider.transcribeAudio(buffer, "audio/ogg");
    if (!transcript || !transcript.transcript) return;

    // Re-fetch AFTER STT: never send transcript to a stale/former owner.
    const fresh = await ConversationService.getOrCreateConversation(customer.id);
    if (fresh.mode !== "HUMAN" || !fresh.claimedById) return;

    const name = staffCustomerLabel(customer);
    let assist = `🎙 <b>GHI ÂM TỪ KHÁCH</b>\n👤 <b>${escapeHtmlText(name)}</b>\n🆔 Telegram ID: <code>${customer.telegramId || "không có"}</code>\n🔖 Ref: #${customer.id.slice(-6).toUpperCase()}\n\n📝 Nội dung nhận diện:\n<i>"${escapeHtmlText(transcript.transcript)}"</i>`;
    if ((transcript.detectedLanguage || "vi") !== "vi") {
      try {
        const translated = await AiProvider.translateText(transcript.transcript, "vi");
        if (translated) assist += `\n\n🇻🇳 Dịch hỗ trợ:\n<i>"${escapeHtmlText(translated)}"</i>`;
      } catch {
        // translation best-effort; original audio remains source of truth
      }
    }
    await sendToStaff(fresh.claimedById, assist, { parse_mode: "HTML" });
  } catch {
    // STT assist is best-effort; original audio was already forwarded.
  }
}

export async function handleCustomerVoice(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const locale = locOf(customer);
  const conv = await ConversationService.getOrCreateConversation(customer.id);

  // Persist the inbound voice with the REAL Telegram message_id (future replay).
  const inboundMessageId = ctx.message?.message_id;
  if (inboundMessageId) {
    await ConversationService.addMessage({
      customerId: customer.id,
      senderType: "CUSTOMER",
      content: "[VOICE]",
      telegramMessageId: inboundMessageId
    });
  }

  if (conv.mode === "HUMAN") {
    await handleHumanVoice(ctx, customer, locale);
    return;
  }

  // AUTO: voice is exchange-intent input -> transcript -> same text pipeline.
  try {
    const buffer = await downloadVoiceBuffer(ctx);
    if (!buffer) {
      await ctx.reply(t(locale, "voice.retry_prompt"), { parse_mode: "HTML" });
      return;
    }

    await FileService.saveEvidenceFile(buffer, `voice_${customer.id}_${Date.now()}.ogg`, "VOICE", "audio/ogg");

    const transcript = await AiProvider.transcribeAudio(buffer, "audio/ogg");
    if (transcript && transcript.transcript) {
      const heard = `${t(locale, "voice.heard")}\n<i>"${escapeHtmlText(transcript.transcript)}"</i>`;
      await ctx.reply(heard, { parse_mode: "HTML" });
      // Feed the SAME exchange-intent pipeline (local parser first, then AI).
      await handleCustomerTextMessage(ctx, transcript.transcript);
    } else {
      await ctx.reply(t(locale, "voice.retry_prompt"), { parse_mode: "HTML" });
    }
  } catch {
    await ctx.reply(t(locale, "voice.retry_prompt"), { parse_mode: "HTML" });
  }
}










