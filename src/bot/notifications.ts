import { Bot, InlineKeyboard, InputFile } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { SystemConfigService } from "../modules/system-config/system-config-service.js";
import { prisma } from "../database/client.js";
import { PermissionService } from "../modules/permissions/permission-service.js";
import { MoneyService } from "../modules/money/money-service.js";
import { OrderService } from "../modules/orders/order-service.js";
import { formatPublicOrderRef, orderPublicRef } from "../modules/orders/order-ref.js";
import { getCustomerBillEvidence } from "../modules/orders/bill-evidence.js";
import { LocalStorageService } from "../modules/storage/local-storage-service.js";
import { FileService } from "../modules/files/file-service.js";
import { resolveLocale, t } from "../modules/i18n/locales.js";
import { ChatService } from "../modules/chat/chat-service.js";
import { formatAdminDateTime, formatAdminTime } from "../shared/app-time.js";

/**
 * THE single process-wide bot instance (single-bot architecture). It is
 * assigned exactly once at startup by src/bot/index.ts through
 * setBotInstance() (null while running in standby mode). Every notification
 * helper below reads this ONE reference — no second singleton, no re-created
 * Bot, so every outbound message goes through the same authenticated API.
 */
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
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" },
  transcript?: { customerId?: string; staffTelegramId?: string; contentType?: "TEXT" | "PHOTO" | "DOCUMENT" | "VOICE" | "VIDEO" | "STICKER" | "OTHER" }
): Promise<{ message_id: number } | null> {
  if (!botInstance) {
    logger.warn({ customerTelegramId }, "Cannot send message to customer: bot instance is not initialized");
    return null;
  }
  const tid = String(customerTelegramId).trim();
  if (!tid) return null;

  try {
    const sent = await botInstance.api.sendMessage(tid, text, options);
    // Durable transcript — recorded ONLY after successful delivery. Never
    // blocks/fails the send. Staff replies (explicit staffTelegramId) are
    // STAFF rows; every other delivered bot message is a BOT row.
    void (async () => {
      try {
        const resolvedCustomerId = transcript?.customerId;
        if (resolvedCustomerId && transcript?.staffTelegramId) {
          await ChatService.recordStaffOutbound({
            customerId: resolvedCustomerId,
            telegramChatId: tid,
            telegramMessageId: sent.message_id,
            text,
            contentType: transcript?.contentType || "TEXT",
            staffTelegramId: transcript.staffTelegramId
          });
        } else if (resolvedCustomerId) {
          await ChatService.recordBotOutbound({
            customerId: resolvedCustomerId,
            telegramChatId: tid,
            telegramMessageId: sent.message_id,
            text,
            contentType: transcript?.contentType || "TEXT"
          });
        }
      } catch {
        /* transcript is best-effort — never surfaces */
      }
    })();
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

  const seen = new Set<string>();
  let staff: any[] = [];
  try {
    staff = await prisma.staffUser.findMany({ where: { status: "ACTIVE" } });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "notifyEligibleStaff: failed to list staff");
    return;
  }

  for (const s of staff) {
    const tid = String(s.telegramId || "").trim();
    if (!tid) continue;
    if (seen.has(tid)) continue; // dedupe by Telegram numeric ID
    seen.add(tid);
    try {
      const eligible = await PermissionService.hasPermission(tid, "conversation.claim");
      if (!eligible) continue;
      await botInstance.api.sendMessage(tid, text, options);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("403") || msg.includes("Forbidden")) {
        logger.info({ staffTelegramId: tid }, "notifyEligibleStaff: skip (403/forbidden)");
      } else {
        logger.warn({ err: msg, staffTelegramId: tid }, "notifyEligibleStaff: send failed");
      }
    }
  }
}

/**
 * Support-request recipient list, deduplicated by Telegram numeric ID.
 * The configured Admin notification chat (often the SAME person as an
 * ADMIN/SUPER_ADMIN staff row) and all eligible ACTIVE staff collapse into
 * ONE Set<string> — every recipient appears exactly once.
 */
