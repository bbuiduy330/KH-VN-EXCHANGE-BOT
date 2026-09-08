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
import { sendToStaff, sendToAdminNotificationChat } from "../notifications.js";
import { getCustomerMenuKeyboard, renderCustomerStartText } from "../menus/customer-menu.js";

export const customerHandler = new Composer<BotContext>();

// Helper to handle customer start
export async function showCustomerStart(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId,
    username: ctx.from?.username,
    fullName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ")
  });

  const text = renderCustomerStartText(customer.fullName || "Quý khách");
  const keyboard = getCustomerMenuKeyboard();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

// /help command
customerHandler.command("help", async (ctx) => {
  await ctx.reply(
    `📖 <b>HƯỚNG DẪN DỊCH VỤ ĐỔI TIỀN</b>\n\n` +
      `• Gửi tin nhắn ví dụ: <i>'đổi 1000 USD sang VND'</i> để nhận báo giá tức thời.\n` +
      `• Cài đặt ngân hàng nhận tiền: <code>/bank VND|MB Bank|TÊN CHỦ TK|SỐ TK</code>\n` +
      `• Xem đơn đã tạo: <code>/orders</code>\n` +
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
      `• Đơn <b>${o.id}</b>\n` +
      `  Đổi: <b>${srcAmt} ${o.sourceCurrency}</b> ➔ <b>${tgtAmt} ${o.targetCurrency}</b>\n` +
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
    await ctx.reply(`✅ Đã hủy đơn hàng <code>${activeOrder.id}</code> thành công.`, { parse_mode: "HTML" });
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
      .text("🇺🇸 USD", "customer:bank:wiz:USD")
      .text("🇰🇭 KHR", "customer:bank:wiz:KHR");

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
    `✅ <b>Đã lưu tài khoản nhận tiền ${currency.toUpperCase()}:</b>\n` +
      `• Ngân hàng: <b>${bankName}</b>\n` +
      `• Chủ tài khoản: <b>${accountName}</b>\n` +
      `• Số tài khoản: <code>${accountNumber}</code>`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
});

// Menu callbacks
customerHandler.callbackQuery("customer:menu:quote", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `💱 <b>ĐỔI TIỀN TỰ ĐỘNG</b>\n\n` +
      `Vui lòng nhắn tin số tiền bạn muốn đổi ngay tại đây.\n\n` +
      `<i>Ví dụ:</i>\n` +
      `• "đổi 500 USD sang VND"\n` +
      `• "1000 KHR to USD"\n` +
      `• Hoặc gửi tin nhắn thoại nói rõ nhu cầu của bạn.`,
    { parse_mode: "HTML" }
  );
});

