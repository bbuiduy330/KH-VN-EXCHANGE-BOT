import { Bot, InlineKeyboard, InputFile } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { SystemConfigService } from "../modules/system-config/system-config-service.js";
import { prisma } from "../database/client.js";
import { PermissionService } from "../modules/permissions/permission-service.js";
import { MoneyService } from "../modules/money/money-service.js";
import { OrderService } from "../modules/orders/order-service.js";
import { getCustomerBillEvidence } from "../modules/orders/bill-evidence.js";
import { LocalStorageService } from "../modules/storage/local-storage-service.js";


let botInstance: Bot<any> | null = null;

export function setBotInstance(bot: Bot<any> | null) {
  botInstance = bot;
}

export function getBotInstance(): Bot<any> | null {
  return botInstance;
}

export async function sendToCustomer(
  customerTelegramId: string,
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<{ message_id: number } | null> {
  if (!botInstance) {
    logger.warn({ customerTelegramId }, "Cannot send message to customer: bot instance is not initialized");
    return null;
  }
  const tid = String(customerTelegramId).trim();
  if (!tid) return null;

  try {
    const sent = await botInstance.api.sendMessage(tid, text, options);
    return sent;
  } catch (err: any) {
    logger.warn({ err: err?.message, customerTelegramId: tid }, "Failed to send message to customer");
    return null;
  }
}

export async function sendToStaff(
  staffTelegramId: string,
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<boolean> {
  if (!botInstance) {
    logger.warn({ staffTelegramId }, "Cannot send message to staff: bot instance is not initialized");
    return false;
  }
  const tid = String(staffTelegramId).trim();
  if (!tid) return false;

  try {
    await botInstance.api.sendMessage(tid, text, options);
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, staffTelegramId: tid }, "Failed to send message to staff");
    return false;
  }
}

export async function sendToAdminNotificationChat(
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<boolean> {
  const chatId = SystemConfigService.getAdminNotificationChatId()?.trim();
  if (!chatId || !botInstance) {
    return false;
  }

  try {
    await botInstance.api.sendMessage(chatId, text, options);
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, chatId }, "Failed to send to admin notification chat");
    return false;
  }
}

/**
 * Telegram-native media copy (no download/re-upload).
 * Used for HUMAN support media relay in both directions.
 * Preserves captions when the original message had one.
 */
export async function copyMessageToChat(
  fromChatId: string | number,
  messageId: number,
  toChatId: string | number
): Promise<number | null> {
  if (!botInstance) {
    logger.warn({ fromChatId, toChatId, messageId }, "copyMessageToChat: bot instance not initialized");
    return null;
  }
  const from = String(fromChatId).trim();
  const to = String(toChatId).trim();
  if (!from || !to || !messageId) return null;

  try {
    const copied = await botInstance.api.copyMessage(to, from, messageId);
    return copied.message_id;
  } catch (err: any) {
    logger.warn(
      { err: err?.message, fromChatId: from, toChatId: to, messageId },
      "copyMessageToChat failed"
    );
    return null;
  }
}

export async function copyMessageToStaff(
  staffTelegramId: string,
  fromChatId: string | number,
  messageId: number
): Promise<number | null> {
  return copyMessageToChat(fromChatId, messageId, staffTelegramId);
}

export async function copyMessageToCustomer(
  customerTelegramId: string,
  fromChatId: string | number,
  messageId: number
): Promise<number | null> {
  return copyMessageToChat(fromChatId, messageId, customerTelegramId);
}

/**
 * C3 — direct DM to eligible active staff (conversation.claim permission).
 * Used for HUMAN support requests. Forbidden/403 (staff never started the bot)
 * is caught silently so it never breaks the customer's support request.
 * Never exposes token/error internals.
 */
