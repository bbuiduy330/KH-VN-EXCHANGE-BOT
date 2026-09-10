import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { CustomerService } from "../../modules/customer/customer-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { ConversationalAIService } from "../../modules/ai/customer-ai-service.js";
import { FileService } from "../../modules/files/file-service.js";
import { RuntimeConfigService } from "../../modules/system-config/runtime-config-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { sendToStaff, sendToAdminNotificationChat, copyMessageToStaff } from "../notifications.js";
import {
  getCustomerMenuKeyboard,
  getBankWizardKeyboard,
  getLanguageSelectorKeyboard,
  getSupportModeKeyboard,
  renderCustomerWelcomeText,
  renderActiveOrderText,
  renderQuoteCard,
  renderSupportActiveText
} from "../menus/customer-menu.js";
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
 * HUMAN-mode media relay to the assigned staff only.
 * Uses Telegram-native copyMessage (no download/re-upload/OCR/STT).
 * If no staff is claimed, acknowledges waiting — never broadcasts.
 */
async function relayCustomerMediaToStaff(
  ctx: BotContext,
  customer: { id: string; fullName?: string | null; language?: string | null },
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
      `📎 <b>Media (${kind}) từ khách [${customer.fullName || customer.id}]:</b>\n` +
        `Dùng caption <code>/msg ${customer.id}</code> trên media để trả lời.`,
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
    const orderKb = getCustomerMenuKeyboard(locale);
    if (!activeOrder.payoutBankSnapshot) {
      orderKb.row().text(
        t(locale, "order.bank_btn", { currency: activeOrder.targetCurrency }),
        `customer:bank:wiz:${activeOrder.targetCurrency}`
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
      reply_markup: getSupportModeKeyboard(locale)
    });
    return;
  }

  // 4. Default: two-way USD/VND rates first (localized labels)
  const text = await renderCustomerWelcomeText(customer.fullName || "Guest", locale);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

// /help command
customerHandler.command("help", async (ctx) => {
  await ctx.reply(
    `đŸ“– <b>HÆ¯á»NG DáºªN Dá»CH Vá»¤ Äá»”I TIá»€N</b>\n\n` +
      `â€¢ Nháº¯n tin tá»± nhiĂªn, vĂ­ dá»¥: <i>"100 Ä‘Ă´"</i>, <i>"10 triá»‡u láº¥y Ä‘Ă´"</i>, <i>"Ä‘á»•i VND láº¥y 100 Ä‘Ă´"</i> Ä‘á»ƒ nháº­n bĂ¡o giĂ¡ tá»©c thá»i.\n` +
      `â€¢ TĂ i khoáº£n nháº­n tiá»n nháº­p ngay trong luá»“ng Ä‘Æ¡n hĂ ng (sau khi gá»­i biĂªn lai), hoáº·c nháº¯n tin theo máº«u:\n` +
      `  <i>VĂ­ dá»¥:</i> <code>VND | Vietcombank | NGUYEN VAN A | 1012345678</code>\n` +
      `â€¢ Xem Ä‘Æ¡n Ä‘Ă£ táº¡o: <code>/orders</code>\n` +
      `â€¢ Há»§y Ä‘Æ¡n Ä‘ang chá»: <code>/cancel</code>\n` +
      `â€¢ Äá»ƒ gáº·p nhĂ¢n viĂªn há»— trá»£ trá»±c tiáº¿p, vui lĂ²ng nháº¥n nĂºt <b>đŸ’¬ Há»— trá»£</b> trong menu.`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
});

// /orders command (Postgres direct with pagination)
customerHandler.command("orders", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply("đŸ“¦ Báº¡n chÆ°a cĂ³ Ä‘Æ¡n hĂ ng nĂ o trong há»‡ thá»‘ng.", {
      reply_markup: getCustomerMenuKeyboard()
    });
  }

  let msg = `đŸ“¦ <b>DANH SĂCH ÄÆ N HĂ€NG Cá»¦A Báº N:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg +=
      `â€¢ ÄÆ¡n <b>${o.id}</b>\n` +
      `  Äá»•i: <b>${srcAmt} ${o.sourceCurrency}</b> â” <b>${tgtAmt} ${o.targetCurrency}</b>\n` +
      `  Tráº¡ng thĂ¡i: <code>${o.status}</code>\n` +
      `  NgĂ y: ${new Date(o.createdAt).toLocaleString("vi-VN")}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() });
});

