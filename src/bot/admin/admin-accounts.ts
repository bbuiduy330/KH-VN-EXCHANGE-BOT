/**
 * Admin payment-account management (SYSTEM receiving accounts only — never
 * customer payout destinations). Uses authoritative PaymentAccountService.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { PaymentAccountService } from "../../modules/payment-accounts/account-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { env } from "../../config/env.js";
import { maskAccountNumber } from "./admin-panel.js";
import { clearWizard, consumePendingAction, getAdminSession, isSessionExpired, setPendingAction, startWizard, updateWizard } from "./admin-session.js";

export const adminAccountsHandler = new Composer<BotContext>();

const ACCOUNT_CURRENCIES = ["USD", "VND"];

export async function showAccountsList(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "payment_account.view"))) return;
  const accounts = await PaymentAccountService.getAllAccounts();
  const lines = ["🏦 <b>TÀI KHOẢN THANH TOÁN (NHẬN TIỀN)</b>", ""];
  const kb = new InlineKeyboard();
  if (accounts.length === 0) {
    lines.push("Chưa có tài khoản nhận nào.");
  } else {
    for (const a of accounts) {
      lines.push(
        `• <b>${escapeHtml(a.bankName)}</b> · 💵 ${escapeHtml(a.currency)} · 💳 ${escapeHtml(maskAccountNumber(a.accountNumber))} · ${a.isActive ? "🟢" : "⚪"}`
      );
      kb.row().text(`👁 ${escapeHtml(a.bankName)}`, `ops:account:detail:${a.id}`);
    }
  }
  kb.row().text("➕ Thêm tài khoản", "ops:account:add").text("🏠 Menu Admin", "ops:home");
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}

export async function showAccountDetail(ctx: BotContext, accountId: string): Promise<void> {
  if (!(await requirePermission(ctx, "payment_account.view"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  const text =
    `🏦 <b>TÀI KHOẢN NHẬN TIỀN</b>\n\n` +
    `Ngân hàng: <b>${escapeHtml(a.bankName)}</b>\n` +
    `Tiền tệ: ${escapeHtml(a.currency)}\n` +
    `Chủ tài khoản: ${escapeHtml(a.accountName)}\n` +
    `Số tài khoản: <code>${escapeHtml(maskAccountNumber(a.accountNumber))}</code>\n` +
    `Trạng thái: ${a.isActive ? "🟢 Đang hoạt động" : "⚪ Tạm ngưng"}\n` +
    `Mặc định: ${a.isDefault ? "⭐ Có" : "—"} · Ưu tiên: ${a.priority}\n` +
    `QR: ${a.qrFilePath ? `✅ có · v${a.qrVersion}` : "— chưa có"}\n`;

  const kb = new InlineKeyboard()
    .row().text("🖼 Cập nhật QR", `ops:account:qr:${a.id}`)
    .row().text("⭐ Đặt mặc định", `ops:account:default:preview:${a.id}`)
    .text("↕️ Ưu tiên", `ops:account:priority:${a.id}`)
    .row().text(a.isActive ? "⚪ Ngừng sử dụng" : "🟢 Kích hoạt", `ops:account:toggle:preview:${a.id}`)
    .row().text("⬅️ Quay lại", "ops:accounts").text("🏠 Menu Admin", "ops:home");

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

// ---------------------------------------------------------------------------
// Add account wizard (multi-step, preview before save)
// ---------------------------------------------------------------------------

export async function startAccountAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  startWizard(String(ctx.from?.id || ""), "account_add", {});
  await ctx.reply(
    `🏦 <b>THÊM TÀI KHOẢN — BƯỚC 1/5</b>\n\nNhập tên ngân hàng/nhà cung cấp (ví dụ: Vietcombank).\n\nGửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

export async function handleAccountWizardInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard || wizard.kind !== "account_add") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên thêm tài khoản đã hết hạn.").catch(() => {});
    return true;
  }

  const step = wizard.step;
  const value = text.trim();
  if (!value) {
    await ctx.reply("Vui lòng nhập giá trị hợp lệ.").catch(() => {});
    return true;
  }

  if (step === 1) {
    updateWizard(adminId, { step: 2, data: { bankName: value } });
    await ctx.reply(`💵 <b>BƯỚC 2/5</b>\n\nNhập loại tiền tệ (${ACCOUNT_CURRENCIES.join(" hoặc ")}):`).catch(() => {});
  } else if (step === 2) {
    const cur = value.toUpperCase();
    if (!ACCOUNT_CURRENCIES.includes(cur)) {
      await ctx.reply(`❌ Chỉ hỗ trợ ${ACCOUNT_CURRENCIES.join(" hoặc ")}.`).catch(() => {});
      return true;
    }
    updateWizard(adminId, { step: 3, data: { currency: cur } });
    await ctx.reply(`🔢 <b>BƯỚC 3/5</b>\n\nNhập số tài khoản:`).catch(() => {});
  } else if (step === 3) {
    updateWizard(adminId, { step: 4, data: { accountNumber: value } });
    await ctx.reply(`👤 <b>BƯỚC 4/5</b>\n\nNhập tên chủ tài khoản:`).catch(() => {});
  } else if (step === 4) {
    updateWizard(adminId, { step: 5, data: { accountName: value } });
    // Step 5 (optional QR): Admin may attach the SYSTEM receiving-account QR
    // or skip. QR is stored via PaymentAccountService (existing architecture).
    const kb = new InlineKeyboard()
      .text("📷 Gửi QR", "ops:account:add:qr")
      .text("⏭ Bỏ qua", "ops:account:add:skipqr");
    await ctx.reply(
      `📷 <b>BƯỚC 5/6 — MÃ QR (TÙY CHỌN)</b>\n\n` +
        `Gửi ảnh QR nhận tiền cho tài khoản này, hoặc bỏ qua.\n\n` +
        `📷 <b>Gửi QR</b> — gửi ảnh QR vào khung chat này.\n` +
        `⏭ <b>Bỏ qua</b> — lưu tài khoản không kèm QR.\n\n` +
        `Gửi /cancel để hủy.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  } else if (step === 6) {
    // Step 6 is the QR-photo step; text is not accepted here.
    await ctx.reply("📷 Vui lòng gửi ảnh QR, hoặc bấm ⏭ Bỏ qua.").catch(() => {});
  }
  return true;
}

/** Wizard step 5 action: await a QR photo. */
export async function startAccountAddQr(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "account_add" || wizard.step < 5) return;
  updateWizard(adminId, { step: 6 });
  await ctx.reply("📷 Vui lòng gửi ảnh QR nhận tiền vào khung chat này.\n\nGửi /cancel để hủy.").catch(() => {});
}