export async function notifyEligibleStaff(
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<void> {
  if (!botInstance) return;

  let staff: any[] = [];
  try {
    staff = await prisma.staffUser.findMany({ where: { status: "ACTIVE" } });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "notifyEligibleStaff: failed to list staff");
    return;
  }

  for (const s of staff) {
    try {
      const eligible = await PermissionService.hasPermission(s.telegramId, "conversation.claim");
      if (!eligible) continue;
      await botInstance.api.sendMessage(s.telegramId, text, options);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("403") || msg.includes("Forbidden")) {
        logger.info({ staffTelegramId: s.telegramId }, "notifyEligibleStaff: skip (403/forbidden)");
      } else {
        logger.warn({ err: msg, staffTelegramId: s.telegramId }, "notifyEligibleStaff: send failed");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Admin operational notifications (event-driven, authorized-chat only)
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return `#${String(id || "").slice(-6)}`;
}

/**
 * Payout-ready notification must fire ONLY after a real first transition into
 * WAITING_PAYOUT — never merely because a handler was invoked (stale/repeated
 * callbacks must stay silent). Callers guard `notifyPayoutReady` with this.
 */
export function isPayoutReadyTransition(status: string | null | undefined): boolean {
  return status === "WAITING_PAYOUT";
}

/**
 * Full payout-readiness gate (transition + confirmed destination).
 * notifyPayoutReady() may ONLY fire when BOTH are true:
 *  - the order actually entered WAITING_PAYOUT (incoming payment verified), AND
 *  - a valid payout destination snapshot exists (WAITING_PAYOUT without a
 *    destination = waiting for customer payout info, never payout-ready).
 */
export function shouldNotifyPayoutReady(order: { status?: string | null; payoutBankSnapshot?: any } | null | undefined): boolean {
  if (!order) return false;
  if (!isPayoutReadyTransition(order.status)) return false;
  return OrderService.isPayoutReady(order as any);
}

function customerName(customer: any): string {
  if (!customer) return "Khách";
  if (customer.username) return `@${customer.username}`;
  const name = (customer.fullName || "").trim();
  return name || shortId(customer.id);
}

/**
 * B — Stable Admin/CSKH identity rendering:
 *   👤 @username
 *   🆔 Telegram ID: 123456789
 *   🔖 Ref: #VEAZ8C
 * The Telegram numeric ID comes from the persisted Customer.telegramId.
 * The short ref is ONLY a UI reference and is never presented as "ID".
 * (Customer-facing flows never expose the Telegram numeric ID to other
 * customers — this helper is for Admin/CSKH surfaces only.)
 */
export function customerIdentity(customer: {
  username?: string | null;
  fullName?: string | null;
  telegramId?: string | null;
  id?: string;
} | null | undefined): string {
  if (!customer) return "👤 Khách";
  const lines: string[] = [];
  if (customer.username) {
    lines.push(`👤 @${customer.username}`);
  } else if ((customer.fullName || "").trim()) {
    lines.push(`👤 ${customer.fullName.trim()}`);
  } else {
    lines.push("👤 Khách");
  }
  if (customer.telegramId) {
    lines.push(`🆔 Telegram ID: <code>${customer.telegramId}</code>`);
  }
  if (customer.id) {
    lines.push(`🔖 Ref: #${String(customer.id).slice(-6).toUpperCase()}`);
  }
  return lines.join("\n");
}

/**
 * Runtime deep link into the private bot chat (no new env requirements).
 * Uses the bot username resolved at startup (bot.botInfo, set in
 * startSingleBot). Returns null when the username is unknown — callers then
 * fall back to the text instruction only.
 */
export function getPrivateBotChatUrl(): string | null {
  const me = botInstance?.botInfo as { username?: string } | undefined;
  const username = me?.username;
  return username ? `https://t.me/${username}` : null;
}

/**
 * Keyboard tail for ADMIN NOTIFICATION destinations (which may be a group).
 * Financial mutations are PRIVATE-CHAT-ONLY (denyNotPrivate), so group
 * notifications must NEVER present buttons that will be rejected there.
 * Only genuinely group-safe read-only actions + a deep link/instruction into
 * the private bot chat are shown.
 */
function addPrivateChatProcessingTail(
  kb: InlineKeyboard,
  rows: Array<(kb: InlineKeyboard) => InlineKeyboard> = []
): InlineKeyboard {
  for (const row of rows) kb = row(kb);
  // No dead fallback button: when the runtime username is unknown the text
  // instruction alone carries the guidance.
  const url = getPrivateBotChatUrl();
  if (url) {
    kb.row().url("▶️ Mở chat riêng với bot", url);
  }
  return kb;
}

/** Event: customer confirmed a quote and an order was durably created. */
export async function notifyOrderCreated(order: any, customer: any): Promise<void> {
  // ADMIN OPERATIONAL NOTIFICATION ONLY (Vietnamese, authorized chat).
  // This is NOT the customer's payment instruction and NOT the bank transfer
  // memo — those are generated separately in the customer flow. The memo is
  // included here only so Admin can match the incoming transfer.
  let memo = "";
  try {
    const { generateTransferMemo } = await import("../modules/orders/transfer-memo.js");
    memo = generateTransferMemo(SystemConfigService.getTransferMemoTemplate(), {
      orderId: order.id,
      username: customer?.username,
      telegramId: customer?.telegramId
    });
  } catch {
    memo = "";
  }

  const text =
    `✅ <b>KHÁCH ĐÃ XÁC NHẬN ĐỔI TIỀN</b> <i>(thông báo nội bộ Admin)</i>\n\n` +
    `${customerIdentity(customer)}\n` +
    `📦 ${shortId(order.id)}\n\n` +
    `💱 ${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n` +
    `📊 Tỷ giá khóa: ${MoneyService.formatEffectiveRate(order.sourceCurrency, order.targetCurrency, order.rate)}\n` +
    (memo ? `🔖 Nội dung CK khách cần dùng: <code>${escapeHtml(memo)}</code>\n` : "") +
    `🕒 ${new Date(order.createdAt).toLocaleTimeString("vi-VN")}`;

  const kb = new InlineKeyboard()
    .text("📦 Xem đơn", `ops:order:detail:${order.id}`)
    .text("👤 Xem khách", `ops:customer:detail:${order.customerId}`);

  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/**
 * H — Customer bill accepted: Admin receives the ACTUAL evidence (photo or
 * PDF document) plus an identity/amount notification. Uses the ONE
 * authoritative evidence reader (getCustomerBillEvidence) so legacy
 * Order.customerBillFileId and evidence-table uploads both resolve.
 */
export async function notifyBillReceived(order: any): Promise<void> {
  const text =
    `📷 <b>CÓ BILL MỚI — CHỜ XÁC MINH</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n` +
    `💱 ${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n\n` +
    `⚠️ Xử lý tài chính thực hiện trong <b>chat riêng với bot</b> → 🔴 Việc cần xử lý.`;

  // GROUP-SAFE READ-ONLY ACTIONS ONLY. ✅ ĐÃ NHẬN TIỀN / ❌ CHƯA NHẬN ĐƯỢC
  // TIỀN are financial mutations (private-chat-only) and are intentionally
  // NOT offered here — they live in the private bot Order Detail and 🔴
  // Việc cần xử lý, where they actually execute.
  const kb = addPrivateChatProcessingTail(
    new InlineKeyboard()
      .text("📷 Xem bill", `ops:bill:view:${order.id}`)
      .text("📦 Xem đơn", `ops:order:detail:${order.id}`)
      .row()
      .text("👤 Xem khách", `ops:customer:detail:${order.customerId}`)
  );

  // Attach the actual evidence image/document (Telegram-native, no paths).
  let evidenceAttached = false;
  try {
    const evidence = await getCustomerBillEvidence(order.id);
    if (evidence?.filePath) {
      const buffer = await LocalStorageService.readFile(evidence.filePath);
      if (buffer && buffer.length > 0) {
        const isPdf = (evidence.mimeType || "").includes("pdf");
        const chatId = SystemConfigService.getAdminNotificationChatId()?.trim();
        if (chatId && botInstance) {
          if (isPdf) {
            await botInstance.api.sendDocument(chatId, new InputFile(buffer, evidence.fileName || "bill.pdf"), {
              caption: `📷 Biên lai khách · đơn ${shortId(order.id)}`,
              parse_mode: "HTML"
            });
          } else {
            await botInstance.api.sendPhoto(chatId, new InputFile(buffer), {
              caption: `📷 Biên lai khách · đơn ${shortId(order.id)}`,
              parse_mode: "HTML"
            });
          }
          evidenceAttached = true;
        }
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, orderRef: order?.id?.slice?.(-6) }, "notifyBillReceived: evidence attach failed");
  }

  if (!evidenceAttached) {
    logger.warn({ orderRef: order?.id?.slice?.(-6) }, "notifyBillReceived: evidence not attached — Admin uses 📷 Xem bill");
  }

  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Event: an order entered WAITING_PAYOUT and Admin must now pay the customer. */
export async function notifyPayoutReady(order: any): Promise<void> {
  const text =
    `💸 <b>CẦN THANH TOÁN KHÁCH</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n\n` +
    `Khách nhận:\n${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n\n` +
    `⚠️ Xử lý tài chính thực hiện trong <b>chat riêng với bot</b> → 🔴 Việc cần xử lý.`;

  // Group-safe: "💸 Bắt đầu payout" is a private-chat-only financial action.
  const kb = addPrivateChatProcessingTail(
    new InlineKeyboard()
      .text("📦 Xem đơn", `ops:order:detail:${order.id}`)
      .text("👤 Xem khách", `ops:customer:detail:${order.customerId}`)
  );

  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/**
 * Event: incoming payment verified but the customer has NOT yet provided a
 * confirmed payout destination. This is NOT payout-ready — Admin sees 🟡 and
 * the customer is prompted to choose an account.
 */
export async function notifyAwaitingPayoutInfo(order: any): Promise<void> {
  const text =
    `🟡 <b>ĐÃ NHẬN TIỀN — CHỜ KHÁCH GỬI TK/QR NHẬN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n` +
    `💰 Cần chi trả: ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n\n` +
    `Đơn CHƯA SẴN SÀNG payout. Khách đã được yêu cầu chọn tài khoản nhận tiền; ` +
    `khi khách xác nhận, hệ thống sẽ báo 💸 Sẵn sàng payout.`;

  const kb = new InlineKeyboard()
    .text("📦 Xem đơn", `ops:order:detail:${order.id}`)
    .text("🔔 Nhắc khách gửi TK/QR", `ops:payout:nudge:${order.id}`);

  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

// ===========================================================================
// Order cancellation / payment reminder notifications (Vietnamese for Admin)
// No sensitive bank contents are ever included (requirement M).
// ===========================================================================

function escapeHtml(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Event: customer cancelled an eligible unpaid order. */
export async function notifyOrderCancelledByCustomer(order: any): Promise<void> {
  const text =
    `❌ <b>KHÁCH ĐÃ HỦY ĐƠN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n` +
    `💱 ${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n` +
    `📍 Trạng thái: <b>CANCELLED</b>\n` +
    `🔖 Nguồn: <b>CUSTOMER_CANCELLED</b>`;

  const kb = new InlineKeyboard().text("📦 Xem đơn", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Event: Admin cancelled an order (actor + reason audited). */
export async function notifyOrderCancelledByAdmin(order: any, adminLabel: string, reason: string): Promise<void> {
  const text =
    `❌ <b>ADMIN ĐÃ HỦY ĐƠN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n` +
    `🔐 Admin: <b>${escapeHtml(adminLabel)}</b>\n` +
    `📝 Lý do: <b>${escapeHtml(reason)}</b>\n` +
    `📍 Trạng thái: <b>CANCELLED</b>\n` +
    `🔖 Nguồn: <b>ADMIN_CANCELLED</b>`;

  const kb = new InlineKeyboard().text("📦 Xem đơn", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Event: scheduler auto-cancelled an unpaid order after payment timeout. */
export async function notifyOrderAutoCancelled(order: any, remindersSent: number): Promise<void> {
  const text =
    `⏰ <b>TỰ ĐỘNG HỦY ĐƠN — QUÁ HẠN THANH TOÁN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 Mã đơn: ${shortId(order.id)}\n` +
    `🕒 Tạo lúc: ${new Date(order.createdAt).toLocaleString("vi-VN")}\n` +
    `🔔 Số lần nhắc đã gửi: <b>${remindersSent}</b>\n` +
    `📝 Lý do: quá hạn thanh toán (${remindersSent} lần nhắc không hiệu lực)\n` +
    `📍 Trạng thái: <b>CANCELLED (ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT)</b>`;

  const kb = new InlineKeyboard().text("📦 Xem đơn", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Event: a bill was submitted for an already-CANCELLED order (manual review). */
export async function notifyLateBillOnCancelledOrder(order: any): Promise<void> {
  const text =
    `🚨 <b>BIÊN LAI GỬI SAU KHI ĐƠN ĐÃ HỦY — CẦN XEM XÉT THỦ CÔNG</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortId(order.id)}\n\n` +
    `Khách vừa gửi bằng chứng chuyển tiền cho một đơn đã ở trạng thái <b>CANCELLED</b>. ` +
    `KHÔNG tự động mở lại đơn. Vui lòng xem biên lai gốc trong kho lưu trữ và quyết định thủ công ` +
    `(xem xét thủ công / hoàn tiền nếu cần).`;

  const kb = new InlineKeyboard()
    .text("📷 Xem bill", `ops:bill:view:${order.id}`)
    .text("📦 Xem đơn", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}