// /cancel command
customerHandler.command("cancel", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  if (!activeOrder) {
    return ctx.reply("Báº¡n khĂ´ng cĂ³ Ä‘Æ¡n hĂ ng nĂ o Ä‘ang chá» Ä‘á»ƒ há»§y.");
  }
  try {
    await OrderService.cancelOrder(activeOrder.id, customer.id, "CUSTOMER", "KhĂ¡ch hĂ ng tá»± há»§y qua bot");
    await ctx.reply(`âœ… ÄĂ£ há»§y Ä‘Æ¡n hĂ ng <code>${activeOrder.id}</code> thĂ nh cĂ´ng.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`âŒ KhĂ´ng thá»ƒ há»§y Ä‘Æ¡n: ${err.message}`);
  }
});

// /bank command (supports pipe syntax or button wizard)
customerHandler.command("bank", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    const kb = new InlineKeyboard()
      .text("đŸ‡»đŸ‡³ VND", "customer:bank:wiz:VND")
      .text("đŸ‡ºđŸ‡¸ USD", "customer:bank:wiz:USD");

    return ctx.reply(
      `đŸ¦ <b>CĂ€I Äáº¶T TĂ€I KHOáº¢N NHáº¬N TIá»€N</b>\n\n` +
        `Chá»n loáº¡i tiá»n tá»‡ báº¡n muá»‘n nháº­n, hoáº·c nháº­p nhanh báº±ng cĂº phĂ¡p:\n` +
        `<code>/bank TIá»€N_Tá»†|TĂªn NgĂ¢n HĂ ng|TĂªn Chá»§ TK|Sá»‘ TK</code>\n\n` +
        `<i>VĂ­ dá»¥:</i> <code>/bank VND|Vietcombank|NGUYEN VAN A|1012345678</code>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  }

  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 4) {
    return ctx.reply("Thiáº¿u thĂ´ng tin. Äá»‹nh dáº¡ng yĂªu cáº§u: <code>TIá»€N_Tá»†|TĂªn NgĂ¢n HĂ ng|TĂªn Chá»§ TK|Sá»‘ TK</code>", {
      parse_mode: "HTML"
    });
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
    `âœ… <b>ÄĂ£ lÆ°u tĂ i khoáº£n nháº­n tiá»n ${currency.toUpperCase()}:</b>\n` +
      `â€¢ NgĂ¢n hĂ ng: <b>${bankName}</b>\n` +
      `â€¢ Chá»§ tĂ i khoáº£n: <b>${accountName}</b>\n` +
      `â€¢ Sá»‘ tĂ i khoáº£n: <code>${accountNumber}</code>`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
});

// Menu callbacks
// Customer exits HUMAN support themselves ("â†©ï¸ Quay láº¡i Ä‘á»•i tiá»n").
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
  await ctx.reply(t(locale, "lang.changed", { label: LOCALE_LABELS[locale] }), {
    parse_mode: "HTML"
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
});

customerHandler.callbackQuery("customer:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply(t(locOf(customer), "order.list_empty"), { reply_markup: getCustomerMenuKeyboard(locOf(customer)) });
  }

  let msg = `đŸ“¦ <b>DANH SĂCH ÄÆ N HĂ€NG Gáº¦N ÄĂ‚Y:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg +=
      `â€¢ ÄÆ¡n <b>${o.id}</b>\n` +
      `  ${srcAmt} ${o.sourceCurrency} â” ${tgtAmt} ${o.targetCurrency}\n` +
      `  Tráº¡ng thĂ¡i: <code>${o.status}</code>\n\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

