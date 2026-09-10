import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { ConversationService } from "../../modules/conversation/conversation-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { prisma } from "../../database/client.js";
import { sendToCustomer, copyMessageToCustomer } from "../notifications.js";
import { getCskhMenuKeyboard, renderCskhStartText } from "../menus/cskh-menu.js";

export const cskhHandler = new Composer<BotContext>();

export async function showCskhStart(ctx: BotContext) {
  const staff = ctx.identity?.staff;
  const staffName = staff?.name || "NhĂ¢n viĂªn CSKH";
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
    return ctx.reply("đŸ“‹ Hiá»‡n khĂ´ng cĂ³ ticket nĂ o Ä‘ang á»Ÿ cháº¿ Ä‘á»™ HUMAN.", {
      reply_markup: getCskhMenuKeyboard()
    });
  }

  let msg = `đŸ“‹ <b>DANH SĂCH TICKETS ÄANG Há»– TRá»¢ (${tickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();

  for (const t of tickets) {
    const isClaimedByMe = t.claimedById === String(ctx.from?.id);
    const status = isClaimedByMe ? "đŸ‘‰ Báº¡n Ä‘ang nháº­n" : t.claimedById ? `ÄĂ£ gĂ¡n: ${t.claimedById}` : "ChÆ°a gĂ¡n";
    msg += `â€¢ KhĂ¡ch: <code>${t.customerId}</code> | ${status}\n`;

    if (!t.claimedById) {
      keyboard.text(`đŸ™‹ Nháº­n: ${t.customerId}`, `cskh:ticket:claim:${t.customerId}`).row();
    } else if (isClaimedByMe) {
      keyboard.text(`đŸ¤– Tráº£ vá» AI: ${t.customerId}`, `cskh:ticket:release:${t.customerId}`).row();
    }
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// /claim <customerId>
cskhHandler.command("claim", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("CĂº phĂ¡p: <code>/claim &lt;ID_KhĂ¡ch&gt;</code>", { parse_mode: "HTML" });

  const staffTelegramId = String(ctx.from?.id || "");
  try {
    await ConversationService.claim(customerId, staffTelegramId, ctx.identity?.userType || "CSKH");
  } catch (err: any) {
    return ctx.reply(`â ï¸ ${err.message}`);
  }

  // Notify customer without revealing staff's personal info
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `đŸ’¬ <b>Bá»™ pháº­n CSKH:</b>\nEm xin chĂ o anh/chá»‹, em Ä‘Ă£ tiáº¿p nháº­n há»— trá»£ áº¡. Anh/chá»‹ cáº§n há»— trá»£ thĂ´ng tin gĂ¬ áº¡?`
    );
  }

  await ctx.reply(
    `âœ… ÄĂ£ nháº­n há»— trá»£ khĂ¡ch <code>${customerId}</code>.\n` +
      `â€¢ Cháº¿ Ä‘á»™ chuyá»ƒn sang: <b>HUMAN</b> (AI táº¡m dá»«ng tráº£ lá»i tá»± Ä‘á»™ng).\n` +
      `â€¢ DĂ¹ng lá»‡nh <code>/msg ${customerId} &lt;ná»™i dung&gt;</code> Ä‘á»ƒ nháº¯n tin trá»±c tiáº¿p cho khĂ¡ch.`,
    { parse_mode: "HTML" }
  );
});

// /release <customerId>
cskhHandler.command("release", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.claim");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("CĂº phĂ¡p: <code>/release &lt;ID_KhĂ¡ch&gt;</code>", { parse_mode: "HTML" });

  const staffTelegramId = String(ctx.from?.id || "");
  try {
    await ConversationService.release(
      customerId,
      staffTelegramId,
      ctx.identity?.userType || "CSKH",
      ctx.identity?.staff?.permissions || []
    );
  } catch (err: any) {
    return ctx.reply(`âŒ ${err.message}`);
  }

  // Notify customer
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `đŸ¤– <b>Há»‡ thá»‘ng:</b> Cuá»™c trĂ² chuyá»‡n Ä‘Ă£ Ä‘Æ°á»£c chuyá»ƒn vá» trá»£ lĂ½ AI tá»± Ä‘á»™ng. ChĂºc quĂ½ khĂ¡ch má»™t ngĂ y tá»‘t lĂ nh!`
    );
  }

  await ctx.reply(
    `âœ… ÄĂ£ giáº£i phĂ³ng khĂ¡ch <code>${customerId}</code>.\n` +
      `â€¢ Cháº¿ Ä‘á»™ trĂ² chuyá»‡n chuyá»ƒn vá»: <b>AUTO</b> (AI tá»± Ä‘á»™ng tiáº¿p quáº£n).`,
    { parse_mode: "HTML" }
  );
});

// /msg <customerId> <content>
cskhHandler.command("msg", async (ctx) => {
  const allowed = await requirePermission(ctx, "customer.message");
  if (!allowed) return;

  const text = ctx.match?.trim();
  if (!text) return ctx.reply("CĂº phĂ¡p: <code>/msg &lt;ID_KhĂ¡ch&gt; &lt;Ná»™i dung gá»­i khĂ¡ch&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lĂ²ng nháº­p ná»™i dung sau ID khĂ¡ch.");

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
    return ctx.reply("â›” Báº¡n chá»‰ cĂ³ thá»ƒ gá»­i tin nháº¯n cho khĂ¡ch hĂ ng mĂ  báº¡n Ä‘Ă£ tiáº¿p nháº­n (Claim). DĂ¹ng /claim trÆ°á»›c náº¿u cáº§n tiáº¿p nháº­n.");
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
      const sent = await sendToCustomer(customer.telegramId, `đŸ’¬ <b>Bá»™ pháº­n CSKH:</b>\n${content}`);
      if (sent) {
        await ConversationService.markMessageSent(msgRecord.id, Date.now());
        await ctx.reply(`âœ… ÄĂ£ gá»­i tin nháº¯n Ä‘áº¿n khĂ¡ch <code>${customerId}</code>.`, { parse_mode: "HTML" });
      } else {
        await ConversationService.markMessageFailed(msgRecord.id, "Telegram send returned false");
        await ctx.reply(`â ï¸ KhĂ´ng thá»ƒ chuyá»ƒn tin nháº¯n tá»›i Telegram khĂ¡ch (ID: <code>${customer.telegramId}</code>).`, {
          parse_mode: "HTML"
        });
      }
    } catch (sendErr: any) {
      await ConversationService.markMessageFailed(msgRecord.id, sendErr.message);
      await ctx.reply(`âŒ Lá»—i gá»­i tin nháº¯n Telegram: ${sendErr.message}`, { parse_mode: "HTML" });
    }
  } else {
    await ConversationService.markMessageFailed(msgRecord.id, "Customer not found");
    await ctx.reply(`âŒ KhĂ´ng tĂ¬m tháº¥y thĂ´ng tin khĂ¡ch hĂ ng <code>${customerId}</code>.`, { parse_mode: "HTML" });
  }
});

// /note <customerId> <content> (INTERNAL ONLY)
cskhHandler.command("note", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const text = ctx.match?.trim();
  if (!text) return ctx.reply("CĂº phĂ¡p: <code>/note &lt;ID_KhĂ¡ch&gt; &lt;Ná»™i dung ghi chĂº&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lĂ²ng nháº­p ná»™i dung ghi chĂº sau ID khĂ¡ch.");

  const customerId = text.substring(0, firstSpace).trim();
  const noteContent = text.substring(firstSpace + 1).trim();
  const staffTelegramId = String(ctx.from?.id || "");

  // Save internal note. IMPORTANT: NEVER send to customer!
  await ConversationService.addInternalNote(customerId, staffTelegramId, noteContent);
  await ctx.reply(`đŸ“ <b>ÄĂ£ thĂªm ghi chĂº ná»™i bá»™ cho khĂ¡ch <code>${customerId}</code>.</b>\n<i>(Ghi chĂº chá»‰ hiá»ƒn thá»‹ trong ná»™i bá»™ nhĂ¢n viĂªn).</i>`, {
    parse_mode: "HTML"
  });
});

// /history <customerId>
cskhHandler.command("history", async (ctx) => {
  const allowed = await requirePermission(ctx, "conversation.view");
  if (!allowed) return;

  const customerId = ctx.match?.trim();
  if (!customerId) return ctx.reply("CĂº phĂ¡p: <code>/history &lt;ID_KhĂ¡ch&gt;</code>", { parse_mode: "HTML" });

  const history = await ConversationService.getHistory(customerId);
  let msg = `đŸ“œ <b>Lá»CH Sá»¬ TRAO Äá»”I Vá»I KHĂCH: ${customerId}</b>\n` +
    `â€¢ Cháº¿ Ä‘á»™: <b>${history.mode}</b>\n` +
    `â€¢ NhĂ¢n viĂªn nháº­n: <b>${history.claimedById || "ChÆ°a gĂ¡n"}</b>\n\n`;

  msg += `<b>Tin nháº¯n gáº§n Ä‘Ă¢y:</b>\n`;
  for (const m of history.messages.slice(-10)) {
    msg += `[${m.senderType}]: ${m.content}\n`;
  }

  if (history.notes.length > 0) {
    msg += `\n<b>Ghi chĂº ná»™i bá»™:</b>\n`;
    for (const n of history.notes.slice(-5)) {
      msg += `â€¢ (${n.authorId}): ${n.content}\n`;
    }
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
});

// /translate
cskhHandler.command("translate", async (ctx) => {
  const text = ctx.match?.trim();
  if (!text) return ctx.reply("CĂº phĂ¡p: <code>/translate &lt;tiáº¿ng_anh|tiáº¿ng_khmer|tiáº¿ng_trung&gt; &lt;ná»™i dung&gt;</code>", { parse_mode: "HTML" });

  const firstSpace = text.indexOf(" ");
  if (firstSpace === -1) return ctx.reply("Vui lĂ²ng nháº­p ngĂ´n ngá»¯ vĂ  ná»™i dung cáº§n dá»‹ch.");

  const targetLang = text.substring(0, firstSpace).trim();
  const sourceText = text.substring(firstSpace + 1).trim();

  const translated = await ConversationService.previewTranslation(sourceText, targetLang);
  await ctx.reply(
    `đŸŒ <b>XEM TRÆ¯á»C Báº¢N Dá»CH (${targetLang}):</b>\n\n` +
      `<i>Gá»‘c:</i> ${sourceText}\n` +
      `<i>Dá»‹ch:</i> <b>${translated}</b>\n\n` +
      `Báº¡n cĂ³ thá»ƒ copy báº£n dá»‹ch trĂªn Ä‘á»ƒ dĂ¹ng trong /msg.`,
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
        reply_markup: new InlineKeyboard().text("âœ”ï¸ ÄĂ£ cĂ³ nhĂ¢n viĂªn tiáº¿p nháº­n", "cskh:noop")
      });
    } catch {
      // Stale/too-old message cannot be edited â€” safe to ignore.
    }
    await ctx.reply(
      `â ï¸ Ticket nĂ y Ä‘Ă£ Ä‘Æ°á»£c nhĂ¢n viĂªn khĂ¡c tiáº¿p nháº­n trÆ°á»›c Ä‘Ă³.\n` +
        `Vui lĂ²ng chá»n khĂ¡ch hĂ ng khĂ¡c trong menu Há»— trá»£.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  try {
    await ctx.editMessageReplyMarkup({
      reply_markup: new InlineKeyboard().text("âœ”ï¸ Báº¡n Ä‘ang há»— trá»£ khĂ¡ch nĂ y", "cskh:noop")
    });
  } catch {
    // Stale/too-old message cannot be edited â€” safe to ignore.
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `đŸ’¬ <b>Bá»™ pháº­n CSKH:</b>\nEm xin chĂ o anh/chá»‹, em Ä‘Ă£ tiáº¿p nháº­n há»— trá»£ áº¡. Anh/chá»‹ cáº§n há»— trá»£ thĂ´ng tin gĂ¬ áº¡?`
    );
  }

  await ctx.reply(
    `âœ… ÄĂ£ tiáº¿p nháº­n khĂ¡ch <code>${customerId}</code> (Cháº¿ Ä‘á»™ HUMAN).\n` +
      `DĂ¹ng <code>/msg ${customerId} &lt;ná»™i dung&gt;</code> Ä‘á»ƒ nháº¯n tin.`,
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
        reply_markup: new InlineKeyboard().text("đŸ”„ Tráº£ vá» AI khĂ´ng thĂ nh cĂ´ng", "cskh:noop")
      });
    } catch {
      // Stale/too-old message cannot be edited â€” safe to ignore.
    }
    await ctx.reply(`â ï¸ ${err.message}`);
    return;
  }

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (customer) {
    await sendToCustomer(
      customer.telegramId,
      `đŸ¤– <b>Há»‡ thá»‘ng:</b> Cuá»™c trĂ² chuyá»‡n Ä‘Ă£ Ä‘Æ°á»£c chuyá»ƒn vá» trá»£ lĂ½ AI tá»± Ä‘á»™ng.`
    );
  }

  await ctx.reply(`âœ… ÄĂ£ hoĂ n táº¥t há»— trá»£ vĂ  chuyá»ƒn khĂ¡ch <code>${customerId}</code> vá» AUTO AI.`, {
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
    return ctx.reply("đŸ“‹ Hiá»‡n khĂ´ng cĂ³ ticket nĂ o Ä‘ang á»Ÿ cháº¿ Ä‘á»™ HUMAN.");
  }

  let msg = `đŸ“‹ <b>DANH SĂCH KHĂCH CHá»œ Há»– TRá»¢ (${tickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const t of tickets) {
    msg += `â€¢ KhĂ¡ch: <code>${t.customerId}</code> | NgÆ°á»i nháº­n: ${t.claimedById || "ChÆ°a nháº­n"}\n`;
    if (!t.claimedById) {
      keyboard.text(`đŸ™‹ Nháº­n ${t.customerId}`, `cskh:ticket:claim:${t.customerId}`).row();
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
    return ctx.reply("đŸ’¬ Báº¡n hiá»‡n khĂ´ng tiáº¿p nháº­n cuá»™c trĂ² chuyá»‡n nĂ o.");
  }

  let msg = `đŸ’¬ <b>Há»˜I THOáº I Báº N ÄANG PHá»¤ TRĂCH (${myTickets.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const t of myTickets) {
    msg += `â€¢ KhĂ¡ch: <code>${t.customerId}</code>\n`;
    keyboard.text(`đŸ¤– Tráº£ vá» AI: ${t.customerId}`, `cskh:ticket:release:${t.customerId}`).row();
  }
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

cskhHandler.callbackQuery("cskh:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const orders = await OrderService.getAllOrders(10);
  let msg = `đŸ“¦ <b>DANH SĂCH 10 ÄÆ N HĂ€NG Má»I NHáº¤T:</b>\n\n`;
  for (const o of orders) {
    msg += `â€¢ <b>${o.id}</b>: ${o.sourceAmount} ${o.sourceCurrency} â” ${o.targetAmount} ${o.targetCurrency} [<code>${o.status}</code>]\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

cskhHandler.callbackQuery("cskh:menu:find_customer", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `đŸ” <b>TĂŒM KIáº¾M KHĂCH HĂ€NG:</b>\n` +
      `Vui lĂ²ng sá»­ dá»¥ng lá»‡nh xem lá»‹ch sá»­:\n` +
      `<code>/history &lt;ID_KhĂ¡ch&gt;</code>`,
    { parse_mode: "HTML" }
  );
});

cskhHandler.callbackQuery("cskh:menu:notes", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `đŸ“ <b>GHI CHĂ Ná»˜I Bá»˜:</b>\n` +
      `ThĂªm ghi chĂº báº£o máº­t cho khĂ¡ch hĂ ng báº±ng cĂº phĂ¡p:\n` +
      `<code>/note &lt;ID_KhĂ¡ch&gt; &lt;Ná»™i dung ghi chĂº&gt;</code>\n\n` +
      `<i>Ghi chĂº chá»‰ lÆ°u ná»™i bá»™, khĂ¡ch hĂ ng khĂ´ng thá»ƒ nhĂ¬n tháº¥y.</i>`,
    { parse_mode: "HTML" }
  );
});

cskhHandler.callbackQuery("cskh:menu:release_prompt", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `đŸ¤– <b>TRáº¢ Vá»€ TRá»¢ LĂ AI:</b>\n` +
      `Äá»ƒ chuyá»ƒn cuá»™c trĂ² chuyá»‡n tá»« CSKH vá» cho AI tá»± Ä‘á»™ng xá»­ lĂ½, dĂ¹ng lá»‡nh:\n` +
      `<code>/release &lt;ID_KhĂ¡ch&gt;</code>`,
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

  // Explicit-customer form: caption starts with /msg <customerId> [optional note]
  const match = caption.match(/^\/msg\s+(\S+)(?:\s+(.*))?$/i);
  if (!match) {
    await ctx.reply(
      `📎 <b>GỬI MEDIA CHO KHÁCH</b>\n\n` +
        `Để gửi ảnh/voice/file cho khách, hãy ghi caption:\n` +
        `<code>/msg &lt;ID_Khách&gt; [ghi chú tùy chọn]</code>\n\n` +
        `<i>Phase B: bắt buộc nêu rõ ID khách. Chọn khách nhanh thuộc Phase C.</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const customerId = match[1];
  const note = (match[2] || "").trim();

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
      await ctx.reply(`✅ Đã gửi media đến khách <code>${customerId}</code>.`, { parse_mode: "HTML" });
    } else {
      await ConversationService.markMessageFailed(msgRecord.id, "copyMessage returned false");
      await ctx.reply(`⚠️ Không thể chuyển media tới Telegram khách.`, { parse_mode: "HTML" });
    }
  } catch (err: any) {
    await ConversationService.markMessageFailed(msgRecord.id, err?.message || "send failed");
    await ctx.reply(`❌ Lỗi gửi media: ${err?.message || "unknown"}`, { parse_mode: "HTML" });
  }
}