export async function collectSupportRecipients(): Promise<string[]> {
  const recipients = new Set<string>();
  const adminChat = SystemConfigService.getAdminNotificationChatId()?.trim();
  if (adminChat) recipients.add(adminChat);
  try {
    const staff: any[] = await prisma.staffUser.findMany({ where: { status: "ACTIVE" } });
    for (const s of staff) {
      const tid = String(s.telegramId || "").trim();
      if (!tid) continue;
      const eligible = await PermissionService.hasPermission(tid, "conversation.claim").catch(() => false);
      if (eligible) recipients.add(tid);
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "collectSupportRecipients: failed to list staff");
  }
  return [...recipients];
}

/**
 * ONE support request → ONE notification per recipient.
 * Merges the Admin notification chat + eligible staff, deduplicated by
 * Telegram numeric ID, then sends once per unique recipient.
 */
export async function notifySupportRequest(
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<void> {
  if (!botInstance) return;
  for (const tid of await collectSupportRecipients()) {
    try {
      await botInstance.api.sendMessage(tid, text, options);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("403") || msg.includes("Forbidden")) {
        logger.info({ staffTelegramId: tid }, "notifySupportRequest: skip (403/forbidden)");
      } else {
        logger.warn({ err: msg, staffTelegramId: tid }, "notifySupportRequest: send failed");
      }
    }
  }
}

/**
 * Support-request Admin/CSKH notification text:
 *   🛎 YÊU CẦU HỖ TRỢ
 *   👤 name
 *   🆔 Telegram ID: 123
 *   🔖 Ref: #ABC123
 * Shows ONLY display name + Telegram numeric ID + public Customer Ref.
 * NEVER exposes the internal Customer.id or any banking/payment data.
 */
export function renderSupportRequestText(customer: {
  username?: string | null;
  fullName?: string | null;
  telegramId?: string | null;
  id?: string;
} | null | undefined, contextLabel?: string): string {
  const header = contextLabel
    ? `🛎 <b>YÊU CẦU HỖ TRỢ (${contextLabel})</b>`
    : `🛎 <b>YÊU CẦU HỖ TRỢ</b>`;
  return [header, "", customerIdentity(customer)].join("\n");
}

/**
 * STAFF-ONLY recent-order context appended to GENERIC support notifications
 * (§ customer has no history browser — this context is for Admin/CSKH only).
 * Active order first if one exists, otherwise the latest 2-3 transactions of
 * any status (COMPLETED/CANCELLED included). Bounded take=3 keyset-free query.
 * Uses the canonical public Order Ref — never the raw internal Order.id.
 */
export async function renderSupportRecentOrders(customerId: string): Promise<string> {
  const recent: any[] = await prisma.order
    .findMany({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3
    })
    .catch(() => []);
  if (recent.length === 0) return "";
  const lines = recent.map(
    (o) =>
      `${formatPublicOrderRef(o)} · ${MoneyService.formatMoney(o.sourceAmount, o.sourceCurrency)} → ${MoneyService.formatMoney(o.targetAmount, o.targetCurrency)} · ${t("vi", `status.${o.status}`)} · ${formatAdminDateTime(o.createdAt)}`
  );
  return `\n\n📌 Giao dịch gần nhất\n${lines.join("\n")}`;
}

/**
 * Support-request action keyboard — existing screens only:
 * claim ticket (C3) / Admin customer profile / latest active order / the
 * STAFF-ONLY full transaction browser (📋 Giao dịch khách → CRM history).
 * Button payloads carry the internal Customer.id (stable callback identity);
 * the LABELS never show it.
 */
