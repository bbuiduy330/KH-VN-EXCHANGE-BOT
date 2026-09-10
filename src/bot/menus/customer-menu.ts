import { InlineKeyboard } from "grammy";
import { Quote, Order, ExchangeRate } from "@prisma/client";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  SupportedLocale,
  resolveLocale,
  t
} from "../../modules/i18n/locales.js";

/**
 * Main customer menu. Receiving-account entry is NOT here — those details
 * belong to the order flow only. Includes 🌐 Language.
 */
export function getCustomerMenuKeyboard(locale: SupportedLocale | string = DEFAULT_LOCALE): InlineKeyboard {
  const loc = resolveLocale(locale);
  return new InlineKeyboard()
    .text(t(loc, "menu.exchange"), "customer:menu:quote")
    .text(t(loc, "menu.orders"), "customer:menu:orders")
    .row()
    .text(t(loc, "menu.support"), "customer:menu:support")
    .text(t(loc, "menu.language"), "customer:menu:language");
}

/** Language selector keyboard (vi/en/km/zh). */
export function getLanguageSelectorKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Two rows of two
  kb.text(LOCALE_LABELS.vi, "customer:lang:vi")
    .text(LOCALE_LABELS.en, "customer:lang:en")
    .row()
    .text(LOCALE_LABELS.km, "customer:lang:km")
    .text(LOCALE_LABELS.zh, "customer:lang:zh");
  return kb;
}

/** Optional first-time language chooser (same buttons). */
export function getFirstTimeLanguageKeyboard(): InlineKeyboard {
  return getLanguageSelectorKeyboard();
}

/**
 * Contextual bank-account wizard button used inside Order flow.
 * Receiving/payout details belong to the order flow only.
 */
export function getBankWizardKeyboard(
  currency: string,
  locale: SupportedLocale | string = DEFAULT_LOCALE
): InlineKeyboard {
  const loc = resolveLocale(locale);
  return new InlineKeyboard().text(
    t(loc, "order.bank_btn", { currency }),
    `customer:bank:wiz:${currency}`
  );
}

/**
 * Rates-first welcome for customers without any active transaction.
 * Two-way USD/VND only, customer-facing (no buy/sell terminology).
 * Labels localized; numeric values from MoneyService unchanged.
 */
export async function renderCustomerWelcomeText(
  name: string,
  locale: SupportedLocale | string = DEFAULT_LOCALE
): Promise<string> {
  const loc = resolveLocale(locale);
  let ratesBlock = "";
  try {
    const allRates: ExchangeRate[] = await QuoteService.getAllRates();
    const usdVnd = allRates.find((r) => r.pair === "USD/VND");
    if (usdVnd) {
      const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(
        usdVnd.baseRate,
        usdVnd.buyMargin,
        usdVnd.sellMargin
      );
      ratesBlock =
        `🇺🇸 USD → 🇻🇳 VND\n` +
        `1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND\n\n` +
        `🇻🇳 VND → 🇺🇸 USD\n` +
        `1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND\n`;
    }
  } catch {
    ratesBlock = `${t(loc, "welcome.rates_missing")}\n`;
  }

  return (
    `${t(loc, "welcome.hello", { name: name || "" })}\n\n` +
    `${t(loc, "welcome.rates_title")}\n\n` +
    ratesBlock +
    `\n${t(loc, "welcome.examples_intro")}\n` +
    `${t(loc, "welcome.example_1")}\n` +
    `${t(loc, "welcome.example_2")}\n` +
    `${t(loc, "welcome.example_3")}\n` +
    `${t(loc, "welcome.example_4")}\n\n` +
    t(loc, "welcome.footer")
  );
}

/**
 * Active order status view shown instead of the generic welcome.
 */
