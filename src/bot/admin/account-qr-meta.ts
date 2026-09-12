/**
 * Dynamic Payment QR V1 — Admin QR-metadata configuration (own composer so it
 * stays isolated from the locked admin-accounts module).
 * VND account: STATIC | VIETQR (bank BIN). USD account: STATIC | KHQR
 * (INDIVIDUAL | MERCHANT). Preview → confirm before save; audit-logged via
 * PaymentAccountService.updateQrMetadata. Static QR upload remains available.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { PaymentAccountService } from "../../modules/payment-accounts/account-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard, updateWizard } from "./admin-session.js";

export const accountQrMetaHandler = new Composer<BotContext>();

function buildQrMetaPreview(data: Record<string, any>): string {
  const provider = String(data.qrProvider || "");
  if (provider === "VIETQR") {
    return (
      `⚠️ <b>XEM TRƯỚC CẤU HÌNH QR (VietQR)</b>\n\n` +
      `📍 Loại: <b>VIETQR (động)</b>\n` +
      `🏦 Bank BIN: <code>${escapeHtml(String(data.bankBin || ""))}</code>\n` +
      `💳 Số TK: <code>${escapeHtml(String(data.accountNumber || ""))}</code>\n\n` +
      `Xác nhận lưu?`
    );
  }
  const lines = [
    `⚠️ <b>XEM TRƯỚC CẤU HÌNH QR (KHQR — ${escapeHtml(String(data.khqrMode || ""))})</b>\n\n`,
    `🆔 Bakong ID: <code>${escapeHtml(String(data.khqrBakongAccountId || ""))}</code>`,
    `👤 Tên: <code>${escapeHtml(String(data.khqrMerchantName || ""))}</code>`,
    `🏙 Thành phố: <code>${escapeHtml(String(data.khqrMerchantCity || ""))}</code>`
  ];
  if (data.khqrMode === "MERCHANT") {
    lines.push(`🏪 Merchant ID: <code>${escapeHtml(String(data.khqrMerchantId || ""))}</code>`);
    lines.push(`🏦 Ngân hàng thu hộ: <code>${escapeHtml(String(data.khqrAcquiringBank || ""))}</code>`);
  }
  lines.push("", `Xác nhận lưu?`);
  return lines.join("\n");
}

export async function showAccountQrMetaList(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const accounts = await PaymentAccountService.getAllAccounts();
  const lines = ["🧩 <b>CẤU HÌNH QR ĐỘNG (theo đơn)</b>", ""];
  const kb = new InlineKeyboard();
  if (accounts.length === 0) {
    lines.push("Chưa có tài khoản nhận tiền nào.");
  } else {
    for (const a of accounts) {
      const provider = a.qrProvider || "STATIC";
      const icon = provider === "KHQR" ? "🇰🇭" : provider === "VIETQR" ? "🇻🇳" : "⚪️";
      lines.push(`${icon} ${escapeHtml(a.bankName)} (${a.currency}) · <b>${escapeHtml(provider)}</b>`);
      kb.text(`${icon} ${a.bankName} (${a.currency})`, `ops:qrmeta:edit:${a.id}`).row();
    }
  }
  kb.row().text("🏠 Menu Admin", "ops:home");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

export async function showAccountQrMetaEdit(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  const isUsd = a.currency === "USD";
  const kb = new InlineKeyboard()
    .text("⚪️ STATIC (QR tĩnh)", `ops:qrmeta:static:go:${accountId}`)
    .row();
  if (isUsd) {
    kb.text("🇰🇭 KHQR — INDIVIDUAL", `ops:qrmeta:wizard:khqr_individual:${accountId}`)
      .text("🏛 KHQR — MERCHANT", `ops:qrmeta:wizard:khqr_merchant:${accountId}`)
      .row();
  } else {
    kb.text("🇻🇳 VIETQR (động)", `ops:qrmeta:wizard:vietqr:${accountId}`).row();
  }
  kb.text("⬅️ Danh sách", "ops:qrmeta");
  await ctx.reply(
    `⚙️ <b>CẤU HÌNH QR — ${escapeHtml(a.bankName)} (${a.currency})</b>\n\n` +
      `Hiện tại: <b>${escapeHtml(a.qrProvider || "STATIC")}</b>\n\n` +
      `Chọn loại QR cho tài khoản nhận tiền:\n` +
      `• ⚪️ STATIC: ảnh QR tĩnh đã tải lên (mặc định)\n` +
      (isUsd
        ? `• 🇰🇭 KHQR: QR động theo đơn (USD) — Bakong; encode amount + memo\n`
        : `• 🇻🇳 VIETQR: QR động theo đơn (VND) — NAPAS; purpose = memo\n`),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

export async function startAccountQrMetaWizard(ctx: BotContext, kind: string, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  startWizard(String(ctx.from?.id || ""), `qrmeta_${kind}`, { accountId, step: 1, accountNumber: a.accountNumber });
  if (kind === "vietqr") {
    await ctx.reply(
      `🏦 <b>Nhập BANK BIN</b> cho tài khoản VND (4–6 chữ số, theo NAPAS).\n` +
        `Ví dụ: <code>970436</code> (Vietcombank)\nGửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.reply(
      `🆔 <b>Nhập Bakong Account ID</b> (định dạng <code>tên@nganhang</code>).\n` +
        `Ví dụ: <code>exchange@aclb</code>\nGửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
  }
}

/** Sequential multi-step wizard input for the QR metadata flows. */
export async function handleAccountQrMetaInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || !wizard.kind.startsWith("qrmeta_")) return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  const data = wizard.data;
  const kind = wizard.kind.replace("qrmeta_", "");

  if (kind === "vietqr") {
    const bankBin = text.trim();
    if (!/^\d{4,6}$/.test(bankBin)) {
      await ctx.reply("❌ Bank BIN phải là 4–6 chữ số. Nhập lại, hoặc /cancel.").catch(() => {});
      return true;
    }
    updateWizard(adminId, { data: { bankBin } });
    const kb = new InlineKeyboard()
      .text("✅ LƯU", `ops:qrmeta:confirm:${data.accountId}`)
      .row()
      .text("❌ HỦY", "ops:qrmeta");
    await ctx.reply(
      `⚠️ <b>XEM TRƯỚC CẤU HÌNH QR (VietQR)</b>\n\n` +
        `📍 Loại: <b>VIETQR (động)</b>\n` +
        `🏦 Bank BIN: <code>${bankBin}</code>\n` +
        `💳 Số TK: <code>${data.accountNumber || ""}</code>\n\n` +
        `Xác nhận lưu?`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return true;
  }

  // KHQR sequences
  const fieldOrder =
    kind === "khqr_individual"
      ? ["khqrBakongAccountId", "khqrMerchantName", "khqrMerchantCity"]
      : ["khqrBakongAccountId", "khqrMerchantName", "khqrMerchantCity", "khqrMerchantId", "khqrAcquiringBank"];
  const fieldLabels: Record<string, string> = {
    khqrBakongAccountId: "Bakong Account ID (tên@nganhang)",
    khqrMerchantName: "Tên chủ TK/merchant",
    khqrMerchantCity: "Thành phố",
    khqrMerchantId: "Merchant ID",
    khqrAcquiringBank: "Ngân hàng thu hộ (acquiring bank)"
  };
  const idx = Number(data.step || 1) - 1;
  const field = fieldOrder[idx];
  if (!field) return true;
  const value = text.trim();
  if (value.length < 2) {
    await ctx.reply(`❌ Giá trị ${fieldLabels[field]} quá ngắn. Nhập lại, hoặc /cancel.`).catch(() => {});
    return true;
  }
  updateWizard(adminId, { data: { [field]: value, step: idx + 2 } });
  const nextField = fieldOrder[idx + 1];
  if (nextField) {
    await ctx.reply(`✍️ Nhập <b>${fieldLabels[nextField]}</b>:`, { parse_mode: "HTML" }).catch(() => {});
    return true;
  }

  const previewData: Record<string, any> = { ...data, qrProvider: data.khqrMode || "MERCHANT" };
  const kb = new InlineKeyboard()
    .text("✅ LƯU", `ops:qrmeta:confirm:${data.accountId}`)
    .row()
    .text("❌ HỦY", "ops:qrmeta");
  await ctx.reply(buildQrMetaPreview(previewData), { parse_mode: "HTML", reply_markup: kb });
  return true;
}

