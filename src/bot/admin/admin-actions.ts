/**
 * Admin financial actions — two-step incoming-money confirmation, payout
 * preview/complete, and evidence viewing. All financial mutations go through
 * the existing authoritative OrderService state-machine transitions; no direct
 * Prisma field patching from callbacks.
 */
import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { env } from "../../config/env.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { FileService } from "../../modules/files/file-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { sendToCustomer, notifyPayoutReady, notifyAwaitingPayoutInfo, shouldNotifyPayoutReady, notifyOrderCancelledByAdmin, customerIdentity, sendPayoutReceiptToCustomer, notifyOrderCompletedWithRating } from "../notifications.js";
import { escapeHtml, STATUS_VI } from "../menus/cskh-panel.js";
import { customerLabel, shortOrderId, maskAccountNumber } from "./admin-panel.js";
import { sendPayoutDestinationPromptToCustomer } from "../handlers/customer-handler.js";
import { getCustomerBillEvidence, hasCustomerBillEvidence } from "../../modules/orders/bill-evidence.js";
import { formatAdminDateTime } from "../../shared/app-time.js";
import { clearAdminSession, clearPendingFinancialAction, getAdminSession, setPendingFinancialAction, setPayoutEvidenceSession, setPendingAction, consumePendingAction, startWizard, clearWizard } from "./admin-session.js";
import {
  sanitizeAdminCancelReason,
  adminCancelSource,
  incomingPaymentVerified,
  payoutSentEvidence
} from "../../modules/orders/order-safety.js";
import { resolveLocale, t } from "../../modules/i18n/locales.js";
import { AuditService } from "../../modules/audit/audit-service.js";

export const adminActionsHandler = new Composer<BotContext>();

function isPrivate(ctx: BotContext): boolean {
  return ctx.chat?.type === "private";
}

async function denyNotPrivate(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery({ text: "⛔ Thao tác tài chính chỉ thực hiện trong chat riêng với bot.", show_alert: true }).catch(() => {});
}

/** View the submitted bill/evidence without exposing filesystem paths. */
export async function showBillView(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "order.view_bill"))) return;

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }

  // G: ONE authoritative reader — resolves both the promoted primary
  // reference (Order.customerBillFileId) and evidence-table uploads.
  const evidence = await getCustomerBillEvidence(orderId);
  if (!evidence || !evidence.filePath) {
    await ctx.reply(`📷 Đơn ${shortOrderId(order.id)} chưa có biên lai khách nào.`).catch(() => {});
    return;
  }

  const buffer = await FileService.getFile(evidence.filePath);
  if (!buffer) {
    await ctx.reply("⚠️ Không tìm thấy tệp biên lai trong kho lưu trữ.").catch(() => {});
    return;
  }

  const caption =
    `📷 Biên lai cho đơn ${shortOrderId(order.id)} · ${STATUS_VI[order.status] || order.status}\n` +
    `👤 ${escapeHtml(customerLabel(order.customer))}${order.customer?.telegramId ? ` · 🆔 <code>${order.customer.telegramId}</code>` : ""}`;
  const isPdf = (evidence.mimeType || "").includes("pdf");
  try {
    if (isPdf) {
      await ctx.replyWithDocument(new InputFile(buffer, evidence.fileName || "bill.pdf"), { caption, parse_mode: "HTML" });
    } else {
      await ctx.replyWithPhoto(new InputFile(buffer), { caption, parse_mode: "HTML" });
    }
  } catch {
    await ctx.reply("⚠️ Không gửi được biên lai (tệp không hợp lệ hoặc quá lớn).").catch(() => {});
  }
}

/**
 * 🧾 Admin payout-receipt viewer: sends the EXACT stored payout evidence the
 * Admin uploaded (FileEvidence via Order.payoutBillFileId) — photo OR PDF,
 * never regenerated or substituted. Read-only: no Order mutation, no resend
 * to the customer. Requires the payout-approval permission + private chat
 * (same gate as the receipt resend, since the receipt may expose payout
 * account details). No fake action when no payout receipt exists.
 */
