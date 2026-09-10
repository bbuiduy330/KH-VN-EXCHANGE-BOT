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
import { sendToStaff, sendToAdminNotificationChat, copyMessageToStaff, copyMessageToChat, notifyEligibleStaff } from "../notifications.js";
import { SystemConfigService } from "../../modules/system-config/system-config-service.js";
import {
  getCustomerMenuKeyboard,
  getBankWizardKeyboard,
  getLanguageSelectorKeyboard,
  getSupportModeKeyboard,
  getCustomerReplyKeyboard,
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
  customer: { id: string; fullName?: string | null; username?: string | null; language?: string | null },
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
      `📎 <b>Media (${kind}) từ khách ${customer.fullName || (customer.username ? "@" + customer.username : `#${customer.id.slice(-6)}`)}:</b>\n` +
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
  await ctx.reply(
    `📖 <b>HƯỚNG DẪN DỊCH VỤ ĐỔI TIỀN</b>\n\n` +
      `• Nhắn tin tự nhiên, ví dụ: <i>"100 đĂ´"</i>, <i>"10 triệu lấy đĂ´"</i>, <i>"đổi VND lấy 100 đĂ´"</i> để nhận báo giá tức thời.\n` +
      `• Tài khoản nhận tiền nhập ngay trong luồng đơn hàng (sau khi gửi biên lai), hoặc nhắn tin theo mẫu:\n` +
      `  <i>Ví dụ:</i> <code>VND | Vietcombank | NGUYEN VAN A | 1012345678</code>\n` +
      `. Xem dơn đĂ£ tạo: <code>/orders</code>\n` +
      `• Hủy đơn đang chờ: <code>/cancel</code>\n` +
      `• Để gặp nhân viên hỗ trợ trực tiếp, vui lòng nhấn nút <b>💬 Hỗ trợ</b> trong menu.`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
});

// /orders command (Postgres direct with pagination)
customerHandler.command("orders", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply("📦 Bạn chưa có đơn hàng nào trong hệ thống.", {
      reply_markup: getCustomerMenuKeyboard()
    });
  }

  let msg = `📦 <b>DANH SÁCH ĐƠN HÀNG CỦA BẠN:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg +=
      `. Dơn <b>${o.id}</b>\n` +
      `  Dổi: <b>${srcAmt} ${o.sourceCurrency}</b> ➔ <b>${tgtAmt} ${o.targetCurrency}</b>\n` +
      `  Trạng thái: <code>${o.status}</code>\n` +
      `  Ngày: ${new Date(o.createdAt).toLocaleString("vi-VN")}\n\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() });
});

// /cancel command
customerHandler.command("cancel", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const activeOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);
  if (!activeOrder) {
    return ctx.reply("Bạn không có đơn hàng nào đang chờ để hủy.");
  }
  try {
    await OrderService.cancelOrder(activeOrder.id, customer.id, "CUSTOMER", "Khách hàng tự hủy qua bot");
    await ctx.reply(`✅ ĐĂ£ hủy đơn hàng <code>${activeOrder.id}</code> thành công.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ Không thể hủy đơn: ${err.message}`);
  }
});

