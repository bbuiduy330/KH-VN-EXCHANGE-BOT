import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { prisma } from "../../database/client.js";
import { sendToCustomer } from "../notifications.js";
import { getCskhMenuKeyboard, renderCskhStartText } from "../menus/cskh-menu.js";

export const cskhHandler = new Composer<BotContext>();

export async function showCskhStart(ctx: BotContext) {
  const staff = ctx.identity?.staff;
  const staffName = staff?.name || "Nhân viên CSKH";
  const text = renderCskhStartText(staffName);
  const keyboard = getCskhMenuKeyboard();
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

// /tickets
cskhHandler.command("tickets", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const tickets = await ConversationService.getActiveTickets();
  if (tickets.length === 0) {
    return ctx.reply("📋 Hiện không có ticket nào đang ở chế độ HUMAN.", {
      reply_markup: getCskhMenuKeyboard()
    });
  }

  let msg = `📋 <b>DANH SÁCH TICKETS ĐANG HỖ TRỢ (${tickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();

  for (const t of tickets) {
    const isClaimedByMe = t.claimedById === String(ctx.from?.id);
    const status = isClaimedByMe ? "👉 Bạn đang nhận" : t.claimedById ? `Đã gán: ${t.claimedById}` : "Chưa gán";
    msg += `• Khách: <code>${t.customerId}</code> | ${status}\n`;

    if (!t.claimedById) {
      keyboard.text(`🙋 Nhận: ${t.customerId}`, `cskh:ticket:claim:${t.customerId}`).row();
    } else if (isClaimedByMe) {
      keyboard.text(`🤖 Trả về AI: ${t.customerId}`, `cskh:ticket:release:${t.customerId}`).row();
    }
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// /claim <customerId>
cskhHandler.command("claim", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("Cú pháp: <code>/claim &lt;ID_Khách&gt;</code>", { parse_mode: "HTML" });

  const staffTelegramId = String(ctx.from?.id || "");
  try {
    await ConversationService.claim(customerId, staffTelegramId, ctx.identity?.userType || "CSKH");
  } catch (err: any) {
    return ctx.reply(`⚠️ ${err.message}`);
  }

  // Notify customer without revealing staff's personal info
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `💬 <b>Bộ phận CSKH:</b>\nEm xin chào anh/chị, em đã tiếp nhận hỗ trợ ạ. Anh/chị cần hỗ trợ thông tin gì ạ?`
    );
  }

  await ctx.reply(
    `✅ Đã nhận hỗ trợ khách <code>${customerId}</code>.\n` +
      `• Chế độ chuyển sang: <b>HUMAN</b> (AI tạm dừng trả lời tự động).\n` +
      `• Dùng lệnh <code>/msg ${customerId} &lt;nội dung&gt;</code> để nhắn tin trực tiếp cho khách.`,
    { parse_mode: "HTML" }
  );
});

// /release <customerId>
cskhHandler.command("release", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("Cú pháp: <code>/release &lt;ID_Khách&gt;</code>", { parse_mode: "HTML" });

  const staffTelegramId = String(ctx.from?.id || "");
  try {
    await ConversationService.release(
      customerId,
      staffTelegramId,
      ctx.identity?.userType || "CSKH",
      ctx.identity?.staff?.permissions || []
    );
  } catch (err: any) {
    return ctx.reply(`❌ ${err.message}`);
  }

  // Notify customer
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `🤖 <b>Hệ thống:</b> Cuộc trò chuyện đã được chuyển về trợ lý AI tự động. Chúc quý khách một ngày tốt lành!`
    );
  }

  await ctx.reply(
    `✅ Đã giải phóng khách <code>${customerId}</code>.\n` +
      `• Chế độ trò chuyện chuyển về: <b>AUTO</b> (AI tự động tiếp quản).`,
    { parse_mode: "HTML" }
  );
});

// /msg <customerId> <content>
cskhHandler.command("msg", async (ctx) => {
  const allowed = await requirePermission(ctx, "customer.message");
  if (!allowed) return;

  const text = ctx.match?.trim();
  if (!text) return ctx.reply("Cú pháp: <code>/msg &lt;ID_Khách&gt; &lt;Nội dung gửi khách&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lòng nhập nội dung sau ID khách.");

  const customerId = text.substring(0, firstSpace).trim();
  const content = text.substring(firstSpace + 1).trim();
  const staffTelegramId = String(ctx.from?.id || "");

  // Check ownership
  const canSend = await ConversationService.canStaffMessage(
    customerId,
    staffTelegramId,
    ctx.identity?.userType || "CSKH",
    ctx.identity?.staff?.permissions || []
  );

  if (!canSend) {
    return ctx.reply("⛔ Bạn chỉ có thể gửi tin nhắn cho khách hàng mà bạn đã tiếp nhận (Claim). Dùng /claim trước nếu cần tiếp nhận.");
  }

  // Record outbound message in database as PENDING delivery
  const msgRecord = await ConversationService.createOutboundMessage({
    customerId,
    senderId: staffTelegramId,
    content,
    senderType: ctx.identity?.userType === "ADMIN" || ctx.identity?.userType === "SUPER_ADMIN" ? "ADMIN" : "CSKH"
  });

  // Forward to customer's private telegram chat
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    try {
      const sent = await sendToCustomer(customer.telegramId, `💬 <b>Bộ phận CSKH:</b>\n${content}`);
      if (sent) {
        await ConversationService.markMessageSent(msgRecord.id, Date.now());
        await ctx.reply(`✅ Đã gửi tin nhắn đến khách <code>${customerId}</code>.`, { parse_mode: "HTML" });
      } else {
        await ConversationService.markMessageFailed(msgRecord.id, "Telegram send returned false");
        await ctx.reply(`⚠️ Không thể chuyển tin nhắn tới Telegram khách (ID: <code>${customer.telegramId}</code>).`, {
          parse_mode: "HTML"
        });
      }
    } catch (sendErr: any) {
      await ConversationService.markMessageFailed(msgRecord.id, sendErr.message);
      await ctx.reply(`❌ Lỗi gửi tin nhắn Telegram: ${sendErr.message}`, { parse_mode: "HTML" });
    }
  } else {
    await ConversationService.markMessageFailed(msgRecord.id, "Customer not found");
    await ctx.reply(`❌ Không tìm thấy thông tin khách hàng <code>${customerId}</code>.`, { parse_mode: "HTML" });
  }
});

// /note <customerId> <content> (INTERNAL ONLY)
cskhHandler.command("note", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const text = ctx.match?.trim();
  if (!text) return ctx.reply("Cú pháp: <code>/note &lt;ID_Khách&gt; &lt;Nội dung ghi chú&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lòng nhập nội dung ghi chú sau ID khách.");

  const customerId = text.substring(0, firstSpace).trim();
  const noteContent = text.substring(firstSpace + 1).trim();
  const staffTelegramId = String(ctx.from?.id || "");

  // Save internal note. IMPORTANT: NEVER send to customer!
  await ConversationService.addInternalNote(customerId, staffTelegramId, noteContent);
  await ctx.reply(`📝 <b>Đã thêm ghi chú nội bộ cho khách <code>${customerId}</code>.</b>\n<i>(Ghi chú chỉ hiển thị trong nội bộ nhân viên).</i>`, {
    parse_mode: "HTML"
  });
});

// /history <customerId>
cskhHandler.command("history", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("Cú pháp: <code>/history &lt;ID_Khách&gt;</code>", { parse_mode: "HTML" });

  const history = await ConversationService.getHistory(customerId);
  let msg = `📜 <b>LỊCH SỬ TRAO ĐỔI VỚI KHÁCH: ${customerId}</b>\n` +
    `• Chế độ: <b>${history.mode}</b>\n` +
    `• Nhân viên nhận: <b>${history.claimedById || "Chưa gán"}</b>\n\n`;

  msg += `<b>Tin nhắn gần đây:</b>\n`;
  for (const m of history.messages.slice(-10)) {
    msg += `[${m.senderType}]: ${m.content}\n`;
  }

  if (history.notes.length > 0) {
    msg += `\n<b>Ghi chú nội bộ:</b>\n`;
    for (const n of history.notes.slice(-5)) {
      msg += `• (${n.authorId}): ${n.content}\n`;
    }
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
});

// /translate
cskhHandler.command("translate", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) return ctx.reply("Cú pháp: <code>/translate &lt;tiếng_anh|tiếng_khmer|tiếng_trung&gt; &lt;nội dung&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lòng nhập ngôn ngữ và nội dung cần dịch.");

  const targetLang = text.substring(0, firstSpace).trim();
  const sourceText = text.substring(firstSpace + 1).trim();

  const translated = await ConversationService.previewTranslation(sourceText, targetLang);
  await ctx.reply(
    `🌐 <b>XEM TRƯỚC BẢN DỊCH (${targetLang}):</b>\n\n` +
      `<i>Gốc:</i> ${sourceText}\n` +
      `<i>Dịch:</i> <b>${translated}</b>\n\n` +
      `Bạn có thể copy bản dịch trên để dùng trong /msg.`,
    { parse_mode: "HTML" }
  );
});

// Callbacks
cskhHandler.callbackQuery(/^cskh:ticket:claim:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const staffTelegramId = String(ctx.from?.id || "");

  try {
    await ConversationService.claim(customerId, staffTelegramId);
  } catch (err: any) {
    // Ticket already claimed by another staff or unavailable:
    // show a friendly status instead of an unhandled middleware error, and
    // disable the stale claim button when the original message is editable.
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text("✔️ Đã có nhân viên tiếp nhận", "cskh:noop")
      });
    } catch {
      // Stale/too-old message cannot be edited — safe to ignore.
    }
    await ctx.reply(
      `⚠️ Ticket này đã được nhân viên khác tiếp nhận trước đó.\n` +
        `Vui lòng chọn khách hàng khác trong menu Hỗ trợ.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text("✔️ Bạn đang hỗ trợ khách này", "cskh:noop")
    });
  } catch {
    // Stale/too-old message cannot be edited — safe to ignore.
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `💬 <b>Bộ phận CSKH:</b>\nEm xin chào anh/chị, em đã tiếp nhận hỗ trợ ạ. Anh/chị cần hỗ trợ thông tin gì ạ?`
    );
  }

  await ctx.reply(
    `✅ Đã tiếp nhận khách <code>${customerId}</code> (Chế độ HUMAN).\n` +
      `Dùng <code>/msg ${customerId} &lt;nội dung&gt;</code> để nhắn tin.`,
    { parse_mode: "HTML" }
  );
});