customerHandler.callbackQuery("customer:menu:bank", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("đŸ‡»đŸ‡³ VND", "customer:bank:wiz:VND")
    .text("đŸ‡ºđŸ‡¸ USD", "customer:bank:wiz:USD");

  await ctx.reply(
    `đŸ¦ <b>THIáº¾T Láº¬P TĂ€I KHOáº¢N NGĂ‚N HĂ€NG NHáº¬N TIá»€N</b>\n\n` +
      `Vui lĂ²ng chá»n loáº¡i tiá»n tá»‡ báº¡n muá»‘n nháº­n:`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

customerHandler.callbackQuery(/^customer:bank:wiz:(VND|USD)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const currency = ctx.match ? ctx.match[1] : "VND";
  await ctx.reply(
    `đŸ¦ <b>CĂ€I Äáº¶T TĂ€I KHOáº¢N NHáº¬N ${currency}</b>\n\n` +
      `Anh/chá»‹ chá»‰ cáº§n nháº¯n tin theo máº«u sau (cĂ¡c pháº§n cĂ¡ch nhau báº±ng dáº¥u |):\n` +
      `<code>${currency} | TĂªn NgĂ¢n HĂ ng | TĂªn Chá»§ TK | Sá»‘ TK</code>\n\n` +
      `<i>VĂ­ dá»¥:</i>\n` +
      `<code>${currency} | Vietcombank | NGUYEN VAN A | 0123456789</code>`,
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
    content: "[YĂU Cáº¦U Gáº¶P CSKH TRá»°C TIáº¾P]"
  });

  const locale = locOf(customer);
  await ctx.reply(t(locale, "support.requested"), { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard(locale) });

  await sendToAdminNotificationChat(
    `đŸ› <b>YĂU Cáº¦U Há»– TRá»¢ Tá»ª KHĂCH HĂ€NG:</b>\n` +
      `â€¢ KhĂ¡ch: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
      `â€¢ Telegram ID: <code>${customer.telegramId}</code>\n` +
      `CSKH vui lĂ²ng báº¥m nĂºt bĂªn dÆ°á»›i Ä‘á»ƒ tiáº¿p nháº­n.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("đŸ™‹ Tiáº¿p nháº­n há»— trá»£", `cskh:ticket:claim:${customer.id}`)
    }
  );
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

    const receivingSnapshot = order.receivingAccountSnapshot as any;
    const payoutSnapshot = order.payoutBankSnapshot as any;
    const formattedSrc = MoneyService.formatAmount(confirmedQuote.sourceAmount, confirmedQuote.sourceCurrency);

    let msg =
      `đŸ‰ <b>ÄÆ N HĂ€NG ÄĂƒ ÄÆ¯á»¢C Táº O THĂ€NH CĂ”NG!</b>\n` +
      `MĂ£ Ä‘Æ¡n: <code>${order.id}</code>\n\n` +
      `đŸ’µ QuĂ½ khĂ¡ch vui lĂ²ng chuyá»ƒn Ä‘Ăºng sá»‘ tiá»n: <b>${formattedSrc} ${confirmedQuote.sourceCurrency}</b>\n` +
      `đŸ¦ Äáº¿n tĂ i khoáº£n chá»‰ Ä‘á»‹nh:\n` +
      `â€¢ NgĂ¢n hĂ ng: <b>${receivingSnapshot?.bankName}</b>\n` +
      `â€¢ Sá»‘ tĂ i khoáº£n: <code>${receivingSnapshot?.accountNumber}</code>\n` +
      `â€¢ TĂªn tĂ i khoáº£n: <b>${receivingSnapshot?.accountName}</b>\n` +
      `â€¢ Ná»™i dung chuyá»ƒn tiá»n: <code>${order.id}</code>\n\n` +
      `đŸ“¸ <i>Sau khi chuyá»ƒn tiá»n, quĂ½ khĂ¡ch chá»‰ cáº§n chá»¥p vĂ  gá»­i áº£nh biĂªn lai (bill) vĂ o Ä‘Ă¢y.</i>`;

    if (!payoutSnapshot) {
      msg +=
        `\n\nđŸ’¸ <i>ÄÆ¡n hĂ ng chÆ°a cĂ³ tĂ i khoáº£n nháº­n <b>${order.targetCurrency}</b>. ` +
        `Anh/chá»‹ cĂ³ thá»ƒ nháº­p ngay báº±ng nĂºt bĂªn dÆ°á»›i, hoáº·c Ä‘á»ƒ sau khi gá»­i biĂªn lai.</i>`;
    }

    await ctx.reply(msg, {
      parse_mode: "HTML",
      ...(payoutSnapshot ? {} : { reply_markup: getBankWizardKeyboard(order.targetCurrency) })
    });

    if (receivingSnapshot?.qrFilePath) {
      const qrBuffer = await FileService.getFile(receivingSnapshot.qrFilePath);
      if (qrBuffer) {
        await ctx.replyWithPhoto(new InputFile(qrBuffer), {
          caption: `MĂ£ QR thanh toĂ¡n cho Ä‘Æ¡n ${order.id}`
        });
      }
    }

    // Notify admins
    await sendToAdminNotificationChat(
      `đŸ†• <b>ÄÆ N HĂ€NG Má»I ÄÆ¯á»¢C Táº O:</b> <code>${order.id}</code>\n` +
        `â€¢ KhĂ¡ch: <code>${customer.id}</code>\n` +
        `â€¢ Äá»•i: <b>${order.sourceAmount} ${order.sourceCurrency}</b> â” <b>${order.targetAmount} ${order.targetCurrency}</b>\n` +
        `â€¢ Tráº¡ng thĂ¡i: <code>WAITING_PAYMENT</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    // Friendly error when the DESK receiving account is missing (system
    // payment account is operator-side config, not a customer problem).
    const errText = String(err?.message || "");
    if (errText.includes("KhĂ´ng tĂ¬m tháº¥y tĂ i khoáº£n nháº­n")) {
      await ctx.reply(
        `â ï¸ <b>Há»‡ thá»‘ng Ä‘ang cáº­p nháº­t tĂ i khoáº£n thanh toĂ¡n cá»§a quáº§y.</b>\n` +
          `Vui lĂ²ng thá»­ láº¡i sau Ă­t phĂºt, hoáº·c báº¥m <b>đŸ’¬ Há»— trá»£</b> Ä‘á»ƒ nhĂ¢n viĂªn há»— trá»£ trá»±c tiáº¿p.`,
        { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
      );
      return;
    }
    await ctx.reply(`âŒ Lá»—i táº¡o Ä‘Æ¡n: ${err.message}`);
  }
});

// Attach bill to explicitly selected order
customerHandler.callbackQuery(/^customer:bill:attach:([a-zA-Z0-9_-]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match ? ctx.match[1] : undefined;
  const fileId = ctx.match ? ctx.match[2] : undefined;
  if (!orderId || !fileId) return;

  const telegramId = String(ctx.from?.id || "");
  await processBillUpload(ctx, orderId, fileId, telegramId);
});

// Customer text message handler
export async function handleCustomerTextMessage(ctx: BotContext, text: string) {
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: ctx.from?.username,
    fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")
  });

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
        `đŸ’¬ <b>Tin nháº¯n má»›i tá»« khĂ¡ch [${customer.fullName || customer.id}]:</b>\n\n` +
          `"${text}"\n\n` +
          `DĂ¹ng <code>/msg ${customer.id} &lt;ná»™i dung&gt;</code> Ä‘á»ƒ tráº£ lá»i.`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  // Check active order context
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  let activeOrderContext = null;
  if (activeOrder) {
    const recv = activeOrder.receivingAccountSnapshot as any;
    activeOrderContext = {
      orderId: activeOrder.id,
      status: activeOrder.status,
      sourceAmount: activeOrder.sourceAmount,
      sourceCurrency: activeOrder.sourceCurrency,
      targetAmount: activeOrder.targetAmount,
      targetCurrency: activeOrder.targetCurrency,
      receivingBank: recv?.bankName
    };
  }

  // 0. Conversational receiving-account capture (no slash command required):
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
    await CustomerService.setPayoutBank({
      customerId: customer.id,
      currency: currency.toUpperCase(),
      bankName: bankName.trim(),
      accountName: accountName.trim(),
      accountNumber: accountNumber.trim()
    });
    await ctx.reply(
      `âœ… <b>ÄĂ£ lÆ°u tĂ i khoáº£n nháº­n tiá»n ${currency.toUpperCase()}:</b>\n` +
        `â€¢ NgĂ¢n hĂ ng: <b>${bankName.trim()}</b>\n` +
        `â€¢ Chá»§ tĂ i khoáº£n: <b>${accountName.trim()}</b>\n` +
        `â€¢ Sá»‘ tĂ i khoáº£n: <code>${accountNumber.trim()}</code>`,
      { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
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

      const keyboard = new InlineKeyboard().text("âœ… XĂ¡c nháº­n Ä‘á»•i tiá»n", `customer:quote:confirm:${quote.id}`);
      const expiryMinutes = RuntimeConfigService.getQuoteExpiryMinutes();

      await ctx.reply(renderQuoteCard(quote, expiryMinutes, locOf(customer)), { parse_mode: "HTML", reply_markup: keyboard });
      await maybeSuggestLanguageSwitch(ctx, customer, text);
      return;
    } catch (err: any) {
      await ctx.reply(`â ï¸ ${err.message}`);
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
        customerName: customer.fullName || customer.username || "QuĂ½ khĂ¡ch",
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

  await ctx.reply(
    `Xin chĂ o! QuĂ½ khĂ¡ch cĂ³ thá»ƒ nháº¯n tin yĂªu cáº§u Ä‘á»•i tiá»n, vĂ­ dá»¥: <i>'Ä‘á»•i 500 USD sang VND'</i> hoáº·c nháº¥n <b>đŸ’¬ Há»— trá»£</b> Ä‘á»ƒ gáº·p nhĂ¢n viĂªn tÆ° váº¥n.`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
}

// Hardened Telegram File Downloader & Bill Processor
async function processBillUpload(ctx: BotContext, orderId: string, fileId: string, telegramId: string) {
  const maxBytes = (env.MAX_UPLOAD_MB || 15) * 1024 * 1024;
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

  const file = await ctx.api.getFile(fileId);

  if (file.file_size && file.file_size > maxBytes) {
    return ctx.reply(`âŒ KĂ­ch thÆ°á»›c tá»‡p vÆ°á»£t quĂ¡ giá»›i háº¡n cho phĂ©p (${env.MAX_UPLOAD_MB}MB). Vui lĂ²ng gá»­i áº£nh nháº¹ hÆ¡n.`);
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Táº£i tá»‡p tá»« Telegram tháº¥t báº¡i (HTTP ${res.status})`);
  }

  const mimeType = res.headers.get("content-type") || "image/jpeg";
  if (!allowedMimes.includes(mimeType) && !mimeType.startsWith("image/")) {
    return ctx.reply("âŒ Äá»‹nh dáº¡ng tá»‡p khĂ´ng Ä‘Æ°á»£c há»— trá»£. Vui lĂ²ng gá»­i áº£nh chá»¥p rĂµ nĂ©t (JPG, PNG, WebP) hoáº·c PDF.");
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    return ctx.reply(`âŒ KĂ­ch thÆ°á»›c tá»‡p thá»±c táº¿ vÆ°á»£t quĂ¡ giá»›i háº¡n ${env.MAX_UPLOAD_MB}MB.`);
  }

  const safeExt = mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg";
  const sanitizedFileName = `bill_${orderId}_${Date.now()}.${safeExt}`;

  const result: any = await OrderService.submitCustomerBill(
    orderId,
    buffer,
    sanitizedFileName,
    mimeType,
    telegramId
  );

  if (result.status === "SUSPICIOUS") {
    await ctx.reply(
      `â ï¸ <b>Há»‡ thá»‘ng phĂ¡t hiá»‡n biĂªn lai cĂ³ dáº¥u hiá»‡u cáº§n kiá»ƒm tra thĂªm.</b>\n` +
        `ÄÆ¡n hĂ ng <code>${orderId}</code> Ä‘Ă£ Ä‘Æ°á»£c chuyá»ƒn sang cháº¿ Ä‘á»™ báº£o máº­t Ä‘á»ƒ quáº£n trá»‹ viĂªn kiá»ƒm tra trá»±c tiáº¿p.`,
      { parse_mode: "HTML" }
    );

    await sendToAdminNotificationChat(
      `đŸ¨ <b>Cáº¢NH BĂO Báº¢O Máº¬T: BIĂN LAI TRĂ™NG Láº¶P / Báº¤T THÆ¯á»œNG</b>\n` +
        `â€¢ MĂ£ Ä‘Æ¡n: <code>${orderId}</code>\n` +
        `â€¢ Telegram: <code>${telegramId}</code>\n` +
        `â€¢ Cáº£nh bĂ¡o: <b>${result.flagReason}</b>\n` +
        `Admin vui lĂ²ng kiá»ƒm tra Ä‘á»‘i soĂ¡t thá»§ cĂ´ng!`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("đŸ” Kiá»ƒm tra Ä‘Æ¡n", `admin:order:detail:${orderId}`)
      }
    );
  } else if (result.status === "MANUAL_REVIEW") {
    await ctx.reply(
      `â„¹ï¸ <b>ÄĂ£ nháº­n biĂªn lai bá»• sung cho Ä‘Æ¡n ${orderId}.</b>\n` +
        `ÄÆ¡n hĂ ng Ä‘Ă£ Ä‘Æ°á»£c ghi nháº­n Ä‘áº§y Ä‘á»§ báº±ng chá»©ng vĂ  chuyá»ƒn Admin kiá»ƒm duyá»‡t thá»§ cĂ´ng.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `âœ… <b>ÄĂ£ nháº­n Ä‘Æ°á»£c biĂªn lai thanh toĂ¡n cho Ä‘Æ¡n ${orderId}.</b>\n\n` +
        `đŸ”’ Theo quy Ä‘á»‹nh tĂ i chĂ­nh an toĂ n, Admin sáº½ trá»±c tiáº¿p kiá»ƒm tra biáº¿n Ä‘á»™ng tĂ i khoáº£n thá»±c táº¿ vĂ  xĂ¡c nháº­n trong giĂ¢y lĂ¡t. Xin cáº£m Æ¡n quĂ½ khĂ¡ch!`,
      { parse_mode: "HTML" }
    );

    // Phase A: after the bill is accepted, proactively collect the payout
    // account using the target currency already known from the Order.
    try {
      const billedOrder = await OrderService.getOrder(orderId);
      if (billedOrder && !billedOrder.payoutBankSnapshot) {
        await ctx.reply(
          `đŸ’¸ <b>BÆ¯á»C TIáº¾P THEO â€” TĂ€I KHOáº¢N NHáº¬N TIá»€N</b>\n\n` +
            `ÄÆ¡n <code>${orderId}</code> sáº½ chi ra <b>${MoneyService.formatAmount(billedOrder.targetAmount, billedOrder.targetCurrency)} ${billedOrder.targetCurrency}</b>.\n` +
            `Anh/chá»‹ nháº­p tĂ i khoáº£n nháº­n tiá»n ngay Ä‘á»ƒ khi Admin giáº£i ngĂ¢n, tiá»n vá» tá»©c thĂ¬:`,
          { parse_mode: "HTML", reply_markup: getBankWizardKeyboard(billedOrder.targetCurrency) }
        );
      }
    } catch (promptErr) {
      logger.warn({ err: promptErr, orderId }, "Failed to send payout-details prompt after bill");
    }

    await sendToAdminNotificationChat(
      `đŸ“¸ <b>BIĂN LAI Má»I CHO ÄÆ N ${orderId}</b>\n` +
        `Admin hĂ£y kiá»ƒm tra tĂ i khoáº£n ngĂ¢n hĂ ng thá»±c táº¿ vĂ  xĂ¡c nháº­n Ä‘Æ¡n.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("đŸ” Duyá»‡t tiá»n náº¡p", `admin:pay:step1:${orderId}`)
      }
    );
  }
}