export async function supportRequestKeyboard(customerId: string): Promise<InlineKeyboard> {
  const kb = new InlineKeyboard()
    .text("💬 Hỗ trợ khách", `cskh:ticket:claim:${customerId}`)
    .text("👤 Hồ sơ khách", `ops:customer:detail:${customerId}`);
  const latest = await OrderService.getLatestActiveOrderForCustomer(customerId).catch(() => null);
  if (latest) kb.row().text("📦 Giao dịch gần nhất", `ops:order:detail:${latest.id}`);
  kb.row().text("📋 Giao dịch khách", `ops:customer:history:${customerId}:all`);
  return kb;
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
  // Deliberate narrowing: username → display name → generic label.
  // Never renders "undefined"/"null"; never calls string methods un-narrowed.
  const username = customer.username?.trim();
  const fullName = customer.fullName?.trim();
  if (username) {
    lines.push(`👤 @${username}`);
  } else if (fullName) {
    lines.push(`👤 ${fullName}`);
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
    `📦 ${formatPublicOrderRef(order)}\n\n` +
    `💱 ${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n` +
    `📊 Tỷ giá khóa: ${MoneyService.formatEffectiveRate(order.sourceCurrency, order.targetCurrency, order.rate)}\n` +
    (memo ? `🔖 Nội dung CK khách cần dùng: <code>${escapeHtml(memo)}</code>\n` : "") +
    `🕒 ${formatAdminTime(order.createdAt)} (GMT+7)`;

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
 * I — `risk` is an ADMIN-ONLY duplicate/re-upload warning; the customer always
 * receives a neutral acknowledgment, never an accusation.
 */
export async function notifyBillReceived(order: any, opts?: { risk?: "DUPLICATE_BILL" | "ADDITIONAL_BILL" }): Promise<void> {
  const riskLine =
    opts?.risk === "DUPLICATE_BILL"
      ? `⚠️ <b>Bill trùng / bill gửi lại</b> — Vui lòng kiểm tra kỹ trước khi xác nhận.\n`
      : opts?.risk === "ADDITIONAL_BILL"
        ? `⚠️ <b>Bill bổ sung / gửi lại</b> — Vui lòng kiểm tra kỹ trước khi xác nhận.\n`
        : "";
  const text =
    `📷 <b>CÓ BILL MỚI — CHỜ XÁC MINH</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${formatPublicOrderRef(order)}\n` +
    `💱 ${MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency)} → ${MoneyService.formatMoney(order.targetAmount, order.targetCurrency)}\n\n` +
    riskLine +
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
              caption: `📷 Biên lai khách · đơn ${formatPublicOrderRef(order)}`,
              parse_mode: "HTML"
            });
          } else {
            await botInstance.api.sendPhoto(chatId, new InputFile(buffer), {
              caption: `📷 Biên lai khách · đơn ${formatPublicOrderRef(order)}`,
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

/**
 * N — After the Admin's payout evidence is durably stored (PAYOUT_SENT), the
 * CUSTOMER must receive the actual receipt (photo/image/PDF). Never exposes
 * filesystem paths. Returns true ONLY if Telegram delivery succeeded.
 */
export async function sendPayoutReceiptToCustomer(order: any): Promise<boolean> {
  const customer = order.customer;
  if (!customer?.telegramId || !botInstance) return false;
  const locale = resolveLocale(customer.language);
  try {
    const evidenceId = order.payoutBillFileId;
    if (!evidenceId) {
      await sendToCustomer(String(customer.telegramId), t(locale, "payout.received_title"), { parse_mode: "HTML" });
      return false;
    }
    const evidence = await prisma.fileEvidence.findUnique({ where: { id: evidenceId } });
    const buffer = evidence?.filePath ? await LocalStorageService.readFile(evidence.filePath) : null;
    if (!buffer || buffer.length === 0) {
      await sendToCustomer(String(customer.telegramId), t(locale, "payout.received_title"), { parse_mode: "HTML" });
      return false;
    }
    const isPdf = (evidence?.mimeType || "").includes("pdf");
    const chatId = String(customer.telegramId);
    if (isPdf) {
      await botInstance.api.sendDocument(chatId, new InputFile(buffer, evidence?.fileName || "receipt.pdf"), {
        caption: `${t(locale, "payout.received_title")}\n${t(locale, "payout.receipt_caption", { id: orderPublicRef(order) })}`,
        parse_mode: "HTML"
      });
    } else {
      await botInstance.api.sendPhoto(chatId, new InputFile(buffer), {
        caption: `${t(locale, "payout.received_title")}\n${t(locale, "payout.receipt_caption", { id: orderPublicRef(order) })}`,
        parse_mode: "HTML"
      });
    }
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, orderRef: order?.id?.slice?.(-6) }, "sendPayoutReceiptToCustomer failed");
    // Financial state is preserved regardless; tell the customer the money was
    // sent even when the media could not be delivered.
    await sendToCustomer(String(customer.telegramId), t(locale, "payout.received_title"), { parse_mode: "HTML" }).catch(() => {});
    return false;
  }
}

/**
 * O — Completion + optional rating. Rating NEVER blocks financial completion:
 * the completion message is sent first; rating buttons are pure best-effort
 * feedback stored as an audit record (no rating schema subsystem).
 */
export async function notifyOrderCompletedWithRating(order: any): Promise<void> {
  const customer = order.customer;
  if (!customer?.telegramId) return;
  const locale = resolveLocale(customer.language);
  const kb = new InlineKeyboard()
    .text("⭐ 1", `customer:rate:${order.id}:1`)
    .text("⭐⭐ 2", `customer:rate:${order.id}:2`)
    .text("⭐⭐⭐ 3", `customer:rate:${order.id}:3`)
    .row()
    .text("⭐⭐⭐⭐ 4", `customer:rate:${order.id}:4`)
    .text("⭐⭐⭐⭐⭐ 5", `customer:rate:${order.id}:5`)
    .row()
    .text(t(locale, "rate.skip"), `customer:rate:skip:${order.id}`)
    .row()
    // Quick support for THIS exact order — internal Order.id only in the
    // callback payload; the customer-facing label never shows it.
    .text(t(locale, "order.support_this_btn"), `customer:support:order:${order.id}`);
  await sendToCustomer(
    String(customer.telegramId),
    `${t(locale, "order.completed_title", { id: orderPublicRef(order) })}\n\n${t(locale, "rate.title")}`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

/** Event: an order entered WAITING_PAYOUT and Admin must now pay the customer. */
export async function notifyPayoutReady(order: any): Promise<void> {
  const text =
    `💸 <b>CẦN THANH TOÁN KHÁCH</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${formatPublicOrderRef(order)}\n\n` +
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
    `📦 ${formatPublicOrderRef(order)}\n` +
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
    `📦 ${formatPublicOrderRef(order)}\n` +
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
    `📦 ${formatPublicOrderRef(order)}\n` +
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
    `📦 Mã đơn: ${formatPublicOrderRef(order)}\n` +
    `🕒 Tạo lúc: ${formatAdminDateTime(order.createdAt)} (GMT+7)\n` +
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
    `📦 ${formatPublicOrderRef(order)}\n\n` +
    `Khách vừa gửi bằng chứng chuyển tiền cho một đơn đã ở trạng thái <b>CANCELLED</b>. ` +
    `KHÔNG tự động mở lại đơn. Vui lòng xem biên lai gốc trong kho lưu trữ và quyết định thủ công ` +
    `(xem xét thủ công / hoàn tiền nếu cần).`;

  const kb = new InlineKeyboard()
    .text("📷 Xem bill", `ops:bill:view:${order.id}`)
    .text("📦 Xem đơn", `ops:order:detail:${order.id}`);
  await sendToAdminNotificationChat(text, { parse_mode: "HTML", reply_markup: kb });
}


/**
 * After Admin marks a settlement PAID (manual, audited — the authoritative
 * financial action), notify the OWNING CTV only: settlement summary + the
 * SAME stored payout proof (image → photo, PDF/other → document). No other
 * CTV or customer ever receives another partner's payout files.
 */
export async function notifyPartnerSettlementPaid(settlementId: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    const bot = getBotInstance();
    const settlement = await prisma.partnerSettlement.findUnique({
      where: { id: settlementId },
      include: { partner: true }
    });
    if (!settlement) return { sent: false, reason: "settlement_missing" };
    const telegramId = settlement.partner?.telegramId ? String(settlement.partner.telegramId) : "";
    if (!bot) return { sent: false, reason: "no_bot" };
    if (!telegramId) return { sent: false, reason: "no_telegram" };

    // Partner locale (vi|en) — independent from Customer.locale.
    // Partner.language NULL = the partner has not picked a language yet (has
    // never opened /ctv): automatic notifications use CONCISE BILINGUAL
    // VI + EN text and never silently assume Vietnamese, and NULL is never
    // persisted as a language.
    const partnerLang = settlement.partner?.language;
    const ctvLoc = partnerLang === "en" ? "en" : "vi";
    const renderSettlement = (loc: "vi" | "en"): string =>
      `${t(loc, "ctv.settlement_paid_title")}\n\n` +
      `${t(loc, "ctv.settlement_paid_amount", { amount: `$${Number(settlement.totalUsd ?? 0).toFixed(2)}` })}\n` +
      `${t(loc, "ctv.settlement_paid_items", { count: settlement.itemCount })}\n` +
      `${t(loc, "ctv.settlement_paid_time", { time: formatAdminDateTime(settlement.paidAt ?? new Date()) })}\n\n` +
      `${t(loc, "ctv.settlement_paid_thanks")}`;
    const text = !partnerLang ? `${renderSettlement("vi")}\n\n———\n\n${renderSettlement("en")}` : renderSettlement(ctvLoc);
    await bot.api.sendMessage(telegramId, text, { parse_mode: "HTML" });

    if (settlement.payoutProofFileId) {
      const evidence = await prisma.fileEvidence.findUnique({ where: { id: settlement.payoutProofFileId } });
      const buffer = evidence?.filePath ? await FileService.getFile(evidence.filePath) : null;
      if (buffer && buffer.length > 0) {
        const file = new InputFile(buffer, evidence!.fileName || `settlement_${settlement.id.slice(-6)}`);
        const proofCaption = !partnerLang
          ? `${t("vi", "ctv.proof_caption")}\n${t("en", "ctv.proof_caption")}`
          : t(ctvLoc, "ctv.proof_caption");
        if (String(evidence!.mimeType || "").startsWith("image/")) {
          await bot.api.sendPhoto(telegramId, file, { caption: proofCaption });
        } else {
          await bot.api.sendDocument(telegramId, file, { caption: proofCaption });
        }
      }
    }
    return { sent: true };
  } catch (err: any) {
    logger.warn({ err: err?.message, settlementId }, "notifyPartnerSettlementPaid failed");
    return { sent: false, reason: "error" };
  }
}

// ===========================================================================
// PROACTIVE PARTNER NOTIFICATIONS (presentation only — persistence ALWAYS
// commits first; these helpers run afterwards, are best-effort (never throw)
// and read ONLY persisted authoritative values). Partner language:
// Partner.language vi|en; NULL ⇒ concise bilingual VI+EN; never read from
// Customer.language; NULL is never persisted.
// ===========================================================================

/** Partner UI locales in render order: vi|en selected, NULL ⇒ bilingual. */
function ctvNotifyLocales(language: string | null | undefined): Array<"vi" | "en"> {
  return language === "en" ? ["en"] : language === "vi" ? ["vi"] : ["vi", "en"];
}

/** Localized DB status word for partner notifications (never the raw enum). */
function ctvNotifyStatusWord(loc: "vi" | "en", status: string): string {
  const map: Record<string, string> = {
    HELD: "ctv.status_held",
    AVAILABLE: "ctv.status_available",
    PAID: "ctv.status_paid",
    REVERSED: "ctv.status_reversed"
  };
  const key = map[status];
  return key ? t(loc, key) : status;
}

/** Best-effort send — Telegram failure is logged and NEVER propagated. */
async function sendPartnerNotify(
  partner: { id: string; telegramId?: string | null },
  text: string,
  kb?: InlineKeyboard
): Promise<boolean> {
  try {
    const bot = getBotInstance();
    if (!bot || !partner.telegramId) return false;
    await bot.api.sendMessage(String(partner.telegramId), text, {
      parse_mode: "HTML",
      ...(kb ? { reply_markup: kb } : {})
    });
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, partnerId: partner.id }, "Partner notification failed (non-fatal)");
    return false;
  }
}