export async function confirmAccountQrMeta(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || !wizard.kind.startsWith("qrmeta_") || String(wizard.data.accountId || "") !== accountId) {
    await ctx.reply("⚠️ Không có phiên cấu hình QR hợp lệ. Mở lại từ 🧩 Cấu hình QR.").catch(() => {});
    return;
  }
  const d = wizard.data;
  try {
    const updated = await PaymentAccountService.updateQrMetadata({
      accountId,
      actorId: adminId,
      qrProvider: String(d.qrProvider || "STATIC"),
      bankBin: d.bankBin ?? null,
      khqrMode: d.khqrMode ?? null,
      khqrBakongAccountId: d.khqrBakongAccountId ?? null,
      khqrMerchantName: d.khqrMerchantName ?? null,
      khqrMerchantCity: d.khqrMerchantCity ?? null,
      khqrMerchantId: d.khqrMerchantId ?? null,
      khqrAcquiringBank: d.khqrAcquiringBank ?? null
    });
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ LƯU CẤU HÌNH QR</b>\n🏦 ${escapeHtml(updated.bankName)} (${updated.currency}) → ` +
        `<b>${escapeHtml(String(updated.qrProvider))}</b>\nĐơn mới sẽ dùng QR động theo cấu hình này.`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function confirmAccountQrMetaStatic(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  try {
    const updated = await PaymentAccountService.updateQrMetadata({
      accountId,
      actorId: String(ctx.from?.id || ""),
      qrProvider: "STATIC"
    });
    await ctx.reply(
      `✅ <b>QR TĨNH</b> — ${escapeHtml(updated.bankName)} (${updated.currency}) tiếp tục dùng ảnh QR tĩnh đã tải lên.`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

accountQrMetaHandler.callbackQuery("ops:qrmeta", (ctx) => showAccountQrMetaList(ctx));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:edit:([a-zA-Z0-9_-]+)$/, (ctx) => showAccountQrMetaEdit(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:wizard:(vietqr|khqr_individual|khqr_merchant):([a-zA-Z0-9_-]+)$/, (ctx) =>
  startAccountQrMetaWizard(ctx, ctx.match?.[1] || "", ctx.match?.[2] || "")
);
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:static:go:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMetaStatic(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMeta(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.command("qrmeta", (ctx) => showAccountQrMetaList(ctx));
