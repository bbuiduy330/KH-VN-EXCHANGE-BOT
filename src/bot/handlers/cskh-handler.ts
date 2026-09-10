import { Composer, InlineKeyboard } from "grammy";
import type { Customer } from "@prisma/client";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { PermissionService } from "../../modules/permissions/permission-service.js";
import { prisma } from "../../database/client.js";
import { sendToCustomer, copyMessageToCustomer } from "../notifications.js";
import { resolveLocale, t } from "../../modules/i18n/locales.js";
import { getCskhMenuKeyboard, renderCskhStartText } from "../menus/cskh-menu.js";
import { clearSelectedCustomer, getSelectedCustomer, setSelectedCustomer } from "../state/staff-chat-session.js";
import {
  ConversationWithCustomer,
  activeRowText,
  getCskhHomeKeyboard,
  getCustomerDetailKeyboard,
  getHistoryKeyboard,
  getReplyModeKeyboard,
  orderContextText,
  paginate,
  paginationKeyboard,
  quoteNeedText,
  renderCskhHomeText,
  renderCustomerDetailText,
  renderHistoryText,
  renderReplyModeText,
  shortCustomerLabel,
  staffDisplayName,
  waitingRowText
} from "../menus/cskh-panel.js";

export const cskhHandler = new Composer<BotContext>();

