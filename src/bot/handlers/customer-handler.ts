import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { CustomerService } from "../../modules/customer/customer-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { FileService } from "../../modules/files/file-service.js";
import { sendToStaff, sendToAdminNotificationChat } from "../notifications.js";
import { getCustomerMenuKeyboard, renderCustomerStartText } from "../menus/customer-menu.js";

// Pending quote states stored in-memory per customer
export const pendingCustomerQuotes = new Map<string, any>();

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

// /orders command
customerHandler.command("orders", async (ctx) => {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  const pendingOrders = await OrderService.getAllOrders(20);
  const myOrders = pendingOrders.filter((o: any) => o.customerId === customer.id);

  if (myOrders.length === 0) {
    return ctx.reply("📦 Bạn chưa có đơn hàng nào trong hệ thống.", {
      reply_markup: getCustomerMenuKeyboard()
    });
  }

  let msg = `📦 <b>DANH SÁCH ĐƠN HÀNG CỦA BẠN:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    msg +=
      `• Đơn <b>${o.id}</b>\n` +
      `  Đổi: <b>${o.sourceAmount} ${o.sourceCurrency}</b> ➔ <b>${o.targetAmount} ${o.targetCurrency}</b>\n` +
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

// /bank command
customerHandler.command("bank", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) {
    return ctx.reply(
      "Vui lòng nhập theo cú pháp: <code>/bank TIỀN_TỆ|Tên Ngân Hàng|Tên Chủ Tài Khoản|Số Tài Khoản</code>\n\n" +
        "Ví dụ: <code>/bank VND|MB Bank|NGUYEN VAN A|123456789</code>",
      { parse_mode: "HTML" }
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
  const pendingOrders = await OrderService.getAllOrders(20);
  const myOrders = pendingOrders.filter((o: any) => o.customerId === customer.id);

  if (myOrders.length === 0) {
    return ctx.reply("📦 Bạn chưa có đơn hàng nào trong hệ thống.");
  }

  let msg = `📦 <b>DANH SÁCH ĐƠN HÀNG GẦN ĐÂY:</b>\n\n`;
  for (const o of myOrders.slice(0, 5)) {
    msg +=
      `• Đơn <b>${o.id}</b>\n` +
      `  ${o.sourceAmount} ${o.sourceCurrency} ➔ ${o.targetAmount} ${o.targetCurrency}\n` +
      `  Trạng thái: <code>${o.status}</code>\n\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

customerHandler.callbackQuery("customer:menu:bank", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🏦 <b>THIẾT LẬP TÀI KHOẢN NGÂN HÀNG NHẬN TIỀN</b>\n\n` +
      `Vui lòng gửi lệnh cài đặt tài khoản theo cú pháp:\n` +
      `<code>/bank TIỀN_TỆ|Tên Ngân Hàng|Tên Chủ TK|Số TK</code>\n\n` +
      `<i>Ví dụ nhận VND:</i>\n` +
      `<code>/bank VND|Vietcombank|NGUYEN VAN A|1012345678</code>\n\n` +
      `<i>Ví dụ nhận USD (ABA):</i>\n` +
      `<code>/bank USD|ABA Bank|SOKHA PHAN|001234567</code>`,
    { parse_mode: "HTML" }
  );
});

customerHandler.callbackQuery("customer:menu:support", async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // Switch conversation mode to HUMAN
  await ConversationService.setMode(customer.id, "HUMAN");
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

  // Notify CSKH & Admin
  await sendToAdminNotificationChat(
    `🛎 <b>YÊU CẦU HỖ TRỢ TỪ KHÁCH HÀNG:</b>\n` +
      `• Khách: <b>${customer.fullName || customer.username || customer.telegramId}</b> (ID: <code>${customer.id}</code>)\n` +
      `• Telegram ID: <code>${customer.telegramId}</code>\n` +
      `CSKH vui lòng dùng lệnh <code>/claim ${customer.id}</code> để tiếp nhận.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🙋 Tiếp nhận hỗ trợ", `cskh:ticket:claim:${customer.id}`)
    }
  );
});