/** Bilingual join helper: NULL-language partners get VI + ——— + EN. */
function ctvJoinBilingual(parts: string[]): string {
  return parts.length === 2 ? `${parts[0]}\n\n———\n\n${parts[1]}` : parts[0] ?? "";
}

/** NEW_REFERRAL — fired ONLY after a new referral attribution was persisted. */
export async function notifyPartnerNewReferral(partnerId: string): Promise<boolean> {
  try {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      select: { id: true, telegramId: true, language: true }
    });
    if (!partner) return false;
    const total = await prisma.customer.count({ where: { partnerId } });
    const kb = new InlineKeyboard().text(t("vi", "ctv.btn_link"), "ctv:link");
    const texts = ctvNotifyLocales(partner.language).map((loc) =>
      [
        t(loc, "ctv.notify_new_referral_title"),
        "",
        t(loc, "ctv.notify_new_referral_body"),
        t(loc, "ctv.notify_new_referral_count", { count: total })
      ].join("\n")
    );
    return await sendPartnerNotify(partner, ctvJoinBilingual(texts), kb);
  } catch (err: any) {
    logger.warn({ err: err?.message, partnerId }, "notifyPartnerNewReferral failed (non-fatal)");
    return false;
  }
}

/**
 * COMMISSION_EARNED — called AFTER persisted Commission rows exist for a
 * completed Order (one row per upline level). Each Partner sees ONLY their
 * own persisted row (level / amount / status) with the canonical public
 * Order Ref. One notification per Partner per Order; amounts are NEVER
 * recalculated — rendered straight from the persisted rows.
 */