// /bank command (supports pipe syntax or button wizard)
customerHandler.command("bank", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    const kb = new InlineKeyboard()
      .text("🇻🇳 VND", "customer:bank:wiz:VND")
      .text("🇺🇸 USD", "customer:bank:wiz:USD");

    return ctx.reply(
      `🏦 <b>CÀI ĐẶT TÀI KHOẢN NHẬN TIỀN</b>\n\n` +
        `Chọn loại tiền tệ bạn muốn nhận, hoặc nhập nhanh bằng cú pháp:\n` +
        `<code>/bank TIỀN_TỆ|Tên Ngân Hàng|Tên Chủ TK|Số TK</code>\n\n` +
        `<i>Ví dụ:</i> <code>/bank VND|Vietcombank|NGUYEN VAN A|1012345678</code>`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  }

  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 4) {
    return ctx.reply("Thiếu thông tin. Định dạng yêu cầu: <code>TIỀN_TỆ|Tên Ngân Hàng|Tên Chủ TK|Số TK</code>", {
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
    `✅ <b>ĐĂ£ lưu tài khoản nhận tiền ${currency.toUpperCase()}:</b>\n` +
      `• Ngân hàng: <b>${bankName}</b>\n` +
      `• Chủ tài khoản: <b>${accountName}</b>\n` +
      `• Số tài khoản: <code>${accountNumber}</code>`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
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

customerHandler.callbackQuery("customer:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply(t(locOf(customer), "order.list_empty"), { reply_markup: getCustomerMenuKeyboard(locOf(customer)) });
  }

  let msg = `📦 <b>DANH SÁCH ĐƠN HÀNG GẦN ĐÂY:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
    const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
    msg +=
      `• Đơn <b>${o.id}</b>\n` +
      `  ${srcAmt} ${o.sourceCurrency} ➔ ${tgtAmt} ${o.targetCurrency}\n` +
      `  Trạng thái: <code>${o.status}</code>\n\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

customerHandler.callbackQuery("customer:menu:bank", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("🇻🇳 VND", "customer:bank:wiz:VND")
    .text("🇺🇸 USD", "customer:bank:wiz:USD");

  await ctx.reply(
    `🏦 <b>THIẾT LẬP TÀI KHOẢN NGÂN HÀNG NHẬN TIỀN</b>\n\n` +
      `Vui lòng chọn loại tiền tệ bạn muốn nhận:`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

customerHandler.callbackQuery(/^customer:bank:wiz:(VND|USD)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const currency = ctx.match ? ctx.match[1] : "VND";
  await ctx.reply(
    `🏦 <b>CÀI ĐẶT TÀI KHOẢN NHẬN ${currency}</b>\n\n` +
      `Anh/chị chỉ cần nhắn tin theo mẫu sau (các phần cách nhau bằng dấu |):\n` +
      `<code>${currency} | Tên Ngân Hàng | Tên Chủ TK | Số TK</code>\n\n` +
      `<i>Ví dụ:</i>\n` +
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
      `🎉 <b>ĐƠN HÀNG ĐÃ ĐƯỢC TẠO THÀNH CÔNG!</b>\n` +
      `Mã đơn: <code>${order.id}</code>\n\n` +
      `💵 Quý khách vui lòng chuyển đĂºng số tiền: <b>${formattedSrc} ${confirmedQuote.sourceCurrency}</b>\n` +
      `🏦 Đến tài khoản chỉ định:\n` +
      `• Ngân hàng: <b>${receivingSnapshot?.bankName}</b>\n` +
      `• Số tài khoản: <code>${receivingSnapshot?.accountNumber}</code>\n` +
      `• Tên tài khoản: <b>${receivingSnapshot?.accountName}</b>\n` +
      `• Nội dung chuyển tiền: <code>${order.id}</code>\n\n` +
      `📸 <i>Sau khi chuyển tiền, quý khách chỉ cần chụp và gửi ảnh biên lai (bill) vào đĂ¢y.</i>`;

    if (!payoutSnapshot) {
      msg +=
        `\n\n💸 <i>Đơn hàng chưa có tài khoản nhận <b>${order.targetCurrency}</b>. ` +
        `Anh/chị có thể nhập ngay bằng nút bên dưới, hoặc để sau khi gửi biên lai.</i>`;
    }

    await ctx.reply(msg, {
      parse_mode: "HTML",
      ...(payoutSnapshot ? {} : { reply_markup: getBankWizardKeyboard(order.targetCurrency) })
    });

    if (receivingSnapshot?.qrFilePath) {
      const qrBuffer = await FileService.getFile(receivingSnapshot.qrFilePath);
      if (qrBuffer) {
        await ctx.replyWithPhoto(new InputFile(qrBuffer), {
          caption: `Mã QR thanh toán cho đơn ${order.id}`
        });
      }
    }

    // Notify admins
    await sendToAdminNotificationChat(
      `🆕 <b>ĐƠN HÀNG MỚI DƯỢC TẠO:</b> <code>${order.id}</code>\n` +
        `• Khách: <code>${customer.id}</code>\n` +
        `• Đổi: <b>${order.sourceAmount} ${order.sourceCurrency}</b> ➔ <b>${order.targetAmount} ${order.targetCurrency}</b>\n` +
        `• Trạng thái: <code>WAITING_PAYMENT</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    // Friendly error when the DESK receiving account is missing (system
    // payment account is operator-side config, not a customer problem).
    const errText = String(err?.message || "");
    if (errText.includes("Không tìm thấy tài khoản nhận")) {
      await ctx.reply(
        `⚠️ <b>Hệ thống đang cập nhật tài khoản thanh toán của quầy.</b>\n` +
          `Vui lòng thử lại sau ít phút, hoặc bấm <b>💬 Hỗ trợ</b> để nhân viên hỗ trợ trực tiếp.`,
        { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
      );
      return;
    }
    await ctx.reply(`❌ Lỗi tạo đơn: ${err.message}`);
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
      const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);
      if (myOrders.length === 0) {
        await ctx.reply(t(locale, "order.list_empty"), { parse_mode: "HTML", reply_markup: getCustomerReplyKeyboard(locale, inHuman) });
      } else {
        let msg = `📦 <b>DANH SÁCH ĐƠN HÀNG GẦN ĐÂY:</b>\n\n`;
        for (const o of myOrders.slice(0, 5)) {
          const srcAmt = MoneyService.formatAmount(o.sourceAmount, o.sourceCurrency);
          const tgtAmt = MoneyService.formatAmount(o.targetAmount, o.targetCurrency);
          msg += `• Đơn <b>${o.id.slice(-6)}</b>\n  ${srcAmt} ${o.sourceCurrency} ➔ ${tgtAmt} ${o.targetCurrency}\n  Trạng thái: <code>${o.status}</code>\n\n`;
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
export async function handleCustomerTextMessage(ctx: BotContext, text: string) {
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: ctx.from?.username,
    fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")
  });

  // Reserved persistent-keyboard controls are navigation, never freeform input.
  if (await handleReservedCustomerControl(ctx, customer, text)) return;

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
        `💬 <b>Tin nhắn từ ${customer.fullName || (customer.username ? "@" + customer.username : `#${customer.id.slice(-6)}`)}:</b>\n\n` +
          `"${text}"`,
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
      `✅ <b>ĐĂ£ lưu tài khoản nhận tiền ${currency.toUpperCase()}:</b>\n` +
        `• Ngân hàng: <b>${bankName.trim()}</b>\n` +
        `• Chủ tài khoản: <b>${accountName.trim()}</b>\n` +
        `. Số tài khoản: <code>${accountNumber.trim()}</code>`,
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

      const keyboard = new InlineKeyboard().text("✅ Xác nhận đổi tiền", `customer:quote:confirm:${quote.id}`);
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

  await ctx.reply(
    `Xin chào! Quý khách có thể nhắn tin yêu cầu đổi tiền, ví dụ: <i>'dổi 500 USD sang VND'</i> hoặc nhấn <b>💬 Hỗ trợ</b> để gặp nhân viên tư vấn.`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
}

// Hardened Telegram File Downloader & Bill Processor
async function processBillUpload(ctx: BotContext, orderId: string, fileId: string, telegramId: string) {
  const maxBytes = (env.MAX_UPLOAD_MB || 15) * 1024 * 1024;
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

  const file = await ctx.api.getFile(fileId);

  if (file.file_size && file.file_size > maxBytes) {
    return ctx.reply(`❌ Kích thước tệp vượt quá giới hạn cho phép (${env.MAX_UPLOAD_MB}MB). Vui lòng gửi ảnh nhẹ hơn.`);
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Tải tệp từ Telegram thất bại (HTTP ${res.status})`);
  }

  const mimeType = res.headers.get("content-type") || "image/jpeg";
  if (!allowedMimes.includes(mimeType) && !mimeType.startsWith("image/")) {
    return ctx.reply("❌ Định dạng tệp không được hỗ trợ. Vui lòng gửi ảnh chụp rõ nét (JPG, PNG, WebP) hoặc PDF.");
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    return ctx.reply(`❌ Kích thước tệp thực tế vượt quá giới hạn ${env.MAX_UPLOAD_MB}MB.`);
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
      `⚠️ <b>Hệ thống phát hiện biên lai có dấu hiệu cần kiểm tra thêm.</b>\n` +
        `Đơn hàng <code>${orderId}</code> đĂ£ được chuyển sang chế độ bảo mật để quản trị viên kiểm tra trực tiếp.`,
      { parse_mode: "HTML" }
    );

    await sendToAdminNotificationChat(
      `🚨 <b>CẢNH BÁO BẢO MẬT: BIÊN LAI TRÙNG LẶP / BẤT THƯỜNG</b>\n` +
        `• Mã đơn: <code>${orderId}</code>\n` +
        `. Telegram: <code>${telegramId}</code>\n` +
        `. Cảnh báo: <b>${result.flagReason}</b>\n` +
        `Admin vui lòng kiểm tra đối soát thủ công!`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔍 Kiểm tra đơn", `admin:order:detail:${orderId}`)
      }
    );
  } else if (result.status === "MANUAL_REVIEW") {
    await ctx.reply(
      `ℹ️ <b>ĐĂ£ nhận biên lai bổ sung cho đơn ${orderId}.</b>\n` +
        `Dơn hàng đĂ£ được ghi nhận đầy đủ bằng chứng và chuyển Admin kiểm duyệt thủ công.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `✅ <b>ĐĂ£ nhận được biên lai thanh toán cho đơn ${orderId}.</b>\n\n` +
        `dY"' Theo quy dịnh tài chính an toàn, Admin sẽ trực tiếp kiểm tra biến động tài khoản thực tế và xác nhận trong giây lát. Xin cảm ơn quý khách!`,
      { parse_mode: "HTML" }
    );

    // Phase A: after the bill is accepted, proactively collect the payout
    // account using the target currency already known from the Order.
    try {
      const billedOrder = await OrderService.getOrder(orderId);
      if (billedOrder && !billedOrder.payoutBankSnapshot) {
        await ctx.reply(
          `💸 <b>BƯỚC TIẾP THEO — TÀI KHOẢN NHẬN TIỀN</b>\n\n` +
            `Đơn <code>${orderId}</code> sẽ chi ra <b>${MoneyService.formatAmount(billedOrder.targetAmount, billedOrder.targetCurrency)} ${billedOrder.targetCurrency}</b>.\n` +
            `Anh/chị nhập tài khoản nhận tiền ngay để khi Admin giải ngân, tiền về tức thì:`,
          { parse_mode: "HTML", reply_markup: getBankWizardKeyboard(billedOrder.targetCurrency) }
        );
      }
    } catch (promptErr) {
      logger.warn({ err: promptErr, orderId }, "Failed to send payout-details prompt after bill");
    }

    await sendToAdminNotificationChat(
      `📸 <b>BIÊN LAI MỚI CHO DƠN ${orderId}</b>\n` +
        `Admin hãy kiểm tra tài khoản ngân hàng thực tế và xác nhận đơn.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔍 Duyệt tiền nạp", `admin:pay:step1:${orderId}`)
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
      `📋 Đơn ${order.id.slice(-6)} (${srcAmt} ${order.sourceCurrency})`,
      `customer:bill:attach:${order.id}:${fileId}`
    ).row();
  }

  await ctx.reply(
    `${t(locale, "bill.multi_title", { count: awaitingOrders.length })}\n\n` +
      t(locale, "bill.multi_hint"),
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

// Customer voice handler
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function downloadVoiceBuffer(ctx: BotContext): Promise<Buffer | null> {
  const voice = ctx.message?.voice;
  if (!voice) return null;
  const file = await ctx.api.getFile(voice.file_id);
  const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

/** HUMAN: original audio is primary; STT is assistive enrichment only. */
async function handleHumanVoice(ctx: BotContext, customer: { id: string; fullName?: string | null; username?: string | null }, locale: string): Promise<void> {
  const conv = await ConversationService.getOrCreateConversation(customer.id);

  if (conv.claimedById) {
    // Claimed: forward original audio to assigned staff (relay handles copy + ack).
    await relayCustomerMediaToStaff(ctx, customer, "voice");
  } else {
    // Unclaimed HUMAN: notify support group + copy original audio to the group.
    const messageId = ctx.message?.message_id;
    const fromChatId = ctx.chat?.id;
    const adminChatId = SystemConfigService.getAdminNotificationChatId();
    const name = customer.fullName || (customer.username ? "@" + customer.username : `#${customer.id.slice(-6)}`);
    if (messageId && fromChatId && adminChatId) {
      await copyMessageToChat(fromChatId, messageId, adminChatId);
    }
    await sendToAdminNotificationChat(
      `🎙 <b>Ghi âm từ khách ${escapeHtmlText(name)} · #${customer.id.slice(-6)}</b>`,
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

    const name = customer.fullName || (customer.username ? "@" + customer.username : `#${customer.id.slice(-6)}`);
    let assist = `🎙 <b>GHI ÂM TỪ KHÁCH</b>\n👤 <b>${escapeHtmlText(name)}</b> · 🆔 #${customer.id.slice(-6)}\n\n📝 Nội dung nhận diện:\n<i>"${escapeHtmlText(transcript.transcript)}"</i>`;
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