// Quote confirmation callback (supports customer:quote:confirm:* and confirm_quote:*)
customerHandler.callbackQuery(/^(?:customer:quote:confirm:|confirm_quote:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const quoteKey = ctx.match ? ctx.match[1] : undefined;
  if (!quoteKey) return;
  const quoteData = pendingCustomerQuotes.get(quoteKey);

  if (!quoteData) {
    return ctx.reply("⚠️ Báo giá này đã hết hạn hoặc không còn hiệu lực. Vui lòng tạo yêu cầu mới.");
  }

  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  try {
    const order = await OrderService.createOrderFromQuote(customer.id, quoteData);
    pendingCustomerQuotes.delete(quoteKey);

    const receivingSnapshot = order.receivingAccountSnapshot as any;

    let msg =
      `🎉 <b>ĐƠN HÀNG ĐÃ ĐƯỢC TẠO THÀNH CÔNG!</b>\n` +
      `Mã đơn: <code>${order.id}</code>\n\n` +
      `💵 Quý khách vui lòng chuyển đúng số tiền: <b>${quoteData.sourceAmount} ${quoteData.sourceCurrency}</b>\n` +
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

    // Notify admins of new pending order
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
    // In HUMAN mode, CSKH takes over; customer AI stops automatic replies
    logger.info({ customerId: customer.id }, "Conversation in HUMAN mode; AI reply paused");

    if (conv.claimedById) {
      await sendToStaff(
        conv.claimedById,
        `💬 <b>Tin nhắn mới từ khách [${customer.fullName || customer.id}]:</b>\n\n` +
          `"${text}"\n\n` +
          `<i>Dùng lệnh:</i> <code>/msg ${customer.id} &lt;Nội dung&gt;</code> để phản hồi khách.`,
        { parse_mode: "HTML" }
      );
    } else {
      await sendToAdminNotificationChat(
        `💬 <b>Khách [${customer.id}] vừa nhắn:</b> "${text}"\n` +
          `Chưa có CSKH nào tiếp nhận. Dùng <code>/claim ${customer.id}</code> để trả lời.`,
        { parse_mode: "HTML" }
      );
    }
    return;
  }

  // AUTO mode: Try parsing exchange intent
  const intent = await AiProvider.parseExchangeIntent(text);
  if (intent) {
    try {
      const quote = await QuoteService.calculateQuote(intent.sourceCurrency, intent.targetCurrency, intent.amount);
      const quoteKey = `${customer.id}_${Date.now()}`;
      pendingCustomerQuotes.set(quoteKey, quote);

      const keyboard = new InlineKeyboard().text("✅ Xác nhận đổi tiền", `customer:quote:confirm:${quoteKey}`);

      await ctx.reply(
        `📊 <b>BÁO GIÁ ĐỔI TIỀN TỆ</b>\n\n` +
          `• Quý khách gửi: <b>${quote.sourceAmount} ${quote.sourceCurrency}</b>\n` +
          `• Quý khách nhận: <b>${quote.targetAmount.toFixed(2)} ${quote.targetCurrency}</b>\n` +
          `• Tỷ giá áp dụng: <b>${quote.effectiveRate.toFixed(4)}</b>\n` +
          `• Phí dịch vụ: <b>${quote.fee} ${quote.feeCurrency}</b>\n` +
          `• Hiệu lực: <i>${env.QUOTE_EXPIRY_MINUTES} phút</i>\n\n` +
          `Bấm nút dưới đây để tạo đơn và nhận tài khoản chuyển tiền:`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } catch (err: any) {
      await ctx.reply(`⚠️ ${err.message}`);
    }
    return;
  }

  // Fallback friendly AI message
  await ctx.reply(
    `Xin chào! Quý khách có thể nhắn tin yêu cầu đổi tiền, ví dụ: <i>'đổi 500 USD sang VND'</i> hoặc nhấn <b>💬 Hỗ trợ</b> để gặp nhân viên tư vấn.`,
    { parse_mode: "HTML", reply_markup: getCustomerMenuKeyboard() }
  );
}

// Customer photo or document handler (bill upload)
export async function handleCustomerPhoto(ctx: BotContext) {
  const telegramId = String(ctx.from?.id || "");
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });

  // Look for latest active order for customer
  const customerOrder = await OrderService.getLatestActiveOrderForCustomer(customer.id);

  if (!customerOrder) {
    return ctx.reply("Không tìm thấy đơn hàng đang chờ thanh toán. Vui lòng tạo đơn trước khi gửi biên lai.");
  }

  try {
    let fileId: string | undefined;
    let fileName = `bill_${customerOrder.id}.jpg`;
    let mimeType = "image/jpeg";

    if (ctx.message?.photo && ctx.message.photo.length > 0) {
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      if (photo) fileId = photo.file_id;
    } else if (ctx.message?.document) {
      fileId = ctx.message.document.file_id;
      fileName = ctx.message.document.file_name || fileName;
      mimeType = ctx.message.document.mime_type || mimeType;
    }

    if (!fileId) return;

    const file = await ctx.api.getFile(fileId);
    const botToken = env.TELEGRAM_BOT_TOKEN;
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());

    const result: any = await OrderService.submitCustomerBill(
      customerOrder.id,
      buffer,
      fileName,
      mimeType,
      telegramId
    );

    if (result.status === "SUSPICIOUS") {
      await ctx.reply(
        `⚠️ <b>Hệ thống phát hiện biên lai có dấu hiệu cần kiểm tra thêm.</b>\n` +
          `Đơn hàng <code>${customerOrder.id}</code> đã được chuyển sang chế độ bảo mật để quản trị viên kiểm tra trực tiếp.`,
        { parse_mode: "HTML" }
      );

      await sendToAdminNotificationChat(
        `🚨 <b>CẢNH BÁO BẢO MẬT: BIÊN LAI TRÙNG LẶP / BẤT THƯỜNG</b>\n` +
          `• Mã đơn: <code>${customerOrder.id}</code>\n` +
          `• Khách hàng: <code>${customer.id}</code> (Telegram: <code>${customer.telegramId}</code>)\n` +
          `• Cảnh báo: <b>${result.flagReason}</b>\n` +
          `Admin vui lòng kiểm tra đối soát thủ công!`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔍 Kiểm tra đơn", `admin:order:detail:${customerOrder.id}`)
        }
      );
    } else if (result.status === "MANUAL_REVIEW") {
      await ctx.reply(
        `ℹ️ <b>Đã nhận biên lai bổ sung cho đơn ${customerOrder.id}.</b>\n` +
          `Đơn hàng đã được ghi nhận đầy đủ bằng chứng và chuyển Admin kiểm duyệt thủ công.`,
        { parse_mode: "HTML" }
      );

      await sendToAdminNotificationChat(
        `⚠️ <b>BIÊN LAI BỔ SUNG: ĐƠN ${customerOrder.id}</b>\n` +
          `• Khách hàng: <code>${customer.id}</code>\n` +
          `Đơn đã nạp thêm biên lai, chuyển trạng thái MANUAL_REVIEW.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔍 Duyệt tiền nạp", `admin:pay:step1:${customerOrder.id}`)
        }
      );
    } else {
      await ctx.reply(
        `✅ <b>Đã nhận được biên lai thanh toán cho đơn ${customerOrder.id}.</b>\n\n` +
          `🔒 Theo quy định tài chính an toàn, Admin sẽ trực tiếp kiểm tra biến động tài khoản thực tế và xác nhận trong giây lát. Xin cảm ơn quý khách!`,
        { parse_mode: "HTML" }
      );

      // Notify admins
      await sendToAdminNotificationChat(
        `📸 <b>BIÊN LAI MỚI CHO ĐƠN ${customerOrder.id}</b>\n` +
          `• Khách hàng: <code>${customer.id}</code>\n` +
          `• Cần nhận: <b>${customerOrder.sourceAmount} ${customerOrder.sourceCurrency}</b>\n` +
          `Admin hãy kiểm tra tài khoản ngân hàng thực tế và xác nhận đơn.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("🔍 Duyệt tiền nạp", `admin:pay:step1:${customerOrder.id}`)
        }
      );
    }
  } catch (err: any) {
    logger.error({ err }, "Error processing customer bill");
    await ctx.reply(`❌ Có lỗi khi nhận biên lai: ${err.message}`);
  }
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

    // Save evidence
    await FileService.saveEvidenceFile(buffer, `voice_${Date.now()}.ogg`, "VOICE", "audio/ogg");

    // Transcribe
    const transcribed = await AiProvider.transcribeAudio(buffer, "audio/ogg");
    if (transcribed) {
      await ctx.reply(`🎙 <i>Bạn vừa nói:</i> "${transcribed}"`, { parse_mode: "HTML" });
      await handleCustomerTextMessage(ctx, transcribed);
    } else {
      await ctx.reply("🎙 Đã lưu file ghi âm nhưng hiện tại chưa thể chuyển thành văn bản. Xin vui lòng nhắn tin trực tiếp.");
    }
  } catch (err: any) {
    logger.error({ err }, "Voice processing error");
    await ctx.reply("❌ Lỗi xử lý tin nhắn thoại");
  }
}