export async function notifyPartnerCommissionEarned(
  orderId: string,
  created: Array<{
    partnerId: string;
    level: number;
    baseCommissionUsd: any;
    spreadBonusUsd: any;
    totalUsd: any;
    status: string;
  }>
): Promise<void> {
  try {
    if (created.length === 0) return;
    const [order, partners] = await Promise.all([
      prisma.order.findUnique({ where: { id: orderId }, select: { id: true, publicRef: true } }),
      prisma.partner.findMany({
        where: { id: { in: [...new Set(created.map((c: any) => c.partnerId))] } },
        select: { id: true, telegramId: true, language: true }
      })
    ]);
    const orderRef = order
      ? formatPublicOrderRef(order as any)
      : `#${String(orderId).slice(-6).toUpperCase()}`;
    for (const row of created) {
      try {
        const partner = partners.find((p: any) => p.id === row.partnerId);
        if (!partner) continue;
        const texts = ctvNotifyLocales(partner.language).map((loc) => {
          if (Number(row.level) === 1) {
            const lines = [
              t(loc, "ctv.notify_earned_title"),
              "",
              t(loc, "ctv.notify_order", { ref: orderRef }),
              t(loc, "ctv.notify_level", { level: row.level }),
              "",
              t(loc, "ctv.notify_fixed", { amount: usd(row.baseCommissionUsd) })
            ];
            if (Number(row.spreadBonusUsd ?? 0) > 0) {
              lines.push(t(loc, "ctv.notify_spread", { amount: usd(row.spreadBonusUsd) }));
            }
            lines.push(
              t(loc, "ctv.notify_total", { amount: usd(row.totalUsd) }),
              "",
              t(loc, "ctv.notify_status", { status: ctvNotifyStatusWord(loc, row.status) })
            );
            return lines.join("\n");
          }
          return [
            t(loc, "ctv.notify_network_title"),
            "",
            t(loc, "ctv.notify_order", { ref: orderRef }),
            t(loc, "ctv.notify_level_yours", { level: row.level }),
            t(loc, "ctv.notify_amount", { amount: usd(row.totalUsd) }),
            t(loc, "ctv.notify_status", { status: ctvNotifyStatusWord(loc, row.status) })
          ].join("\n");
        });
        const kb = new InlineKeyboard().text(t("vi", "ctv.btn_view_commissions"), "ctv:commissions");
        await sendPartnerNotify(partner, ctvJoinBilingual(texts), kb);
      } catch (err: any) {
        logger.warn(
          { err: err?.message, partnerId: row.partnerId },
          "Partner commission-earned notification failed (non-fatal)"
        );
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, orderId }, "notifyPartnerCommissionEarned failed (non-fatal)");
  }
}