cskhHandler.callbackQuery(/^cskh:ticket:release:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const staffTelegramId = String(ctx.from?.id || "");

  try {
    await ConversationService.release(customerId, staffTelegramId);
  } catch (err: any) {
    // Not owner / already released: friendly status instead of unhandled error.
    try {
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard().text("🔄 Trả về AI không thành công", "cskh:noop")
      });
    } catch {
      // Stale/too-old message cannot be edited — safe to ignore.
    }
    await ctx.reply(`⚠️ ${err.message}`);
    return;
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `🤖 <b>Hệ thống:</b> Cuộc trò chuyện đã được chuyển về trợ lý AI tự động.`
    );
  }

  await ctx.reply(`✅ Đã hoàn tất hỗ trợ và chuyển khách <code>${customerId}</code> về AUTO AI.`, {
    parse_mode: "HTML"
  });
});

// No-op placeholder for disabled ticket buttons
cskhHandler.callbackQuery("cskh:noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

cskhHandler.callbackQuery("cskh:menu:tickets", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const tickets = await ConversationService.getActiveTickets();
  if (tickets.length === 0) {
    return ctx.reply("📋 Hiện không có ticket nào đang ở chế độ HUMAN.");
  }

  let msg = `📋 <b>DANH SÁCH KHÁCH CHỜ HỖ TRỢ (${tickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const t of tickets) {
    msg += `• Khách: <code>${t.customerId}</code> | Người nhận: ${t.claimedById || "Chưa nhận"}\n`;
    if (!t.claimedById) {
      keyboard.text(`🙋 Nhận ${t.customerId}`, `cskh:ticket:claim:${t.customerId}`).row();
    }
  }
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

cskhHandler.callbackQuery("cskh:menu:mytickets", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const staffTelegramId = String(ctx.from?.id || "");
  const allTickets = await ConversationService.getActiveTickets();
  const myTickets = allTickets.filter((t: any) => t.claimedById === staffTelegramId);

  if (myTickets.length === 0) {
    return ctx.reply("💬 Bạn hiện không tiếp nhận cuộc trò chuyện nào.");
  }

  let msg = `💬 <b>HỘI THOẠI BẠN ĐANG PHỤ TRÁCH (${myTickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const t of myTickets) {
    msg += `• Khách: <code>${t.customerId}</code>\n`;
    keyboard.text(`🤖 Trả về AI: ${t.customerId}`, `cskh:ticket:release:${t.customerId}`).row();
  }
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

cskhHandler.callbackQuery("cskh:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const orders = await OrderService.getAllOrders(10);
  let msg = `📦 <b>DANH SÁCH 10 ĐƠN HÀNG MỚI NHẤT:</b>\n\n`;
  for (const o of orders) {
    msg += `• <b>${o.id}</b>: ${o.sourceAmount} ${o.sourceCurrency} ➔ ${o.targetAmount} ${o.targetCurrency} [<code>${o.status}</code>]\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

cskhHandler.callbackQuery("cskh:menu:find_customer", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🔎 <b>TÌM KIẾM KHÁCH HÀNG:</b>\n` +
      `Vui lòng sử dụng lệnh xem lịch sử:\n` +
      `<code>/history &lt;ID_Khách&gt;</code>`,
    { parse_mode: "HTML" }
  );
});

cskhHandler.callbackQuery("cskh:menu:notes", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `📝 <b>GHI CHÚ NỘI BỘ:</b>\n` +
      `Thêm ghi chú bảo mật cho khách hàng bằng cú pháp:\n` +
      `<code>/note &lt;ID_Khách&gt; &lt;Nội dung ghi chú&gt;</code>\n\n` +
      `<i>Ghi chú chỉ lưu nội bộ, khách hàng không thể nhìn thấy.</i>`,
    { parse_mode: "HTML" }
  );
});

cskhHandler.callbackQuery("cskh:menu:release_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🤖 <b>TRẢ VỀ TRỢ LÝ AI:</b>\n` +
      `Để chuyển cuộc trò chuyện từ CSKH về cho AI tự động xử lý, dùng lệnh:\n` +
      `<code>/release &lt;ID_Khách&gt;</code>`,
    { parse_mode: "HTML" }
  );
});
