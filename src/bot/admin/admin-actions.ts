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
import { sendToCustomer, notifyPayoutReady, isPayoutReadyTransition } from "../notifications.js";
import { escapeHtml, STATUS_VI } from "../menus/cskh-panel.js";
import { customerLabel, shortOrderId } from "./admin-panel.js";
import { clearAdminSession, clearPendingFinancialAction, getAdminSession, setPendingFinancialAction, setPayoutEvidenceSession } from "./admin-session.js";

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

  const billFileId = order.customerBillFileId || order.payoutBillFileId;
  if (!billFileId) {
    await ctx.reply(`📷 Đơn ${shortOrderId(order.id)} chưa có biên lai nào.`).catch(() => {});
    return;
  }

  const evidence = await prisma.fileEvidence.findUnique({ where: { id: billFileId } });
  if (!evidence || !evidence.filePath) {
    await ctx.reply("⚠️ Không thể truy cập biên lai này (thiếu dữ liệu lưu trữ).").catch(() => {});
    return;
  }

  const buffer = await FileService.getFile(evidence.filePath);
  if (!buffer) {
    await ctx.reply("⚠️ Không tìm thấy tệp biên lai trong kho lưu trữ.").catch(() => {});
    return;
  }

  const caption = `📷 Biên lai cho đơn ${shortOrderId(order.id)} · ${STATUS_VI[order.status] || order.status}`;
  const isPdf = (evidence.mimeType || "").includes("pdf");
  try {
    if (isPdf) {
      await ctx.replyWithDocument(new InputFile(buffer, evidence.fileName || "bill.pdf"), { caption });
    } else {
      await ctx.replyWithPhoto(new InputFile(buffer), { caption });
    }
  } catch {
    await ctx.reply("⚠️ Không gửi được biên lai (tệp không hợp lệ hoặc quá lớn).").catch(() => {});
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
    `👤 ${escapeHtml(customerLabel(order.customer))}\n` +
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
          `Chúng tôi đang chuyển <b>${escapeHtml(MoneyService.formatMoney(updated.targetAmount, updated.targetCurrency))}</b> tới tài khoản của bạn.`
      );
    }

    await ctx.reply(
      `✅ <b>ĐÃ XÁC NHẬN NHẬN TIỀN</b>\n\n` +
        `📦 ${shortOrderId(updated.id)} → <b>Chờ giải ngân (WAITING_PAYOUT)</b>\n` +
        `💰 Cần chi trả: <b>${escapeHtml(MoneyService.formatMoney(updated.targetAmount, updated.targetCurrency))}</b>`,
      { parse_mode: "HTML" }
    );

    // Event-driven payout-ready notification for authorized admins — only
    // after a real first transition into WAITING_PAYOUT.
    if (isPayoutReadyTransition(updated?.status)) {
      await notifyPayoutReady({ ...updated, customer: customer || order.customer });
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
    `👤 ${escapeHtml(customerLabel(order.customer))}\n` +
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
  const lines = [
    `⚠️ <b>XÁC NHẬN PAYOUT</b>`,
    "",
    `👤 ${escapeHtml(customerLabel(order.customer))}`,
    `📦 ${shortOrderId(order.id)}`,
    `💰 Khách nhận: <b>${escapeHtml(MoneyService.formatMoney(order.targetAmount, order.targetCurrency))}</b>`,
    ""
  ];
  if (payout) {
    lines.push(
      `🏦 ${escapeHtml(payout.bankName || "")}`,
      `👤 ${escapeHtml(payout.accountName || "")}`,
      `💳 ${escapeHtml(payout.accountNumber || "")}`
    );
  } else {
    lines.push("⚠️ Khách chưa cung cấp tài khoản nhận tiền.");
  }
  lines.push(
    "",
    `Trạng thái hiện tại: <b>${STATUS_VI[order.status] || order.status}</b>`,
    "",
    "Sau khi chuyển tiền thật, gửi ảnh biên lai chi trả để chuyển đơn sang <b>Đã chi tiền (PAYOUT_SENT)</b>."
  );

  const kb = new InlineKeyboard()
    .row().text("📎 Gửi bằng chứng payout", `ops:payout:evidence:${order.id}`)
    .row().text("👤 Xem khách", `ops:customer:detail:${order.customerId}`)
    .text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
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
    const kb = new InlineKeyboard().text("✅ Hoàn tất đơn", `ops:payout:complete:preview:${updated.id}`);
    await ctx.reply(
      `📤 <b>ĐÃ GHI NHẬN BẰNG CHỨNG CHI TRẢ</b>\n\n` +
        `📦 ${shortOrderId(updated.id)} → <b>Đã chi tiền (PAYOUT_SENT)</b>\n` +
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
    `👤 ${escapeHtml(customerLabel(order.customer))}\n` +
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
    const customer = completed.customer;
    if (customer) {
      await sendToCustomer(
        customer.telegramId,
        `🎉 <b>GIAO DỊCH HOÀN TẤT!</b>\n\nĐơn ${shortOrderId(completed.id)} đã hoàn tất. Cảm ơn bạn đã sử dụng dịch vụ!`
      );
    }
    await ctx.reply(`🎉 <b>ĐƠN HÀNG HOÀN TẤT</b>\n\n📦 ${shortOrderId(completed.id)} → <b>COMPLETED</b>`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ Hoàn tất thất bại: ${escapeHtml(err?.message || "Lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

adminActionsHandler.callbackQuery(/^ops:bill:view:(.+)$/, (ctx) => showBillView(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:preview:(.+)$/, (ctx) => showPayPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:confirm:(.+)$/, (ctx) => confirmPayment(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:pay:not_received:(.+)$/, (ctx) => showNotReceived(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:preview:(.+)$/, (ctx) => showPayoutPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:evidence:(.+)$/, (ctx) => startPayoutEvidence(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:complete:preview:(.+)$/, (ctx) => showCompletePayoutPreview(ctx, ctx.match?.[1] || ""));
adminActionsHandler.callbackQuery(/^ops:payout:complete:confirm:(.+)$/, (ctx) => confirmCompletePayout(ctx, ctx.match?.[1] || ""));