customerHandler.callbackQuery("customer:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const myOrders = await OrderService.getOrdersForCustomer(customer.id, 10);

  if (myOrders.length === 0) {
    return ctx.reply("📦 Bạn chưa có đơn hàng nào trong hệ thống.");
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
    .text("🇺🇸 USD", "customer:bank:wiz:USD")
    .text("🇰🇭 KHR", "customer:bank:wiz:KHR");

  await ctx.reply(
    `🏦 <b>THIẾT LẬP TÀI KHOẢN NGÂN HÀNG NHẬN TIỀN</b>\n\n` +
      `Vui lòng chọn loại tiền tệ bạn muốn nhận:`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

customerHandler.callbackQuery(/^customer:bank:wiz:(VND|USD|KHR)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const currency = ctx.match ? ctx.match[1] : "VND";
  await ctx.reply(
    `🏦 <b>CÀI ĐẶT TÀI KHOẢN NHẬN ${currency}</b>\n\n` +
      `Vui lòng gửi tin nhắn theo định dạng:\n` +
      `<code>/bank ${currency}|Tên Ngân Hàng|Tên Chủ TK|Số TK</code>\n\n` +
      `<i>Ví dụ:</i>\n` +
      `<code>/bank ${currency}|Vietcombank|NGUYEN VAN A|0123456789</code>`,
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

  await ctx.reply(
    `💬 <b>YÊU CẦU HỖ TRỢ ĐÃ ĐƯỢC GỬI!</b>\n\n` +
      `Hệ thống đã kết nối bạn tới bộ phận Chăm Sóc Khách Hàng.\n` +
      `Nhân viên CSKH sẽ phản hồi bạn trực tiếp ngay tại khung chat này trong giây lát.`,
    { parse_mode: "HTML" }
  );

  await sendToAdminNotificationChat(
    `🛎 <b>YÊU CẦU HỖ TRỢ TỪ KHÁCH HÀNG:</b>\n` +
      `• Khách: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
      `• Telegram ID: <code>${customer.telegramId}</code>\n` +
      `CSKH vui lòng bấm nút bên dưới để tiếp nhận.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🙋 Tiếp nhận hỗ trợ", `cskh:ticket:claim:${customer.id}`)
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
    const formattedSrc = MoneyService.formatAmount(confirmedQuote.sourceAmount, confirmedQuote.sourceCurrency);

    let msg =
      `🎉 <b>ĐƠN HÀNG ĐÃ ĐƯỢC TẠO THÀNH CÔNG!</b>\n` +
      `Mã đơn: <code>${order.id}</code>\n\n` +
      `💵 Quý khách vui lòng chuyển đúng số tiền: <b>${formattedSrc} ${confirmedQuote.sourceCurrency}</b>\n` +
      `🏦 Đến tài khoản chỉ định:\n` +
      `• Ngân hàng: <b>${receivingSnapshot?.bankName}</b>\n` +
      `• Số tài khoản: <code>${receivingSnapshot?.accountNumber}</code>\n` +
      `• Tên tài khoản: <b>${receivingSnapshot?.accountName}</b>\n` +
      `• Nội dung chuyển tiền: <code>${order.id}</code>\n\n` +
      `📸 <i>Sau khi chuyển tiền, quý khách chỉ cần chụp và gửi ảnh biên lai (bill) vào đây.</i>`;

    await ctx.reply(msg, { parse_mode: "HTML" });

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
      `🆕 <b>ĐƠN HÀNG MỚI ĐƯỢC TẠO:</b> <code>${order.id}</code>\n` +
        `• Khách: <code>${customer.id}</code>\n` +
        `• Đổi: <b>${order.sourceAmount} ${order.sourceCurrency}</b> ➔ <b>${order.targetAmount} ${order.targetCurrency}</b>\n` +
        `• Trạng thái: <code>WAITING_PAYMENT</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
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
        `💬 <b>Tin nhắn mới từ khách [${customer.fullName || customer.id}]:</b>\n\n` +
          `"${text}"\n\n` +
          `Dùng <code>/msg ${customer.id} &lt;nội dung&gt;</code> để trả lời.`,
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

  // 1. Check exchange intent
  const intent = await AiProvider.parseExchangeIntent(text);
  if (intent) {
    try {
      // Persist Quote in DB
      const quote = await QuoteService.createQuote(
        customer.id,
        intent.sourceCurrency,
        intent.targetCurrency,
        intent.amount
      );

      const keyboard = new InlineKeyboard().text("✅ Xác nhận đổi tiền", `customer:quote:confirm:${quote.id}`);
      const expiryMinutes = RuntimeConfigService.getQuoteExpiryMinutes();
      const formattedSrc = MoneyService.formatAmount(quote.sourceAmount, quote.sourceCurrency);
      const formattedTgt = MoneyService.formatAmount(quote.targetAmount, quote.targetCurrency);

      await ctx.reply(
        `📊 <b>BÁO GIÁ ĐỔI TIỀN TỆ</b>\n\n` +
          `• Quý khách gửi: <b>${formattedSrc} ${quote.sourceCurrency}</b>\n` +
          `• Quý khách nhận: <b>${formattedTgt} ${quote.targetCurrency}</b>\n` +
          `• Tỷ giá áp dụng: <b>${Number(quote.effectiveRate).toFixed(4)}</b>\n` +
          `• Phí dịch vụ: <b>${quote.fee} ${quote.feeCurrency}</b>\n` +
          `• Hiệu lực: <i>${expiryMinutes} phút</i>\n\n` +
          `Bấm nút dưới đây để tạo đơn và nhận tài khoản chuyển tiền:`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
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
    `Xin chào! Quý khách có thể nhắn tin yêu cầu đổi tiền, ví dụ: <i>'đổi 500 USD sang VND'</i> hoặc nhấn <b>💬 Hỗ trợ</b> để gặp nhân viên tư vấn.`,
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
        `Đơn hàng <code>${orderId}</code> đã được chuyển sang chế độ bảo mật để quản trị viên kiểm tra trực tiếp.`,
      { parse_mode: "HTML" }
    );

    await sendToAdminNotificationChat(
      `🚨 <b>CẢNH BÁO BẢO MẬT: BIÊN LAI TRÙNG LẶP / BẤT THƯỜNG</b>\n` +
        `• Mã đơn: <code>${orderId}</code>\n` +
        `• Telegram: <code>${telegramId}</code>\n` +
        `• Cảnh báo: <b>${result.flagReason}</b>\n` +
        `Admin vui lòng kiểm tra đối soát thủ công!`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔍 Kiểm tra đơn", `admin:order:detail:${orderId}`)
      }
    );
  } else if (result.status === "MANUAL_REVIEW") {
    await ctx.reply(
      `ℹ️ <b>Đã nhận biên lai bổ sung cho đơn ${orderId}.</b>\n` +
        `Đơn hàng đã được ghi nhận đầy đủ bằng chứng và chuyển Admin kiểm duyệt thủ công.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `✅ <b>Đã nhận được biên lai thanh toán cho đơn ${orderId}.</b>\n\n` +
        `🔒 Theo quy định tài chính an toàn, Admin sẽ trực tiếp kiểm tra biến động tài khoản thực tế và xác nhận trong giây lát. Xin cảm ơn quý khách!`,
      { parse_mode: "HTML" }
    );

    await sendToAdminNotificationChat(
      `📸 <b>BIÊN LAI MỚI CHO ĐƠN ${orderId}</b>\n` +
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

  // Safe Bill Target Selection: Query orders waiting for bill
  const awaitingOrders = await OrderService.getOrdersAwaitingBill(customer.id);

  if (awaitingOrders.length === 0) {
    return ctx.reply(
      "Không tìm thấy đơn hàng nào của bạn đang chờ thanh toán (WAITING_PAYMENT). Vui lòng tạo đơn trước khi gửi biên lai."
    );
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
      await ctx.reply(`❌ Có lỗi khi xử lý biên lai: ${err.message}`);
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
    `📸 <b>BẠN CÓ ${awaitingOrders.length} ĐƠN HÀNG ĐANG CHỜ THANH TOÁN</b>\n\n` +
      `Vui lòng chọn chính xác đơn hàng áp dụng biên lai này:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

// Customer voice handler
export async function handleCustomerVoice(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

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
      await ctx.reply(`🎙 [${langTag}] <i>"${transcribeResult.transcript}"</i>`, { parse_mode: "HTML" });
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
      await ctx.reply(
        "🎙 Đã lưu file ghi âm nhưng hiện tại chưa thể chuyển thành văn bản. Xin vui lòng nhắn tin trực tiếp."
      );
    }
  } catch (err: any) {
    logger.error({ err }, "Voice processing error");
    await ctx.reply("❌ Lỗi xử lý tin nhắn thoại");
  }
}