export async function showPayoutEvidenceView(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (!order.payoutBillFileId) {
    await ctx.reply(`⚠️ Đơn ${shortOrderId(order.id)} chưa có hóa đơn chi trả nào được lưu.`).catch(() => {});
    return;
  }

  // Authoritative stored evidence — the exact file Admin uploaded.
  const evidence = await prisma.fileEvidence.findUnique({ where: { id: order.payoutBillFileId } });
  const buffer = evidence?.filePath ? await FileService.getFile(evidence.filePath) : null;
  if (!buffer || buffer.length === 0) {
    await ctx.reply(
      `⚠️ Hóa đơn chi trả của đơn ${shortOrderId(order.id)} không đọc được từ kho lưu trữ.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  const caption =
    `🧾 <b>Hóa đơn chuyển tiền (Admin đã chi)</b>\n` +
    `📦 ${shortOrderId(order.id)} · ${STATUS_VI[order.status] || order.status}\n` +
    `👤 ${escapeHtml(customerLabel(order.customer))}${order.customer?.telegramId ? ` · 🆔 <code>${order.customer.telegramId}</code>` : ""}`;
  const isPdf = (evidence.mimeType || "").includes("pdf");
  try {
    if (isPdf) {
      await ctx.replyWithDocument(new InputFile(buffer, evidence.fileName || "payout_receipt.pdf"), {
        caption,
        parse_mode: "HTML"
      });
    } else {
      await ctx.replyWithPhoto(new InputFile(buffer), { caption, parse_mode: "HTML" });
    }
  } catch {
    await ctx.reply("⚠️ Không gửi được hóa đơn chi trả (tệp không hợp lệ hoặc quá lớn).").catch(() => {});
  }
}

/** Step 1 (preview, NO mutation) for incoming-money confirmation. */
export async function showPayPreview(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }

  setPendingFinancialAction(String(ctx.from?.id || ""), "confirm_payment", orderId);

  const text =
    `⚠️ <b>XÁC NHẬN ĐÃ NHẬN TIỀN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortOrderId(order.id)}\n\n` +
    `Khách cần chuyển:\n` +
    `<b>${escapeHtml(MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency))}</b>\n\n` +
    `Trạng thái hiện tại:\n` +
    `<b>${STATUS_VI[order.status] || order.status}</b>\n\n` +
    `Sau xác nhận:\n` +
    `<b>Chờ giải ngân (WAITING_PAYOUT)</b>`;

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", `ops:pay:confirm:${order.id}`)
    .row()
    .text("❌ HỦY", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Final confirmation: reload + verify state + authoritative transition. */
export async function confirmPayment(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.pendingFinancialAction?.action !== "confirm_payment" || session.pendingFinancialAction.orderId !== orderId) {
    await ctx.reply("⚠️ Phiên xác nhận đã hết hạn hoặc không hợp lệ. Vui lòng mở lại đơn hàng và xác nhận từ đầu.").catch(() => {});
    return;
  }

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (order.status !== "WAITING_ADMIN_VERIFY") {
    await ctx.reply(`⚠️ Đơn hàng đang ở trạng thái <b>${order.status}</b>, không thể xác nhận tiền.`, { parse_mode: "HTML" }).catch(() => {});
    clearPendingFinancialAction(adminId);
    return;
  }

  try {
    const updated = await OrderService.confirmPaymentReceived(orderId, adminId);
    clearPendingFinancialAction(adminId);

    const customer = updated.customer;
    if (customer) {
      await sendToCustomer(
        customer.telegramId,
        `✅ <b>ĐÃ XÁC NHẬN NHẬN TIỀN</b>\n\n` +
          `Đơn ${shortOrderId(updated.id)} đã được xác nhận tiền vào.\n` +
          `Số tiền nhận: <b>${escapeHtml(MoneyService.formatMoney(updated.targetAmount, updated.targetCurrency))}</b>.`
      );
    }

    await ctx.reply(
      `✅ <b>ĐÃ XÁC NHẬN NHẬN TIỀN</b>\n\n` +
        `📦 ${shortOrderId(updated.id)} → <b>Chờ giải ngân (WAITING_PAYOUT)</b>\n` +
        `💰 Cần chi trả: <b>${escapeHtml(MoneyService.formatMoney(updated.targetAmount, updated.targetCurrency))}</b>`,
      { parse_mode: "HTML" }
    );

    // Event-driven notifications — payout-ready ONLY when the order already
    // has a valid destination; otherwise Admin sees 🟡 awaiting customer
    // payout info and the customer is prompted to choose an account.
    if (shouldNotifyPayoutReady(updated)) {
      await notifyPayoutReady({ ...updated, customer: customer || order.customer });
    } else if (customer?.telegramId) {
      await notifyAwaitingPayoutInfo({ ...updated, customer: customer || order.customer });
      await sendPayoutDestinationPromptToCustomer(String(customer.telegramId), updated.id);
    }
  } catch (err: any) {
    await ctx.reply(`❌ Xác nhận thất bại: ${escapeHtml(err?.message || "Lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

/** "Chưa nhận được tiền" — never auto-cancels; keep pending + show options. */
export async function showNotReceived(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }

  const text =
    `❌ <b>CHƯA NHẬN ĐƯỢC TIỀN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortOrderId(order.id)}\n` +
    `💱 ${escapeHtml(MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency))}\n\n` +
    `Đơn hàng vẫn giữ nguyên trạng thái <b>${STATUS_VI[order.status] || order.status}</b>.\n` +
    `Bạn có thể nhắn khách kiểm tra lại giao dịch, hoặc quay lại đơn sau.`;

  const kb = new InlineKeyboard()
    .row().text("👤 Xem khách", `ops:customer:detail:${order.customerId}`)
    .row().text("📦 Xem đơn", `ops:order:detail:${order.id}`)
    .text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

/**
 * Payout preview (WAITING_PAYOUT). Informational only — the real mutation is
 * uploading the payout bill (OrderService.submitPayoutBill), because the
 * lifecycle has no separate "payout started" state.
 *
 * UX contract (payout hardening):
 * - 🟡 "Đã nhận tiền — chờ khách gửi TK/QR nhận" when NO valid destination.
 * - 💸 "Sẵn sàng payout" when a confirmed destination exists.
 * - The payout-evidence action is HIDDEN while not payout-ready (blocked).
 */
export async function showPayoutPreview(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (order.status !== "WAITING_PAYOUT") {
    await ctx.reply(`⚠️ Đơn hàng đang ở trạng thái <b>${order.status}</b>.`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const payout = order.payoutBankSnapshot as any;
  const payoutReady = OrderService.isPayoutReady(order as any);
  const lines = [
    payoutReady ? "💸 <b>SẴN SÀNG PAYOUT</b>" : "🟡 <b>ĐÃ NHẬN TIỀN — CHỜ KHÁCH GỬI TK/QR NHẬN</b>",
    "",
    customerIdentity(order.customer),
    `📦 ${shortOrderId(order.id)}`,
    `💰 Khách nhận: <b>${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}</b>`,
    ""
  ];
  if (payout && payoutReady) {
    if (payout.type === "qr") {
      lines.push(
        `🖱 Loại tài khoản nhận: <b>Ảnh QR</b>`,
        `✅ Khách đã xác nhận${payout.confirmedAt ? ` · ${formatAdminDateTime(payout.confirmedAt)}` : ""}`
      );
    } else {
      lines.push(
        `🏦 ${escapeHtml(payout.bankName || "")}`,
        `👤 ${escapeHtml(payout.accountName || "")}`,
        `💳 ${escapeHtml(maskAccountNumber(payout.accountNumber || ""))}`,
        `✅ Khách đã xác nhận${payout.confirmedAt ? ` · ${formatAdminDateTime(payout.confirmedAt)}` : ""}`
      );
    }
  } else {
    lines.push("⚠️ Khách CHƯA cung cấp tài khoản nhận tiền đã xác nhận.");
    lines.push("Đơn này CHƯA sẵn sàng payout — hãy nhắc khách gửi TK/QR nhận.");
  }
  lines.push(
    "",
    `Trạng thái hiện tại: <b>${STATUS_VI[order.status] || order.status}</b>`,
    "",
    "Sau khi chuyển tiền thật, gửi ảnh biên lai chi trả để chuyển đơn sang <b>Đã chi tiền (PAYOUT_SENT)</b>."
  );

  const kb = new InlineKeyboard();
  if (payoutReady) {
    kb.row().text("📎 Gửi bằng chứng payout", `ops:payout:evidence:${order.id}`);
  } else {
    kb.row().text("🔔 Nhắc khách gửi TK/QR", `ops:payout:nudge:${order.id}`);
  }
  kb.row().text("👤 Xem khách", `ops:customer:detail:${order.customerId}`)
    .text("🏠 Menu Admin", "ops:home");

  const sendPreview = async (): Promise<void> => {
    if (payoutReady && payout?.type === "qr" && payout.qrFilePath) {
      const qrBuffer = await FileService.getFile(payout.qrFilePath);
      if (qrBuffer) {
        await ctx.replyWithPhoto(new InputFile(qrBuffer), {
          caption: `🖼 QR nhận tiền của khách · đơn ${shortOrderId(order.id)}`
        });
      } else {
        await ctx.reply("⚠️ Không đọc được ảnh QR nhận tiền của khách.").catch(() => {});
      }
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
  };

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      await sendPreview();
      return;
    } catch {
      /* fall through */
    }
  }
  await sendPreview();
}

/** Enter per-admin payout-evidence mode for exactly one selected order. */
export async function startPayoutEvidence(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (order.status !== "WAITING_PAYOUT") {
    await ctx.reply(`⚠️ Đơn hàng đang ở trạng thái <b>${order.status}</b>.`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }
  // Payout action must be blocked without a confirmed payout destination.
  if (!OrderService.isPayoutReady(order as any)) {
    await ctx.reply(
      "🟡 <b>Chưa thể payout</b> — khách chưa gửi tài khoản/QR nhận tiền đã xác nhận. Dùng <b>🔔 Nhắc khách gửi TK/QR</b>.",
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

  setPayoutEvidenceSession(String(ctx.from?.id || ""), orderId);
  await ctx.reply(
    `📎 <b>GỬI BẰNG CHỨNG PAYOUT</b>\n\n` +
      `📦 ${shortOrderId(order.id)}\n` +
      `💰 ${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}\n\n` +
      `Gửi ảnh/biên lai chi trả vào khung chat này.\n` +
      `Bằng chứng sẽ gắn đúng vào đơn ${shortOrderId(order.id)} (chế độ riêng cho bạn).\n\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Consumes the next valid Admin photo/document when a payout-evidence session
 * is active. Returns true when handled (even on failure), so the router never
 * forwards a payout bill to a selected customer.
 */
export async function handleAdminPayoutEvidenceMedia(ctx: BotContext): Promise<boolean> {
  const telegramId = String(ctx.from?.id || "");
  const session = getAdminSession(telegramId);
  if (session.mode !== "payout_evidence" || !session.selectedOrderId) return false;

  const orderId = session.selectedOrderId;

  if (ctx.chat?.type !== "private") {
    clearAdminSession(telegramId);
    await ctx.reply("⛔ Gửi bằng chứng payout chỉ thực hiện trong chat riêng với bot.").catch(() => {});
    return true;
  }
  if (!(await requirePermission(ctx, "payout.approve"))) {
    clearAdminSession(telegramId);
    return true;
  }

  const order = await OrderService.getOrder(orderId);
  if (!order || order.status !== "WAITING_PAYOUT") {
    clearAdminSession(telegramId);
    await ctx.reply("⚠️ Đơn hàng không còn ở trạng thái chờ giải ngân.").catch(() => {});
    return true;
  }

  const photo = ctx.message?.photo;
  const doc = ctx.message?.document;
  let fileId: string | undefined;
  let mimeType = "image/jpeg";
  let ext = "jpg";
  if (photo && photo.length) {
    fileId = photo[photo.length - 1]?.file_id;
  } else if (doc) {
    fileId = doc.file_id;
    mimeType = doc.mime_type || "application/pdf";
    ext = doc.mime_type === "application/pdf" ? "pdf" : (doc.file_name?.split(".").pop() || "jpg");
  }
  if (!fileId) {
    clearAdminSession(telegramId);
    await ctx.reply("⚠️ Không tìm thấy tệp đính kèm.").catch(() => {});
    return true;
  }

  let buffer: Buffer;
  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải tệp thất bại (HTTP ${res.status})`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err: any) {
    clearAdminSession(telegramId);
    await ctx.reply(`❌ Không tải được tệp: ${escapeHtml(err?.message || "lỗi tải")}`, { parse_mode: "HTML" }).catch(() => {});
    return true;
  }

  try {
    const updated = await OrderService.submitPayoutBill(orderId, telegramId, buffer, `payout_${orderId}.${ext}`, mimeType);
    clearAdminSession(telegramId);
    // N — the CUSTOMER must receive the exact payout receipt that was stored.
    const receiptDelivered = await sendPayoutReceiptToCustomer(updated).catch(() => false);
    const kb = new InlineKeyboard().text("✅ Hoàn tất đơn", `ops:payout:complete:preview:${updated.id}`);
    await ctx.reply(
      `📤 <b>ĐÃ GHI NHẬN BẰNG CHỨNG CHI TRẢ</b>\n\n` +
        `📦 ${shortOrderId(updated.id)} → <b>Đã chi tiền (PAYOUT_SENT)</b>\n` +
        (receiptDelivered
          ? `📨 Hoá đơn đã gửi cho khách.\n`
          : `⚠️ KHÔNG gửi được hoá đơn cho khách — khách đã nhận thông báo "đã thanh toán"; vui lòng kiểm tra.\n`) +
        `Bấm <b>✅ Hoàn tất đơn</b> để kết thúc.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  } catch (err: any) {
    clearAdminSession(telegramId);
    await ctx.reply(`❌ Lưu bằng chứng thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
  return true;
}

/** Step 1 (preview, NO mutation) for finalizing a paid order. */
export async function showCompletePayoutPreview(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (order.status !== "PAYOUT_SENT") {
    await ctx.reply(`⚠️ Đơn hàng đang ở trạng thái <b>${order.status}</b>.`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  setPendingFinancialAction(String(ctx.from?.id || ""), "complete_payout", orderId);

  const text =
    `⚠️ <b>HOÀN TẤT ĐƠN HÀNG</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortOrderId(order.id)}\n` +
    `💰 ${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}\n\n` +
    `Trạng thái hiện tại: <b>Đã chi tiền (PAYOUT_SENT)</b>\n` +
    `Sau xác nhận: <b>Hoàn tất (COMPLETED)</b>`;

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", `ops:payout:complete:confirm:${order.id}`)
    .row()
    .text("❌ HỦY", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmCompletePayout(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.pendingFinancialAction?.action !== "complete_payout" || session.pendingFinancialAction.orderId !== orderId) {
    await ctx.reply("⚠️ Phiên hoàn tất đã hết hạn. Vui lòng mở lại đơn hàng.").catch(() => {});
    return;
  }

  const order = await OrderService.getOrder(orderId);
  if (!order || order.status !== "PAYOUT_SENT") {
    await ctx.reply("⚠️ Đơn hàng không còn ở trạng thái chờ hoàn tất.").catch(() => {});
    clearPendingFinancialAction(adminId);
    return;
  }

  try {
    const completed = await OrderService.completePayout(orderId, adminId);
    clearPendingFinancialAction(adminId);
    // O — localized completion + OPTIONAL rating (never blocks completion).
    await notifyOrderCompletedWithRating(completed).catch(() => {});
    await ctx.reply(`🎉 <b>ĐƠN HÀNG HOÀN TẤT</b>\n\n📦 ${shortOrderId(completed.id)} → <b>COMPLETED</b>`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ Hoàn tất thất bại: ${escapeHtml(err?.message || "Lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ===========================================================================
// Admin order cancellation (requirement B) — reason → preview → final confirm.
// Uses the SAME centralized OrderService rules as the customer flow and the
// scheduler (requirement L). Confirmed-money states are never simple-cancelled.
// ===========================================================================

/** Step 1: Admin opens cancel flow — free-form reason input (no presets). */
export async function showCancelReasonChoice(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  const decision = OrderService.canAdminCancel(order);
  if (!decision.allowed) {
    let hint: string;
    if (decision.code === "PAYOUT_SENT") {
      hint =
        "💸 Đơn này ĐÃ GIẢI NGÂN / đã chuyển tiền cho khách — KHÔNG thể huỷ trực tiếp. " +
        "Sử dụng luồng đối soát / xử lý thủ công nếu có sự cố.";
    } else if (decision.code === "COMPLETED") {
      hint = "✅ Đơn đã COMPLETED — không thể huỷ.";
    } else {
      hint =
        `⛔ Đơn ở trạng thái <b>${STATUS_VI[order.status] || order.status}</b> — ` +
        "hiện không thể huỷ trực tiếp.";
    }
    await ctx.reply(hint, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  startWizard(String(ctx.from?.id || ""), "order_cancel_reason", { orderId });
  await ctx.reply(
    `❌ <b>HUỶ ĐƠN ${shortOrderId(order.id)}</b>\n\n` +
      `${customerIdentity(order.customer)}\n` +
      `📍 Trạng thái: <b>${STATUS_VI[order.status] || order.status}</b>\n\n` +
      `✍️ Nhập <b>lý do hủy đơn</b> (tự do, 3–300 ký tự):\nGửi /cancel để thoát.`,
    { parse_mode: "HTML" }
  );
}

/** Reason input (wizard-bound, one admin at a time). Free-form only (A2). */
export async function handleCancelReasonInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "order_cancel_reason") return false;
  const orderId = String(session.wizard.data?.orderId || "");
  const reason = sanitizeAdminCancelReason(text);
  if (orderId && reason && reason.length >= 3) {
    clearWizard(adminId);
    await showCancelPreview(ctx, orderId, reason);
  } else {
    await ctx.reply("⚠️ Lý do phải từ 3 đến 300 ký tự (không ký tự điều khiển). Gửi lại lý do, hoặc /cancel để thoát.").catch(() => {});
  }
  return true;
}

/** Step 2: preview (NO mutation) with the free-form reason + payment/payout flags. */
async function showCancelPreview(ctx: BotContext, orderId: string, reason: string): Promise<void> {
  const adminId = String(ctx.from?.id || "");
  // Reload the authoritative order BEFORE showing the preview.
  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  const decision = OrderService.canAdminCancel(order);
  if (!decision.allowed) {
    await ctx.reply("⛔ Đơn không còn ở trạng thái có thể huỷ.", { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const sanitized = sanitizeAdminCancelReason(reason) || reason;
  // Persist the reason with the pending action so the final confirm is
  // self-contained (and stale/expired confirmations are rejected).
  setPendingAction(adminId, "cancel_order", orderId, { reason: sanitized });

  const verified = incomingPaymentVerified(order);
  const payoutSent = payoutSentEvidence(order);
  const warning = verified
    ? "⚠️ <b>Đơn này đã ghi nhận thanh toán từ khách.</b>\nNếu hủy, khoản tiền đã nhận cần được xử lý hoàn trả/thủ công.\n\n"
    : "";

  const text =
    `⚠️ <b>XEM TRƯỚC KHI HUỶ ĐƠN</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 Mã: ${shortOrderId(order.id)}\n` +
    `💱 ${escapeHtml(MoneyService.formatMoney(order.sourceAmount, order.sourceCurrency))} → ${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}\n` +
    `📍 Trạng thái: <b>${STATUS_VI[order.status] || order.status}</b>\n` +
    `💵 Thanh toán đã xác nhận: <b>${verified ? "CÓ" : "KHÔNG"}</b>\n` +
    `💸 Payout đã gửi: <b>${payoutSent ? "CÓ" : "KHÔNG"}</b>\n` +
    `📝 Lý do: <b>${escapeHtml(sanitized)}</b>\n\n` +
    warning +
    `Xác nhận huỷ?`;

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN HUỶ ĐƠN", `ops:cancel:confirm:${order.id}`)
    .row()
    .text("❌ KHÔNG huỷ", `ops:order:detail:${order.id}`);

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Step 3: final confirmation — reload + re-verify + authoritative cancel. */
async function confirmCancelOrder(ctx: BotContext, orderId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const adminId = String(ctx.from?.id || "");
  // Reject stale callbacks: the preview (with reason) must still be pending.
  const pending = consumePendingAction(adminId, "cancel_order", orderId);
  if (!pending.valid) {
    await ctx.reply(
      pending.expired
        ? "⚠️ Phiên xác nhận huỷ đã hết hạn. Vui lòng mở lại đơn hàng và chọn lý do từ đầu."
        : "⚠️ Không có yêu cầu huỷ nào đang chờ. Hãy bấm ❌ Huỷ đơn trong chi tiết đơn.",
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }
  const reason = String(pending.data?.reason || "ADMIN_CANCELLED");

  // Reload the AUTHORITATIVE order right before mutating.
  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (!OrderService.canAdminCancel(order).allowed) {
    await ctx.reply("⛔ Đơn không còn ở trạng thái có thể huỷ (có thể đã thay đổi sau khi xem trước).", { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  try {
    // Audit source distinguishes UNPAID vs AFTER-PAYMENT cancels (A4).
    const source = adminCancelSource(order);
    const verified = incomingPaymentVerified(order);
    const updated = await OrderService.cancelOrder(orderId, adminId, "ADMIN", reason, {
      source,
      metadata: { adminTelegramId: adminId, paymentVerified: verified }
    });

    // Localized customer notice (safe wording — money may already have moved).
    // NEVER claims a refund — only a neutral "recorded, staff will handle it".
    const customer = updated?.customer || order.customer;
    if (customer?.telegramId) {
      const locale = resolveLocale(customer.language);
      let notice = t(locale, "order.cancelled_by_admin", { id: orderId, reason });
      if (verified) {
        notice += "\n\n" + t(locale, "order.cancelled_by_admin_payment_note");
      }
      await sendToCustomer(
        String(customer.telegramId),
        notice,
        { parse_mode: "HTML" }
      );
    }

    // Vietnamese Admin audit notification (actor + reason, no bank contents).
    await notifyOrderCancelledByAdmin(
      { ...(updated || order), customer },
      `Admin ${adminId}`,
      reason
    );

    await ctx.reply(
      `❌ <b>ĐÃ HUỶ ĐƠN ${shortOrderId(orderId)}</b>\n📝 Lý do: ${escapeHtml(reason)}\n🔖 Nguồn ghi nhận: ${source}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ Huỷ thất bại: ${escapeHtml(err?.message || "Lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ===========================================================================
// J — Review-state resolution (SUSPICIOUS / MANUAL_REVIEW / PAYMENT_MISMATCH).
// Uses the audited manualFinancialOverride: preview → final confirm, strict
// actor+reason audit, original evidence/risk flags preserved in history.
// ===========================================================================

const REVIEW_CONFIRM_REASON = "Admin xác nhận đã nhận tiền sau kiểm tra thủ công (bằng chứng hợp lệ)";
const REVIEW_NOTRECEIVED_REASON = "Admin xác nhận CHƯA nhận tiền sau kiểm tra thủ công — huỷ giữ nguyên bằng chứng";

function reviewKeyboard(orderId: string, kind: "confirm" | "notreceived"): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ XÁC NHẬN THỰC HIỆN", `ops:review:${kind}:go:${orderId}`)
    .row()
    .text("❌ KHÔNG", `ops:order:detail:${orderId}`);
}

async function showReviewResolvePreview(ctx: BotContext, orderId: string, kind: "confirm" | "notreceived"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);

  const order = await OrderService.getOrder(orderId);
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (!["MANUAL_REVIEW", "SUSPICIOUS", "PAYMENT_MISMATCH", "CUSTOMER_SENT_BILL"].includes(order.status)) {
    await ctx.reply(`⚠️ Đơn không còn ở trạng thái xem xét (hiện tại: <b>${STATUS_VI[order.status] || order.status}</b>).`, { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  const text =
    `⚠️ <b>${kind === "confirm" ? "XÁC NHẬN TIỀN SAU KIỂM TRA" : "CHƯA NHẬN TIỀN — GIỮ BẰNG CHỨNG, HUỶ ĐƠN"}</b>\n\n` +
    `${customerIdentity(order.customer)}\n` +
    `📦 ${shortOrderId(order.id)}\n` +
    `📷 Bill: ${hasCustomerBillEvidence(order) ? "CÓ (giữ nguyên trong kho lưu trữ)" : "Không"}\n` +
    `📍 Hiện tại: <b>${STATUS_VI[order.status] || order.status}</b>\n\n` +
    (kind === "confirm"
      ? `Sau xác nhận: <b>Chờ giải ngân (WAITING_PAYOUT)</b> — khách sẽ được hỏi tài khoản nhận tiền.\n`
      : `Sau xác nhận: <b>Đã huỷ (CANCELLED)</b> — mọi bằng chứng/cờ rủi ro được GIỮ NGUYÊN trong lịch sử.\n`) +
    `📝 Lý do ghi vào audit: <i>${kind === "confirm" ? REVIEW_CONFIRM_REASON : REVIEW_NOTRECEIVED_REASON}</i>\n\n` +
    `Xác nhận thực hiện?`;

  const kb = reviewKeyboard(orderId, kind);
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

async function confirmReviewResolve(ctx: BotContext, orderId: string, kind: "confirm" | "notreceived"): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment.verify"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);
  const adminId = String(ctx.from?.id || "");

  const order = await OrderService.getOrder(orderId);
  if (!order || !["MANUAL_REVIEW", "SUSPICIOUS", "PAYMENT_MISMATCH", "CUSTOMER_SENT_BILL"].includes(order.status)) {
    await ctx.reply("⚠️ Đơn không còn ở trạng thái xem xét — không thể can thiệp.").catch(() => {});
    return;
  }

  try {
    const updated = await OrderService.manualFinancialOverride({
      orderId,
      actorId: adminId,
      actorRole: "ADMIN",
      targetStatus: kind === "confirm" ? "WAITING_PAYOUT" : "CANCELLED",
      reason: kind === "confirm" ? REVIEW_CONFIRM_REASON : REVIEW_NOTRECEIVED_REASON
    });

    const customer = updated?.customer || order.customer;
    if (kind === "confirm") {
      if (customer?.telegramId) {
        const locale = resolveLocale(customer.language);
        await sendToCustomer(String(customer.telegramId), t(locale, "payout.verified_prompt", { id: order.id }), { parse_mode: "HTML" });
      }
      await notifyAwaitingPayoutInfo(updated).catch(() => {});
    } else if (customer?.telegramId) {
      const locale = resolveLocale(customer.language);
      await sendToCustomer(String(customer.telegramId), t(locale, "order.cancelled_by_admin", { id: orderId, reason: "Kiểm tra thanh toán không thành công" }), { parse_mode: "HTML" }).catch(() => {});
    }

    await ctx.reply(
      `✅ <b>ĐÃ XỬ LÝ ${shortOrderId(orderId)}</b> → <b>${kind === "confirm" ? "WAITING_PAYOUT" : "CANCELLED"}</b>\n📝 Lý do + actor đã ghi audit; bằng chứng giữ nguyên.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } catch (err: any) {
    await ctx.reply(`❌ Can thiệp thất bại: ${escapeHtml(err?.message || "Lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

adminActionsHandler.callbackQuery(/^ops:review:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => showReviewResolvePreview(ctx, ctx.match?.[1] || "", "confirm"));
adminActionsHandler.callbackQuery(/^ops:review:notreceived:([a-zA-Z0-9_-]+)$/, (ctx) => showReviewResolvePreview(ctx, ctx.match?.[1] || "", "notreceived"));
adminActionsHandler.callbackQuery(/^ops:review:confirm:go:([a-zA-Z0-9_-]+)$/, (ctx) => confirmReviewResolve(ctx, ctx.match?.[1] || "", "confirm"));
adminActionsHandler.callbackQuery(/^ops:review:notreceived:go:([a-zA-Z0-9_-]+)$/, (ctx) => confirmReviewResolve(ctx, ctx.match?.[1] || "", "notreceived"));

adminActionsHandler.callbackQuery(/^ops:cancel:reason:(.+)$/, (ctx) => showCancelReasonChoice(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:cancel:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => confirmCancelOrder(ctx, ctx.match?.[1] || ""));

adminActionsHandler.callbackQuery(/^ops:bill:view:(.+)$/, (ctx) => showBillView(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:view:([a-zA-Z0-9_-]+)$/, (ctx) => showPayoutEvidenceView(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:preview:(.+)$/, (ctx) => showPayPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:confirm:(.+)$/, (ctx) => confirmPayment(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:not_received:(.+)$/, (ctx) => showNotReceived(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:preview:(.+)$/, (ctx) => showPayoutPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:evidence:(.+)$/, (ctx) => startPayoutEvidence(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:nudge:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const orderId = ctx.match?.[1] || "";
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  const order = await OrderService.getOrder(orderId);
  if (!order || order.status !== "WAITING_PAYOUT" || OrderService.isPayoutReady(order as any)) {
    await ctx.reply("⚠️ Đơn không còn ở trạng thái chờ khách gửi TK/QR.").catch(() => {});
    return;
  }
  const customer = order.customer;
  if (!customer?.telegramId) {
    await ctx.reply("⚠️ Không có Telegram ID của khách để gửi yêu cầu.").catch(() => {});
    return;
  }
  const sent = await sendPayoutDestinationPromptToCustomer(String(customer.telegramId), orderId);
  await ctx.reply(
    sent
      ? `🔔 <b>Đã gửi yêu cầu cho khách</b> — đơn ${shortOrderId(orderId)}: khách sẽ chọn tài khoản/QR nhận tiền.`
      : "⚠️ Không gửi được tin nhắn cho khách (có thể khách đã chặn bot).",
    { parse_mode: "HTML" }
  ).catch(() => {});
});
adminActionsHandler.callbackQuery(/^ops:payout:complete:preview:(.+)$/, (ctx) => showCompletePayoutPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:complete:confirm:(.+)$/, (ctx) => confirmCompletePayout(ctx, ctx.match?.[1] || ""));

// 7 — Receipt resend (operational, non-financial):
// reload Order → require stored payout evidence → FileService read → send the
// EXACT stored receipt. Changes NO amounts, NO Order state, NO payout; safe
// even after COMPLETED. Private Admin only; attempt + result audited.
adminActionsHandler.callbackQuery(/^ops:receipt:resend:([a-zA-Z0-9_-]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payout.approve"))) return;
  if (!isPrivate(ctx)) return denyNotPrivate(ctx);
  const adminId = String(ctx.from?.id || "");
  const order = await OrderService.getOrder(ctx.match?.[1] || "");
  if (!order) {
    await ctx.reply("❌ Không tìm thấy đơn hàng.").catch(() => {});
    return;
  }
  if (!order.payoutBillFileId) {
    await ctx.reply("⚠️ Đơn không có hoá đơn chi trả nào đã lưu.").catch(() => {});
    return;
  }
  const delivered = await sendPayoutReceiptToCustomer(order).catch(() => false);
  try {
    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PAYOUT_RECEIPT_RESEND",
      targetType: "ORDER",
      targetId: order.id,
      details: { delivered, payoutBillFileId: order.payoutBillFileId }
    });
  } catch {
    // audit best-effort; delivery result is still reported to the Admin
  }
  await ctx.reply(
    delivered
      ? `✅ Đã gửi lại hoá đơn cho khách (đơn ${shortOrderId(order.id)}).`
      : `⚠️ KHÔNG gửi được hoá đơn cho khách (đơn ${shortOrderId(order.id)}). Trạng thái tài chính không đổi; kiểm tra kết nối/khách block bot.`,
    { parse_mode: "HTML" }
  ).catch(() => {});
});