/** Wizard step 5: skip QR → preview. */
export async function skipAccountAddQr(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "account_add" || wizard.step < 5) return;
  updateWizard(adminId, { step: 5, data: { qrBuffer: null } });
  await showAccountAddPreview(ctx, adminId);
}

/**
 * Consumes the next Admin photo while the account_add wizard is on the QR
 * step (step 6). The QR is bound to the account being CREATED in this admin's
 * wizard session — never to another account.
 */
export async function handleAccountAddQrMedia(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard || wizard.kind !== "account_add" || wizard.step !== 6) return false;

  const photo = ctx.message?.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : undefined;
  if (!photo) {
    await ctx.reply("📷 Vui lòng gửi ảnh QR, hoặc bấm ⏭ Bỏ qua.").catch(() => {});
    return true;
  }
  try {
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải tệp thất bại (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    updateWizard(adminId, { step: 5, data: { qrBuffer: buffer } });
    await ctx.reply("✅ Đã nhận ảnh QR. Xem lại thông tin bên dưới trước khi lưu.").catch(() => {});
    await showAccountAddPreview(ctx, adminId);
  } catch (err: any) {
    await ctx.reply(`❌ Không tải được ảnh QR: ${escapeHtml(err?.message || "lỗi tải")}`, { parse_mode: "HTML" }).catch(() => {});
  }
  return true;
}