// Customer photo or document handler (Safe Bill Target Selection)
export async function handleCustomerPhoto(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // HUMAN mode: relay photo/document to assigned staff only (no bill attach).
  if (await relayCustomerMediaToStaff(ctx, customer, ctx.message?.document ? "document" : "photo")) {
    return;
  }

  const locale = locOf(customer);

  // Safe Bill Target Selection: Query orders waiting for bill
  const awaitingOrders = await OrderService.getOrdersAwaitingBill(customer.id);

  if (awaitingOrders.length === 0) {
    return ctx.reply(t(locale, "bill.none"));
  }

  let fileId: string | undefined;
  if (ctx.message?.photo && ctx.message.photo.length > 0) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (photo) fileId = photo.file_id;
  } else if (ctx.message?.document) {
    fileId = ctx.message.document.file_id;
  }

  if (!fileId) return;

  // If customer has exactly ONE eligible order, attach automatically
  if (awaitingOrders.length === 1) {
    const targetOrder = awaitingOrders[0];
    try {
      await processBillUpload(ctx, targetOrder.id, fileId, telegramId);
    } catch (err: any) {
      logger.error({ err }, "Error processing single customer bill");
      await ctx.reply(t(locale, "bill.error", { error: String(err?.message || err) }));
    }
    return;
  }

  // If multiple eligible orders exist, present interactive selection buttons
  const keyboard = new InlineKeyboard();
  for (const order of awaitingOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency);
    keyboard.text(
      `đŸ“‹ ÄÆ¡n ${order.id.slice(-6)} (${srcAmt} ${order.sourceCurrency})`,
      `customer:bill:attach:${order.id}:${fileId}`
    ).row();
  }

  await ctx.reply(
    `${t(locale, "bill.multi_title", { count: awaitingOrders.length })}\n\n` +
      t(locale, "bill.multi_hint"),
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  );
}