export async function showCskhStart(ctx: BotContext) {
  clearSelectedCustomer(String(ctx.from?.id || ""));
  const staff = ctx.identity?.staff;
  const staffName = staff?.name || "Nhân viên CSKH";
  const text = renderCskhHomeText(staffName);
  // Cheap counts for the home badges (single indexed query each).
  const [waiting, active] = await Promise.all([
    prisma.conversation.count({ where: { mode: "HUMAN", claimedById: null } }),
    prisma.conversation.count({ where: { mode: "HUMAN", claimedById: { not: null } } })
  ]);
  const keyboard = getCskhHomeKeyboard({ waiting, active });
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
    const status = isClaimedByMe ? "👉 Bạn đang nhận" : t.claimedById ? `ĐĂ£ gán: ${t.claimedById}` : "Chưa gán";
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
    await sendToCustomer(customer.telegramId, t(resolveLocale(customer.language), "support.active_title"));
  }

  await ctx.reply(
    `✅ Đã tiếp nhận khách <code>${customerId}</code> (Chế độ HUMAN).\n` +
      `Dùng <code>/msg ${customerId} &lt;nội dung&gt;</code> để nhắn tin.`,
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
    await sendToCustomer(customer.telegramId, t(resolveLocale(customer.language), "support.exited"));
  }

  await ctx.reply(
    `✅ ĐĂ£ giải phóng khách <code>${customerId}</code>.\n` +
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
    return ctx.reply("⛔ Bạn chỉ có thể gửi tin nhắn cho khách hàng mà bạn đĂ£ tiếp nhận (Claim). Dùng /claim trước nếu cần tiếp nhận.");
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
        await ctx.reply(`✅ ĐĂ£ gửi tin nhắn đến khách <code>${customerId}</code>.`, { parse_mode: "HTML" });
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


/**
 * C3 — single delivery path for staff text -> selected/claimed customer.
 * Mirrors the /msg flow using the SAME ConversationService primitives so
 * history/persistence stay consistent.
 */
async function deliverStaffText(ctx: BotContext, customerId: string, content: string): Promise<void> {
  const staffTelegramId = String(ctx.from?.id || "");

  const canSend = await ConversationService.canStaffMessage(
    customerId,
    staffTelegramId,
    ctx.identity?.userType || "CSKH",
    ctx.identity?.staff?.permissions || []
  );
  if (!canSend) {
    await ctx.reply("⛔ Bạn chỉ có thể gửi tin nhắn cho khách hàng mà bạn đã tiếp nhận (Claim).");
    return;
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply(`❌ Không tìm thấy thông tin khách hàng <code>${customerId}</code>.`, { parse_mode: "HTML" });
    return;
  }

  const msgRecord = await ConversationService.createOutboundMessage({
    customerId,
    senderId: staffTelegramId,
    content,
    senderType: ctx.identity?.userType === "ADMIN" || ctx.identity?.userType === "SUPER_ADMIN" ? "ADMIN" : "CSKH"
  });

  try {
    const sent = await sendToCustomer(customer.telegramId, `💬 <b>Bộ phận CSKH:</b>\n${content}`);
    if (sent) {
      await ConversationService.markMessageSent(msgRecord.id, Date.now());
      await ctx.reply(`✅ Đã gửi đến <b>${shortCustomerLabel(customer)}</b>.`, { parse_mode: "HTML" });
    } else {
      await ConversationService.markMessageFailed(msgRecord.id, "Telegram send returned false");
      await ctx.reply(`⚠️ Không gửi được tới khách (Telegram).`, { parse_mode: "HTML" });
    }
  } catch (sendErr: any) {
    await ConversationService.markMessageFailed(msgRecord.id, sendErr?.message || "send failed");
    await ctx.reply(`❌ Lỗi gửi tin nhắn: ${sendErr?.message || "unknown"}`, { parse_mode: "HTML" });
  }
}

/**
 * C3 — bare staff text. Delivers ONLY to the per-staff selected customer.
 * Never guesses a recipient when no session is active.
 */
export async function handleStaffTextMessage(ctx: BotContext, text: string): Promise<void> {
  const staffTelegramId = String(ctx.from?.id || "");
  const customerId = getSelectedCustomer(staffTelegramId);

  if (!customerId) {
    await ctx.reply(
      `⚠️ <b>Bạn chưa chọn khách để trả lời.</b>\n` +
        `Hãy vào <b>💬 Đang hỗ trợ</b> → chọn khách → <b>💬 Trả lời khách</b>.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const conv = await prisma.conversation.findUnique({ where: { customerId } });
  if (!conv || conv.mode !== "HUMAN" || conv.claimedById !== staffTelegramId) {
    clearSelectedCustomer(staffTelegramId);
    await ctx.reply("⚠️ Khách đã được trả về AI hoặc nhân viên khác. Bạn đã thoát trả lời.");
    return;
  }

  await deliverStaffText(ctx, customerId, text);
}

/** 💬 Enter reply mode for a claimed-by-me customer. */
cskhHandler.callbackQuery(/^cskh:reply:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "customer.message");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const staffTelegramId = String(ctx.from?.id || "");
  const conv = (await prisma.conversation.findUnique({
    where: { customerId },
    include: { customer: true }
  })) as unknown as ConversationWithCustomer | null;

  if (!conv || conv.mode !== "HUMAN" || conv.claimedById !== staffTelegramId) {
    await ctx.reply("⚠️ Bạn chưa tiếp nhận khách này (Claim).");
    return;
  }

  setSelectedCustomer(staffTelegramId, customerId);
  const contextMap = await loadCustomerContext([conv]);
  const context = contextMap.get(customerId) || {};
  const text = renderReplyModeText(conv, context);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: getReplyModeKeyboard(customerId) });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: getReplyModeKeyboard(customerId) });
  }
});

/** ↩️ Exit reply mode (clear selected session). */
cskhHandler.callbackQuery("cskh:exit_reply", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearSelectedCustomer(String(ctx.from?.id || ""));
  await ctx.reply("✅ Đã thoát trả lời. Tin nhắn tiếp theo sẽ không gửi đến khách.", { parse_mode: "HTML" });
  await showCskhStart(ctx);
});

/** 🔄 Switch: clear session, return to own active customers. */
cskhHandler.callbackQuery("cskh:reply_switch", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearSelectedCustomer(String(ctx.from?.id || ""));

  const staffTelegramId = String(ctx.from?.id || "");
  const allTickets: { customerId: string; claimedById: string | null }[] = await ConversationService.getActiveTickets();
  const myTickets = allTickets.filter((t) => t.claimedById === staffTelegramId);
  if (myTickets.length === 0) {
    await ctx.reply("💬 Bạn hiện không phụ trách cuộc hỗ trợ nào.");
    return;
  }

  const customerIds: string[] = myTickets.map((t) => t.customerId);
  const customers: Customer[] = await prisma.customer.findMany({ where: { id: { in: customerIds } } });
  const byId = new Map(customers.map((c) => [c.id, c]));

  const kb = new InlineKeyboard();
  for (const t of myTickets) {
    const cust = byId.get(t.customerId);
    const label = cust ? shortCustomerLabel(cust) : `#${t.customerId.slice(-6)}`;
    kb.text(label, `cskh:preview:${t.customerId}`).row();
  }
  kb.text("🏠 Menu CSKH", "cskh:home");
  await ctx.reply(`💬 <b>Chọn khách để trả lời (${myTickets.length}):</b>`, { parse_mode: "HTML", reply_markup: kb });
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

  msg += `<b>Tin nhắn gần đĂ¢y:</b>\n`;
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

// /find <query> — stateless customer search (username / name / telegram id / short id)
cskhHandler.command("find", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const query = ctx.match?.trim();
  if (!query) return ctx.reply("Cú pháp: <code>/find &lt;tên|@username|ID&gt;</code>", { parse_mode: "HTML" });

  const matches = await prisma.customer.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { fullName: { contains: query, mode: "insensitive" } },
        { telegramId: { contains: query } },
        { id: { contains: query } }
      ]
    },
    take: 8,
    orderBy: { updatedAt: "desc" }
  });

  if (matches.length === 0) {
    return ctx.reply(`🔎 Không tìm thấy khách nào khớp với <b>${query}</b>.`, { parse_mode: "HTML" });
  }

  const kb = new InlineKeyboard();
  for (const c of matches) {
    kb.text(shortCustomerLabel(c), `cskh:preview:${c.id}`).row();
  }
  kb.text("🏠 Menu CSKH", "cskh:home");
  await ctx.reply(`🔎 <b>Kết quả tìm kiếm (${matches.length}):</b>`, { parse_mode: "HTML", reply_markup: kb });
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
        reply_markup: new InlineKeyboard().text("✔️ ĐĂ£ có nhân viên tiếp nhận", "cskh:noop")
      });
    } catch {
      // Stale/too-old message cannot be edited - safe to ignore.
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
    await sendToCustomer(customer.telegramId, t(resolveLocale(customer.language), "support.active_title"));
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
    await sendToCustomer(customer.telegramId, t(resolveLocale(customer.language), "support.exited"));
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

// ===== C1: CSKH control panel callbacks =====

/** Attach cheap per-customer context (latest pending quote, active order). */
async function loadCustomerContext(
  convs: { customerId: string }[]
): Promise<Map<string, { need?: string; order?: string }>> {
  const map = new Map<string, { need?: string; order?: string }>();
  await Promise.all(
    convs.map(async (conv) => {
      try {
        const [quote, order] = await Promise.all([
          prisma.quote.findFirst({
            where: { customerId: conv.customerId, status: "PENDING", expiresAt: { gt: new Date() } },
            orderBy: { createdAt: "desc" }
          }),
          prisma.order.findFirst({
            where: {
              customerId: conv.customerId,
              status: { in: ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "PAYMENT_CONFIRMED", "WAITING_PAYOUT", "MANUAL_REVIEW", "SUSPICIOUS"] }
            },
            orderBy: { createdAt: "desc" }
          })
        ]);
        map.set(conv.customerId, {
          need: quote ? quoteNeedText(quote) : undefined,
          order: order ? orderContextText(order) : undefined
        });
      } catch {
        map.set(conv.customerId, {});
      }
    })
  );
  return map;
}