/** Shared USD display for partner notifications (locale-neutral numbers). */
function usd(amount: any): string {
  return `$${Number(amount ?? 0).toFixed(2)}`;
}

/**
 * HELD → AVAILABLE — aggregated per Partner per release run: count + total
 * newly available + resulting available balance. Fired only for rows the
 * run actually transitioned (guarded updateMany), so scheduler retries
 * never duplicate the notification.
 */
export async function notifyPartnerCommissionsAvailable(
  partnerId: string,
  count: number,
  newlyAvailableUsd: any
): Promise<void> {
  try {
    const partner = await prisma.partner.findUnique({
      where: { id: partnerId },
      select: { id: true, telegramId: true, language: true }
    });
    if (!partner) return;
    const agg = await prisma.commission.aggregate({
      _sum: { totalUsd: true },
      where: { partnerId, status: "AVAILABLE" }
    });
    const balance = `$${Number(agg._sum.totalUsd ?? 0).toFixed(2)}`;
    const kb = new InlineKeyboard().text(t("vi", "ctv.btn_view_commissions"), "ctv:commissions");
    const texts = ctvNotifyLocales(partner.language).map((loc) =>
      [
        t(loc, "ctv.notify_available_title"),
        "",
        t(loc, "ctv.notify_available_body", { amount: usd(newlyAvailableUsd) }),
        t(loc, "ctv.notify_available_count", { count }),
        t(loc, "ctv.notify_available_balance", { amount: balance })
      ].join("\n")
    );
    await sendPartnerNotify(partner, ctvJoinBilingual(texts), kb);
  } catch (err: any) {
    logger.warn({ err: err?.message, partnerId }, "notifyPartnerCommissionsAvailable failed (non-fatal)");
  }
}