async function showAccountAddPreview(ctx: BotContext, adminId: string): Promise<void> {
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard) return;
  const d = wizard.data;
  const text =
    `⚠️ <b>XÁC NHẬN THÊM TÀI KHOẢN</b>\n\n` +
    `Ngân hàng: <b>${escapeHtml(d.bankName)}</b>\n` +
    `Tiền tệ: ${escapeHtml(d.currency)}\n` +
    `Chủ tài khoản: ${escapeHtml(d.accountName)}\n` +
    `Số tài khoản: <code>${escapeHtml(maskAccountNumber(d.accountNumber))}</code>\n` +
    `Mã QR: ${d.qrBuffer ? "✅ có (sẽ lưu kèm)" : "— không có"}`;
  const kb = new InlineKeyboard().text("✅ LƯU", "ops:account:add:confirm").row().text("❌ HỦY", "ops:account:cancel");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmAccountAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên thêm tài khoản đã hết hạn.").catch(() => {});
    return;
  }
  if (!wizard || wizard.kind !== "account_add" || wizard.step < 5) {
    await ctx.reply("⚠️ Không có phiên thêm tài khoản hợp lệ.").catch(() => {});
    return;
  }
  const d = wizard.data;
  try {
    const account = await PaymentAccountService.addAccount(
      {
        currency: d.currency,
        bankName: d.bankName,
        accountName: d.accountName,
        accountNumber: d.accountNumber,
        tag: "default",
        ...(d.qrBuffer ? { qrFileBuffer: Buffer.from(d.qrBuffer), qrFileName: `qr_${d.currency}_${d.accountNumber}.png`, qrMimeType: "image/png" } : {})
      },
      adminId
    );
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ LƯU TÀI KHOẢN</b>\n\n${escapeHtml(account.bankName)} · ${escapeHtml(account.currency)} · 💳 ${escapeHtml(maskAccountNumber(account.accountNumber))}\n` +
        (account.qrVersion > 1 || d.qrBuffer ? `🖼 Phiên bản QR: v${account.qrVersion}` : ""),
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lưu thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function cancelAccountWizard(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thao tác tài khoản.").catch(() => {});
}

// ---------------------------------------------------------------------------
// QR update wizard (scoped to the SELECTED SYSTEM receiving account)
// ---------------------------------------------------------------------------

/** Start "Cập nhật QR" for exactly one selected account. */
export async function startAccountQrUpdate(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  if (ctx.chat?.type !== "private") {
    await ctx.answerCallbackQuery({ text: "⛔ Chỉ thực hiện trong chat riêng với bot.", show_alert: true }).catch(() => {});
    return;
  }
  const account = await PaymentAccountService.getAccountById(accountId);
  if (!account) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  startWizard(String(ctx.from?.id || ""), "account_qr", { accountId });
  await ctx.reply(
    `🖼 <b>CẬP NHẬT QR — ${escapeHtml(account.bankName)} · ${escapeHtml(account.currency)}</b>\n\n` +
      `Gửi ảnh QR mới. QR cũ được giữ lại dưới dạng phiên bản lịch sử (không xóa bằng chứng cũ).\n\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

/**
 * Consumes the next Admin photo while the account_qr wizard is active. The
 * update is bound to the accountId captured at wizard start — the selected
 * SYSTEM receiving account — and goes through the authoritative
 * PaymentAccountService.updateQrCode (versioned storage, audit-logged).
 * Historical Order account snapshots are NOT touched.
 */
export async function handleAccountQrUpdateMedia(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard || wizard.kind !== "account_qr") return false;

  const photo = ctx.message?.photo?.length ? ctx.message.photo[ctx.message.photo.length - 1] : undefined;
  if (!photo) {
    await ctx.reply("📷 Vui lòng gửi ảnh QR, hoặc gửi /cancel để hủy.").catch(() => {});
    return true;
  }
  try {
    const file = await ctx.api.getFile(photo.file_id);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải tệp thất bại (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer || buffer.length === 0) throw new Error("Ảnh trống hoặc không đọc được");

    const updated = await PaymentAccountService.updateQrCode({
      accountId: String(wizard.data.accountId),
      qrFileBuffer: buffer,
      qrFileName: `qr_${updatedAccountSuffix(wizard.data.accountId)}_${Date.now()}.png`,
      qrMimeType: "image/png",
      actorId: adminId
    });
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ CẬP NHẬT QR</b>\n\n` +
        `• Tài khoản: <b>${escapeHtml(updated.bankName)} · ${escapeHtml(updated.currency)}</b>\n` +
        `• Phiên bản QR mới: <b>v${updated.qrVersion}</b>\n` +
        `• SHA-256: <code>${escapeHtml(String(updated.qrSha256 || ""))}</code>\n\n` +
        `Các đơn hàng hiện có vẫn giữ snapshot tài khoản/QR tại thời điểm tạo (không bị đổi).`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Cập nhật QR thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
  return true;
}

function updatedAccountSuffix(accountId: unknown): string {
  const s = String(accountId || "");
  return s.slice(-8) || "acc";
}

// ---------------------------------------------------------------------------
// Enable / disable (two-step; never hard-delete)
// ---------------------------------------------------------------------------

export async function previewToggleAccount(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  setPendingAction(String(ctx.from?.id || ""), "account_toggle", accountId);
  const next = !a.isActive;
  const text =
    `⚠️ <b>${next ? "KÍCH HOẠT" : "NGỪNG SỬ DỤNG"} TÀI KHOẢN</b>\n\n` +
    `🏦 ${escapeHtml(a.bankName)} · 💳 ${escapeHtml(maskAccountNumber(a.accountNumber))}\n\n` +
    `Trạng thái hiện tại: ${a.isActive ? "🟢 Đang hoạt động" : "⚪ Tạm ngưng"}\n` +
    `Sau xác nhận: ${next ? "🟢 Đang hoạt động" : "⚪ Tạm ngưng"}\n\n` +
    `Tài khoản lịch sử không bị xóa — chỉ thay đổi trạng thái.`;
  const kb = new InlineKeyboard().text("✅ XÁC NHẬN", `ops:account:toggle:confirm:${a.id}`).row().text("❌ HỦY", "ops:home");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmToggleAccount(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "account_toggle", accountId);
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  try {
    const updated = await PaymentAccountService.toggleActive(accountId, !a.isActive, adminId);
    await ctx.reply(`✅ Đã ${updated.isActive ? "kích hoạt" : "ngừng sử dụng"} tài khoản <b>${escapeHtml(updated.bankName)}</b>.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ Thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Default + priority (uses authoritative setDefaultAccount / setPriority)
// ---------------------------------------------------------------------------

export async function previewSetDefault(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  setPendingAction(String(ctx.from?.id || ""), "account_default", accountId);
  const text =
    `⚠️ <b>ĐẶT MẶC ĐỊNH</b>\n\n` +
    `🏦 ${escapeHtml(a.bankName)} · 💵 ${escapeHtml(a.currency)} · 💳 ${escapeHtml(maskAccountNumber(a.accountNumber))}\n\n` +
    `Tài khoản mặc định được ưu tiên khi khách chọn đồng ${escapeHtml(a.currency)}.`;
  const kb = new InlineKeyboard().text("✅ XÁC NHẬN", `ops:account:default:confirm:${a.id}`).row().text("❌ HỦY", "ops:home");
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmSetDefault(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const pending = consumePendingAction(adminId, "account_default", accountId);
  if (pending.expired) {
    await ctx.reply("⏱ Thao tác đã hết hạn. Vui lòng thực hiện lại từ đầu.").catch(() => {});
    return;
  }
  if (!pending.valid) {
    await ctx.reply("⚠️ Không có thao tác đang chờ xác nhận.").catch(() => {});
    return;
  }
  try {
    const updated = await PaymentAccountService.setDefaultAccount(accountId, adminId);
    await ctx.reply(`✅ Đã đặt <b>${escapeHtml(updated.bankName)}</b> làm mặc định.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function startPriorityEdit(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  startWizard(String(ctx.from?.id || ""), "account_priority", { accountId });
  await ctx.reply(`↕️ <b>ƯU TIÊN</b>\n\nNhập mức ưu tiên (số nguyên, càng cao càng ưu tiên).\n\nGửi /cancel để hủy.`, { parse_mode: "HTML" });
}

export async function handlePriorityInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId).wizard;
  if (!wizard || wizard.kind !== "account_priority") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  const num = Number(text.trim());
  if (!Number.isInteger(num) || num < 0) {
    await ctx.reply("❌ Ưu tiên phải là số nguyên ≥ 0.").catch(() => {});
    return true;
  }
  updateWizard(adminId, { step: 2, data: { priority: num } });
  const accountId = String(wizard.data.accountId);
  const kb = new InlineKeyboard().text("✅ LƯU", `ops:account:priority:confirm:${accountId}`).row().text("❌ HỦY", "ops:account:cancel");
  await ctx.reply(`⚠️ <b>XÁC NHẬN ƯU TIÊN</b>\n\nMức ưu tiên mới: <b>${num}</b>`, { parse_mode: "HTML", reply_markup: kb });
  return true;
}

export async function confirmPriority(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return;
  }
  const priority = getAdminSession(adminId).wizard?.data?.priority;
  if (priority === undefined) {
    await ctx.reply("⚠️ Không có giá trị ưu tiên để lưu.").catch(() => {});
    return;
  }
  try {
    const updated = await PaymentAccountService.setPriority(accountId, Number(priority), adminId);
    clearWizard(adminId);
    await ctx.reply(`✅ Đã đặt ưu tiên <b>${updated.priority}</b> cho <b>${escapeHtml(updated.bankName)}</b>.`, { parse_mode: "HTML" });
  } catch (err: any) {
    await ctx.reply(`❌ ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

adminAccountsHandler.callbackQuery("ops:accounts", (ctx) => showAccountsList(ctx));
adminAccountsHandler.callbackQuery(/^ops:account:detail:(.+)$/, (ctx) => showAccountDetail(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery("ops:account:add", (ctx) => startAccountAdd(ctx));
adminAccountsHandler.callbackQuery("ops:account:add:confirm", (ctx) => confirmAccountAdd(ctx));
adminAccountsHandler.callbackQuery("ops:account:add:qr", (ctx) => startAccountAddQr(ctx));
adminAccountsHandler.callbackQuery("ops:account:add:skipqr", (ctx) => skipAccountAddQr(ctx));
adminAccountsHandler.callbackQuery("ops:account:cancel", (ctx) => cancelAccountWizard(ctx));
adminAccountsHandler.callbackQuery(/^ops:account:qr:(.+)$/, (ctx) => startAccountQrUpdate(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:default:preview:(.+)$/, (ctx) => previewSetDefault(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:default:confirm:(.+)$/, (ctx) => confirmSetDefault(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:priority:(.+)$/, (ctx) => startPriorityEdit(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:priority:confirm:(.+)$/, (ctx) => confirmPriority(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:toggle:preview:(.+)$/, (ctx) => previewToggleAccount(ctx, ctx.match?.[1] || ""));
adminAccountsHandler.callbackQuery(/^ops:account:toggle:confirm:(.+)$/, (ctx) => confirmToggleAccount(ctx, ctx.match?.[1] || ""));