cskhHandler.callbackQuery("cskh:home", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearSelectedCustomer(String(ctx.from?.id || ""));
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const staffName = ctx.identity?.staff?.name || "Nhân viên CSKH";
  const [waiting, active] = await Promise.all([
    prisma.conversation.count({ where: { mode: "HUMAN", claimedById: null } }),
    prisma.conversation.count({ where: { mode: "HUMAN", claimedById: { not: null } } })
  ]);
  const text = renderCskhHomeText(staffName);
  const keyboard = getCskhHomeKeyboard({ waiting, active });
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

/** 🔔 Waiting list: HUMAN + unclaimed, paginated (oldest wait first). */
cskhHandler.callbackQuery(/^cskh:waiting:(?::?page:)?(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const page = Number(ctx.match?.[1] || "1");
  const convs = (await prisma.conversation.findMany({
    where: { mode: "HUMAN", claimedById: null },
    include: { customer: true },
    orderBy: { updatedAt: "asc" }
  })) as unknown as ConversationWithCustomer[];

  const { pageItems, totalPages } = paginate(convs, page);
  const contextMap = await loadCustomerContext(pageItems);

  const kb = new InlineKeyboard();
  if (convs.length === 0) {
    kb.text("🏠 Menu CSKH", "cskh:home");
    await ctx.reply(`🔔 Hiện không có khách nào đang chờ hỗ trợ.`, { reply_markup: kb });
    return;
  }

  for (const conv of pageItems) {
    const waitedMinutes = Math.floor((Date.now() - new Date(conv.updatedAt).getTime()) / 60000);
    kb.text(waitingRowText(conv, contextMap.get(conv.customerId)?.need, waitedMinutes), `cskh:preview:${conv.customerId}`).row();
  }
  const footer = paginationKeyboard("cskh:waiting", page, totalPages);
  for (const row of footer.inline_keyboard) {
    kb.row();
    const last = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    for (const btn of row) last?.push(btn);
  }

  const text = `🔔 <b>Khách đang chờ (${convs.length})</b> — trang ${page}/${totalPages}`;
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
});

/** 💬 Active list: HUMAN + claimed, paginated (newest first). */
cskhHandler.callbackQuery(/^cskh:active:(?::?page:)?(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const page = Number(ctx.match?.[1] || "1");
  const me = String(ctx.from?.id || "");
  const convs = (await prisma.conversation.findMany({
    where: { mode: "HUMAN", claimedById: { not: null } },
    include: { customer: true },
    orderBy: { updatedAt: "desc" }
  })) as unknown as ConversationWithCustomer[];

  const { pageItems, totalPages } = paginate(convs, page);
  const contextMap = await loadCustomerContext(pageItems);

  const kb = new InlineKeyboard();
  if (convs.length === 0) {
    kb.text("🏠 Menu CSKH", "cskh:home");
    await ctx.reply(`💬 Hiện không có cuộc hỗ trợ nào đang hoạt động.`, { reply_markup: kb });
    return;
  }

  const lines: string[] = [];
  for (const conv of pageItems) {
    lines.push(activeRowText(conv, { isMine: conv.claimedById === me, need: contextMap.get(conv.customerId)?.need }));
    kb.text(shortCustomerLabel(conv.customer), `cskh:preview:${conv.customerId}`).row();
  }
  const footer = paginationKeyboard("cskh:active", page, totalPages);
  kb.row();
  const last = kb.inline_keyboard[kb.inline_keyboard.length - 1];
  for (const btn of footer.inline_keyboard[0] || []) last?.push(btn);

  const text = `💬 <b>Đang hỗ trợ (${convs.length})</b> — trang ${page}/${totalPages}\n\n${lines.join("\n")}`;
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
});

/** 👤 Customer preview (basic; reply-mode belongs to C2/C3). */
cskhHandler.callbackQuery(/^cskh:preview:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const conv = (await prisma.conversation.findUnique({
    where: { customerId },
    include: { customer: true }
  })) as unknown as ConversationWithCustomer | null;
  if (!conv) {
    await ctx.reply("❌ Không tìm thấy khách này.");
    return;
  }

  const me = String(ctx.from?.id || "");
  const contextMap = await loadCustomerContext([conv]);
  const context = contextMap.get(customerId) || {};

  // Resolve assigned staff display name/role when possible (fallback keeps id safe).
  let owner = "Chưa phân công";
  if (conv.claimedById) {
    const ownerStaff = await PermissionService.getStaffUser(conv.claimedById);
    owner = staffDisplayName(ownerStaff, conv.claimedById);
  }

  const text = renderCustomerDetailText(conv, {
    owner,
    need: context.need,
    order: context.order,
    lastSeen: conv.updatedAt ? new Date(conv.updatedAt).toLocaleString("vi-VN") : undefined
  });
  const keyboard = getCustomerDetailKeyboard(conv, { isMine: conv.claimedById === me });
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

/** 🕘 Paginated recent history (newest first). */
cskhHandler.callbackQuery(/^cskh:history:([a-zA-Z0-9_-]+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  const page = Number(ctx.match?.[2] || "1");
  if (!customerId) return;

  const conv = await prisma.conversation.findUnique({ where: { customerId }, include: { customer: true } });
  if (!conv) {
    await ctx.reply("❌ Không tìm thấy khách này.");
    return;
  }

  const pageSize = 8;
  const total = await prisma.message.count({ where: { conversationId: conv.id } });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * pageSize,
    take: pageSize
  });

  const text = renderHistoryText(shortCustomerLabel(conv.customer), messages, safePage, totalPages);
  const keyboard = getHistoryKeyboard(customerId, safePage, totalPages);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
});