/** COMMISSION REVERSED — fired ONLY on the actual Admin reversal transition. */
export async function notifyPartnerCommissionReversed(commission: {
  partnerId: string;
  orderId: string;
  totalUsd: any;
  reversedReason?: string | null;
}): Promise<void> {
  try {
    const [partner, order] = await Promise.all([
      prisma.partner.findUnique({
        where: { id: commission.partnerId },
        select: { id: true, telegramId: true, language: true }
      }),
      prisma.order.findUnique({ where: { id: commission.orderId }, select: { id: true, publicRef: true } })
    ]);
    if (!partner) return;
    const orderRef = formatPublicOrderRef({ id: commission.orderId, publicRef: order?.publicRef ?? null });
    const kb = new InlineKeyboard().text(t("vi", "ctv.btn_view_commissions"), "ctv:commissions");
    const texts = ctvNotifyLocales(partner.language).map((loc) =>
      [
        t(loc, "ctv.notify_reversed_title"),
        "",
        t(loc, "ctv.notify_order", { ref: orderRef }),
        t(loc, "ctv.notify_reversed_amount", { amount: usd(commission.totalUsd) }),
        ...(commission.reversedReason
          ? [t(loc, "ctv.notify_reason", { reason: escapeHtml(String(commission.reversedReason)) })]
          : [])
      ].join("\n")
    );
    await sendPartnerNotify(partner, ctvJoinBilingual(texts));
  } catch (err: any) {
    logger.warn({ err: err?.message }, "notifyPartnerCommissionReversed failed (non-fatal)");
  }
}