export async function renderActiveOrderText(
  order: Order,
  locale: SupportedLocale | string = DEFAULT_LOCALE
): Promise<string> {
  const loc = resolveLocale(locale);
  const statusKey = `status.${order.status}`;
  const statusLabel = t(loc, statusKey);
  const srcAmt = MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency);
  const tgtAmt = MoneyService.formatAmount(order.targetAmount, order.targetCurrency);

  let msg =
    `${t(loc, "order.active_title")}\n\n` +
    `${t(loc, "order.id", { id: order.id })}\n` +
    `${t(loc, "order.exchange", { src: `${srcAmt} ${order.sourceCurrency}`, tgt: `${tgtAmt} ${order.targetCurrency}` })}\n` +
    `${t(loc, "order.status", { status: statusLabel === statusKey ? order.status : statusLabel })}\n`;

  if (order.status === "WAITING_PAYMENT") {
    const recv = order.receivingAccountSnapshot as {
      bankName?: string;
      accountName?: string;
      accountNumber?: string;
    } | null;

    if (recv?.accountNumber) {
      msg +=
        `\n${t(loc, "order.pay_title")}\n` +
        `${t(loc, "order.pay_bank", { bank: recv.bankName || "N/A" })}\n` +
        `${t(loc, "order.pay_name", { name: recv.accountName || "N/A" })}\n` +
        `${t(loc, "order.pay_number", { number: recv.accountNumber })}\n` +
        `${t(loc, "order.pay_amount", { amount: `${srcAmt} ${order.sourceCurrency}` })}\n\n` +
        t(loc, "order.pay_bill_hint");
    } else {
      msg += `\n${t(loc, "order.pay_wait")}`;
    }
  }

  return msg;
}

/**
 * Shared customer quote card (used by chat flow and /start resume).
 * Labels localized; numeric values from MoneyService unchanged.
 */
export function renderQuoteCard(
  quote: Quote,
  expiryMinutes: number,
  locale: SupportedLocale | string = DEFAULT_LOCALE
): string {
  const loc = resolveLocale(locale);
  const rateDisplay = MoneyService.formatEffectiveRate(
    quote.sourceCurrency,
    quote.targetCurrency,
    quote.effectiveRate
  );
  const formattedSrc = MoneyService.formatAmount(quote.sourceAmount, quote.sourceCurrency);
  const formattedTgt = MoneyService.formatAmount(quote.targetAmount, quote.targetCurrency);

  return (
    `${t(loc, "quote.title")}\n\n` +
    `${t(loc, "quote.send", { src: `${formattedSrc} ${quote.sourceCurrency}` })}\n` +
    `${t(loc, "quote.receive", { tgt: `${formattedTgt} ${quote.targetCurrency}` })}\n` +
    `${t(loc, "quote.rate", { rate: rateDisplay })}\n` +
    `${t(loc, "quote.fee", { fee: `${quote.fee} ${quote.feeCurrency}` })}\n` +
    `${t(loc, "quote.expiry", { minutes: expiryMinutes })}\n\n` +
    t(loc, "quote.confirm_hint")
  );
}

/** Support-mode banner text. */
export function renderSupportActiveText(locale: SupportedLocale | string = DEFAULT_LOCALE): string {
  const loc = resolveLocale(locale);
  return `${t(loc, "support.active_title")}\n\n${t(loc, "support.active_body")}`;
}

/** Keyboard shown while customer is in HUMAN support. */
export function getSupportModeKeyboard(locale: SupportedLocale | string = DEFAULT_LOCALE): InlineKeyboard {
  const loc = resolveLocale(locale);
  return new InlineKeyboard()
    .text(t(loc, "menu.exit_support"), "customer:support:exit")
    .row()
    .text(t(loc, "menu.exchange"), "customer:menu:quote")
    .text(t(loc, "menu.orders"), "customer:menu:orders")
    .row()
    .text(t(loc, "menu.support"), "customer:menu:support")
    .text(t(loc, "menu.language"), "customer:menu:language");
}

export { SUPPORTED_LOCALES, LOCALE_LABELS };

/**
 * Persistent bottom ReplyKeyboardMarkup for PRIVATE customer chat.
 * Two compact rows. Transaction-specific actions stay inline on Quote/Order.
 */
export function getCustomerReplyKeyboard(
  locale: SupportedLocale | string = DEFAULT_LOCALE,
  inHuman: boolean = false
): { keyboard: { text: string }[][]; resize_keyboard: boolean; is_persistent: boolean; one_time_keyboard: boolean } {
  const loc = resolveLocale(locale);
  const primary = inHuman ? t(loc, "menu.exit_support") : t(loc, "menu.exchange");
  const supportLabel = inHuman ? t(loc, "menu.support_active") : t(loc, "menu.support");
  return {
    keyboard: [
      [{ text: primary }, { text: t(loc, "menu.orders") }],
      [{ text: supportLabel }, { text: t(loc, "menu.language") }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false
  };
}