/** 📦 Read-only current order. */
cskhHandler.callbackQuery(/^cskh:order:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const order = await OrderService.getLatestActiveOrderForCustomer(customerId);
  const kb = new InlineKeyboard().text("⬅️ Quay lại", `cskh:preview:${customerId}`).text("🏠 Menu CSKH", "cskh:home");
  if (!order) {
    const text = `📦 <b>Đơn hàng</b>\n\nHiện không có đơn hàng nào đang xử lý cho khách này.`;
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
    return;
  }

  const src = `${Number(order.sourceAmount)} ${order.sourceCurrency}`;
  const tgt = `${Number(order.targetAmount)} ${order.targetCurrency}`;
  const text =
    `📦 <b>Đơn hàng</b> <code>${order.id.slice(-6)}</code>\n\n` +
    `• Trạng thái: <code>${order.status}</code>\n` +
    `• Đổi: <b>${src}</b> ➔ <b>${tgt}</b>\n` +
    `• Tỷ giá: <b>${Number(order.rate)}</b> · Phí: <b>${Number(order.fee)} ${order.feeCurrency}</b>\n` +
    `• Tạo lúc: ${new Date(order.createdAt).toLocaleString("vi-VN")}`;
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
});

/** 📊 Read-only current quote. */
cskhHandler.callbackQuery(/^cskh:quote:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const customerId = ctx.match?.[1];
  if (!customerId) return;

  const quote = await QuoteService.getLatestActiveQuote(customerId);
  const kb = new InlineKeyboard().text("⬅️ Quay lại", `cskh:preview:${customerId}`).text("🏠 Menu CSKH", "cskh:home");
  if (!quote) {
    const text = `📊 <b>Báo giá</b>\n\nHiện không có báo giá còn hiệu lực cho khách này.`;
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
    return;
  }

  const text =
    `📊 <b>Báo giá</b> <code>${quote.id.slice(-6)}</code>\n\n` +
    `• Gửi: <b>${Number(quote.sourceAmount)} ${quote.sourceCurrency}</b>\n` +
    `• Nhận: <b>${Number(quote.targetAmount)} ${quote.targetCurrency}</b>\n` +
    `• Tỷ giá: <b>${Number(quote.effectiveRate)}</b>\n` +
    `• Phí: <b>${Number(quote.fee)} ${quote.feeCurrency}</b>\n` +
    `• Hết hạn: ${new Date(quote.expiresAt).toLocaleString("vi-VN")}`;
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
});