// Customer voice handler
export async function handleCustomerVoice(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // HUMAN mode: relay voice to assigned staff only (no STT).
  if (await relayCustomerMediaToStaff(ctx, customer, "voice")) {
    return;
  }

  const locale = locOf(customer);

  try {
    const voice = ctx.message?.voice;
    if (!voice) return;
    const file = await ctx.api.getFile(voice.file_id);
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Preserve original Telegram voice file locally
    const savedEvidence = await FileService.saveEvidenceFile(
      buffer,
      `voice_${customer.id}_${Date.now()}.ogg`,
      "VOICE",
      "audio/ogg"
    );

    // Transcribe using Gemini
    const transcribeResult = await AiProvider.transcribeAudio(buffer, "audio/ogg");
    if (transcribeResult && transcribeResult.transcript) {
      const langTag = transcribeResult.detectedLanguage?.toUpperCase() || "VI";
      await ctx.reply(t(locale, "voice.transcript", { lang: (transcribeResult.detectedLanguage || "VI").toUpperCase(), text: transcribeResult.transcript }), { parse_mode: "HTML" });
      logger.info(
        {
          customerId: customer.id,
          sha256: savedEvidence.sha256,
          detectedLanguage: transcribeResult.detectedLanguage
        },
        "Customer voice transcribed successfully"
      );
      await handleCustomerTextMessage(ctx, transcribeResult.transcript);
    } else {
      await ctx.reply(t(locale, "voice.failed"));
    }
  } catch (err: any) {
    logger.error({ err }, "Voice processing error");
    await ctx.reply("âŒ Lá»—i xá»­ lĂ½ tin nháº¯n thoáº¡i");
  }
}