/** ❓ Contextual CSKH help (short; no giant command manual). */
cskhHandler.callbackQuery("cskh:menu:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const text =
    `❓ <b>HƯỚNG DẪN CSKH</b>\n\n` +
    `• 🔔 <b>Khách đang chờ</b>: khách cần hỗ trợ trực tiếp, chưa ai nhận.\n` +
    `• 💬 <b>Đang hỗ trợ</b>: các cuộc hỗ trợ đang chạy và người phụ trách.\n` +
    `• Bấm vào một khách để xem thông tin và ✅ <b>Nhận khách</b>.\n` +
    `• Sau khi nhận: <code>/msg &lt;ID_Khách&gt; &lt;nội dung&gt;</code> để trả lời (media ghi caption tương tự).\n` +
    `• Hoàn tất: <code>/release &lt;ID_Khách&gt;</code> trả khách về AI tự động.\n\n` +
    `<i>Nút bấm chỉ là giao diện — mọi hành động đều được kiểm tra quyền phía server.</i>`;
  const kb = new InlineKeyboard().text("🏠 Menu CSKH", "cskh:home");
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
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
    msg += `. <b>${o.id}</b>: ${o.sourceAmount} ${o.sourceCurrency} ➔ ${o.targetAmount} ${o.targetCurrency} [<code>${o.status}</code>]\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

cskhHandler.callbackQuery("cskh:menu:find_customer", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  // Stateless search: recent customers as selectable buttons + /find hint.
  const recent = await prisma.customer.findMany({
    orderBy: { updatedAt: "desc" },
    take: 8
  });

  const kb = new InlineKeyboard();
  for (const c of recent) {
    kb.text(shortCustomerLabel(c), `cskh:preview:${c.id}`).row();
  }
  kb.row().text("🏠 Menu CSKH", "cskh:home");

  const text =
    `🔎 <b>TÌM KHÁCH</b>\n\n` +
    `Nhập <code>/find &lt;tên | @username | ID&gt;</code> để tìm kiếm.\n` +
    `Hoặc chọn một khách gần đây bên dưới:`;

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
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

/**
 * Staff media handler (photo/voice/document).
 *
 * SAFE path only: caption must include explicit `/msg <customerId>`
 * (same authorization as text /msg via canStaffMessage).
 * Bare media without an explicit customer id is NOT inferred — deferred to Phase C.
 * Staff media must NEVER fall through to customer bill handling (router enforces this).
 */
export async function handleStaffMedia(ctx: BotContext): Promise<void> {
  const caption = (ctx.message?.caption || "").trim();
  const staffTelegramId = String(ctx.from?.id || "");

  // Resolve target: explicit /msg <id> caption, else per-staff selected chat (C3).
  const match = caption.match(/^\/msg\s+(\S+)(?:\s+(.*))?$/i);
  let customerId: string | undefined;
  let note = "";
  if (match) {
    customerId = match[1];
    note = (match[2] || "").trim();
  } else {
    customerId = getSelectedCustomer(staffTelegramId);
    note = caption;
  }

  if (!customerId) {
    await ctx.reply(
      `📎 <b>GỬI MEDIA CHO KHÁCH</b>\n\n` +
        `• Đang trả lời một khách? Bấm <b>💬 Trả lời khách</b> trước, rồi gửi ảnh/voice/file trực tiếp.\n` +
        `• Hoặc ghi caption: <code>/msg &lt;ID_Khách&gt; [ghi chú tùy chọn]</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const canSend = await ConversationService.canStaffMessage(
    customerId,
    staffTelegramId,
    ctx.identity?.userType || "CSKH",
    ctx.identity?.staff?.permissions || []
  );

  if (!canSend) {
    await ctx.reply(
      "⛔ Bạn chỉ có thể gửi media cho khách hàng mà bạn đã tiếp nhận (Claim). Dùng /claim trước nếu cần."
    );
    return;
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) {
    await ctx.reply(`❌ Không tìm thấy khách <code>${customerId}</code>.`, { parse_mode: "HTML" });
    return;
  }

  const messageId = ctx.message?.message_id;
  const fromChatId = ctx.chat?.id;
  if (!messageId || !fromChatId) {
    await ctx.reply("❌ Không đọc được media message.");
    return;
  }

  // Record outbound stub (text note only; media is copied natively).
  const msgRecord = await ConversationService.createOutboundMessage({
    customerId,
    senderId: staffTelegramId,
    content: note ? `[media] ${note}` : "[media]",
    senderType:
      ctx.identity?.userType === "ADMIN" || ctx.identity?.userType === "SUPER_ADMIN" ? "ADMIN" : "CSKH"
  });

  try {
    if (note) {
      await sendToCustomer(customer.telegramId, `💬 <b>Bộ phận CSKH:</b>\n${note}`);
    }
    const copied = await copyMessageToCustomer(customer.telegramId, fromChatId, messageId);
    if (copied) {
      await ConversationService.markMessageSent(msgRecord.id, Date.now());
      await ctx.reply(`✅ Đã gửi media dến khách <code>${customerId}</code>.`, { parse_mode: "HTML" });
    } else {
      await ConversationService.markMessageFailed(msgRecord.id, "copyMessage returned false");
      await ctx.reply(`⚠️ Không thể chuyển media tới Telegram khách.`, { parse_mode: "HTML" });
    }
  } catch (err: any) {
    await ConversationService.markMessageFailed(msgRecord.id, err?.message || "send failed");
    await ctx.reply(`❌ Lỗi gửi media: ${err?.message || "unknown"}`, { parse_mode: "HTML" });
  }
}



