/**
 * Dynamic Payment QR V1.1 — Admin QR configuration (SIMPLIFIED).
 *
 * Runtime feedback drove this rewrite:
 *  - KHQR mode was previously LOST (preview showed "KHQR — " blank) and the
 *    simple flow saved the WRONG provider ("MERCHANT" without merchant
 *    fields) — causing every Order to fall back to the static QR.
 *  - VietQR no longer requires the Admin to know NAPAS BINs: they enter the
 *    bank NAME (or BIN) and it is resolved against the VERIFIED bank table
 *    shipped with `vietnam-qr-pay` (Banks — official NAPAS metadata).
 *  - KHQR Merchant is now a clearly separate ADVANCED flow with hard
 *    missing-field validation: a misleading "successful" save is impossible.
 *  - Readiness is rendered from PaymentQrService.getQrReadiness — the SAME
 *    validation rules the runtime uses, so the Admin never guesses why an
 *    Order fell back to static QR.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { PaymentAccountService } from "../../modules/payment-accounts/account-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard, updateWizard } from "./admin-session.js";
import { getQrReadiness, type QrReadiness } from "../../modules/payment-qr/payment-qr-service.js";
import { Banks } from "vietnam-qr-pay";

export const accountQrMetaHandler = new Composer<BotContext>();

// ---------------------------------------------------------------------------
// VietQR bank resolution — verified NAPAS metadata from `vietnam-qr-pay`.
// Accepts the bank NAME (Vietnamese/English, case-insensitive) or the BIN.
// Never invents a BIN: only entries from the official bank table are used.
// ---------------------------------------------------------------------------
interface ResolvedBank {
  bankBin: string;
  bankName: string;
}

export function resolveVietQrBank(input: string): ResolvedBank | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const needle = raw.toLowerCase();
  const banks = Array.isArray(Banks) ? Banks : [];

  // 1. Exact BIN match (digits):
  if (/^\d{4,6}$/.test(needle)) {
    for (const b of banks) {
      if (String(b.bin) === needle) {
        return { bankBin: String(b.bin), bankName: String(b.name || b.shortName || needle) };
      }
    }
    return null; // unknown BIN — rejected, never invented
  }

  // 2. Name/shortName/keyword match (case-insensitive contains):
  for (const b of banks) {
    const name = String(b.name || "").toLowerCase();
    const shortName = String(b.shortName || "").toLowerCase();
    const keywords = String(b.keywords || "").toLowerCase();
    const key = String(b.key || "").toLowerCase();
    if (name === needle || shortName === needle) {
      return { bankBin: String(b.bin), bankName: String(b.name || shortName) };
    }
  }
  for (const b of banks) {
    const name = String(b.name || "").toLowerCase();
    const shortName = String(b.shortName || "").toLowerCase();
    const keywords = String(b.keywords || "").toLowerCase();
    const key = String(b.key || "").toLowerCase();
    if (
      (name && name.includes(needle)) ||
      (shortName && shortName.includes(needle)) ||
      (keywords && keywords.includes(needle)) ||
      (key && key.includes(needle))
    ) {
      return { bankBin: String(b.bin), bankName: String(b.name || b.shortName || key) };
    }
  }
  return null;
}

/**
 * Readiness line for Admin UI (uses the SHARED runtime validation rules).
 * Contract (runtime-config UX requirement):
 *   ready  → "🟢 KHQR động — Sẵn sàng"  /  "🟢 VietQR động — Sẵn sàng"
 *   not    → "🟡 QR tĩnh\n<KHQR|VietQR> động chưa sẵn sàng:\nThiếu: ..."
 * The mode is NEVER blank: the provider name always comes from the SAME
 * capability validation PaymentQrService uses at Order runtime.
 */
export function readinessLine(r: QrReadiness): string {
  const label = r.provider === "VIETQR" ? "VietQR" : "KHQR";
  if (r.ready) {
    return `🟢 ${label} động — Sẵn sàng`;
  }
  return `🟡 QR tĩnh\n${label} động chưa sẵn sàng:\nThiếu: ${r.missing.map((m) => escapeHtml(m)).join(", ")}`;
}

export async function showAccountQrMetaList(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const accounts = await PaymentAccountService.getAllAccounts();
  const lines = ["🧩 <b>CẤU HÌNH QR THANH TOÁN</b>", ""];
  const kb = new InlineKeyboard();
  if (accounts.length === 0) {
    lines.push("Chưa có tài khoản nhận tiền nào.");
  } else {
    for (const a of accounts) {
      const r = getQrReadiness(a);
      const icon = !r.ready ? "⚪️" : r.provider === "KHQR" ? "🇰🇭" : "🇻🇳";
      lines.push(
        `${icon} ${escapeHtml(a.bankName)} (${a.currency})`,
        `QR thanh toán: ${readinessLine(r)}`
      );
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
  const r = getQrReadiness(a);
  const isUsd = a.currency === "USD";
  const kb = new InlineKeyboard();
  if (isUsd) {
    kb.text("🇰🇭 KHQR động (đơn giản)", `ops:qrmeta:wizard:khqr_simple:${accountId}`)
      .row()
      .text("🏢 KHQR Merchant nâng cao", `ops:qrmeta:wizard:khqr_merchant:${accountId}`)
      .row();
  } else {
    kb.text("🇻🇳 QR động VietQR", `ops:qrmeta:wizard:vietqr:${accountId}`).row();
  }
  kb.text("⚪️ Giữ QR tĩnh", `ops:qrmeta:static:go:${accountId}`)
    .row()
    .text("⬅️ Danh sách", "ops:qrmeta");
  await ctx.reply(
    `⚙️ <b>CẤU HÌNH QR THANH TOÁN — ${escapeHtml(a.bankName)} (${a.currency})</b>\n\n` +
      `QR thanh toán: ${readinessLine(r)}\n\n` +
      (isUsd
        ? `🇰🇭 <b>KHQR động</b>: mỗi đơn nhận QR riêng (đúng số tiền + nội dung chuyển khoản).\n` +
          `• Đơn giản: chỉ cần Bakong ID + Tên + Thành phố.\n` +
          `• Merchant nâng cao: yêu cầu Merchant ID + Acquiring Bank.`
        : `🇻🇳 <b>VietQR động</b>: mỗi đơn nhận QR riêng (đúng số tiền VND + nội dung).\n` +
          `Chỉ cần chọn ngân hàng — BIN được tra tự động.`),
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

  if (kind === "vietqr") {
    startWizard(String(ctx.from?.id || ""), "qrmeta_vietqr", {
      accountId,
      step: 1,
      accountNumber: a.accountNumber,
      currency: a.currency
    });
    await ctx.reply(
      `🏦 <b>Nhập tên ngân hàng</b> để nhận tiền VND (hoặc BIN nếu bạn biết).\n` +
        `Ví dụ: <code>Vietcombank</code>, <code>MB Bank</code>, <code>Techcombank</code>\n` +
        `Hệ thống sẽ tự tra BIN chính thức. Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (kind === "khqr_simple") {
    // SIMPLE KHQR — always INDIVIDUAL mode; NO merchant technical fields.
    startWizard(String(ctx.from?.id || ""), "qrmeta_khqr_simple", {
      accountId,
      step: 1,
      khqrMode: "INDIVIDUAL",
      currency: a.currency
    });
    await ctx.reply(
      `🆔 <b>Bước 1/3 — Nhập Bakong ID</b>\n` +
        `Định dạng: <code>tên@nganhang</code> (ví dụ: <code>shop@aclb</code>)\n` +
        `Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // ADVANCED — KHQR MERCHANT (requires Merchant ID + Acquiring Bank)
  startWizard(String(ctx.from?.id || ""), "qrmeta_khqr_merchant", {
    accountId,
    step: 1,
    khqrMode: "MERCHANT",
    currency: a.currency
  });
  await ctx.reply(
    `🏢 <b>KHQR MERCHANT NÂNG CAO</b>\n\n` +
      `Chế độ này yêu cầu đầy đủ thông tin merchant chính thức:\n` +
      `1. Bakong ID  (tên@nganhang)\n` +
      `2. Tên merchant\n` +
      `3. Thành phố\n` +
      `4. Merchant ID\n` +
      `5. Acquiring Bank\n\n` +
      `✍️ Bắt đầu — <b>Nhập Bakong Account ID</b>:\nGửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

/** Sequential multi-step wizard input for the QR configuration flows. */
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

  // ---- VIETQR: bank name/BIN → resolve against the verified NAPAS table ----
  if (kind === "vietqr") {
    const bank = resolveVietQrBank(text);
    if (!bank) {
      await ctx.reply(
        `❌ Không nhận diện được ngân hàng "<code>${escapeHtml(text.trim())}</code>".\n` +
          `Vui lòng nhập <b>tên ngân hàng</b> (ví dụ: Vietcombank, MB Bank, Techcombank) hoặc BIN 4–6 chữ số.\n` +
          `Gửi /cancel để hủy.`,
        { parse_mode: "HTML" }
      );
      return true;
    }
    updateWizard(adminId, { data: { bankBin: bank.bankBin, bankName: bank.bankName } });
    const kb = new InlineKeyboard()
      .text("✅ LƯU", `ops:qrmeta:confirm:${data.accountId}`)
      .row()
      .text("❌ HỦY", "ops:qrmeta");
    await ctx.reply(
      `⚠️ <b>XEM TRƯỚC CẤU HÌNH QR</b>\n\n` +
        `📍 Loại: <b>VietQR động</b>\n` +
        `🏦 Ngân hàng: <b>${escapeHtml(bank.bankName)}</b> · BIN <code>${escapeHtml(bank.bankBin)}</code>\n` +
        `💳 Số TK nhận: <code>${escapeHtml(String(data.accountNumber || ""))}</code>\n` +
        `💵 Nội dung mỗi đơn: số tiền VND đúng + mã đơn\n\n` +
        `Xác nhận lưu?`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return true;
  }

  // ---- KHQR: sequential fields (simple = 3, merchant = 5) ------------------
  const fieldOrder =
    kind === "khqr_merchant"
      ? ["khqrBakongAccountId", "khqrMerchantName", "khqrMerchantCity", "khqrMerchantId", "khqrAcquiringBank"]
      : ["khqrBakongAccountId", "khqrMerchantName", "khqrMerchantCity"];
  const fieldLabels: Record<string, string> = {
    khqrBakongAccountId: "Bakong ID (tên@nganhang)",
    khqrMerchantName: "Tên hiển thị",
    khqrMerchantCity: "Thành phố",
    khqrMerchantId: "Merchant ID",
    khqrAcquiringBank: "Acquiring Bank"
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
    await ctx.reply(`✍️ <b>Bước ${idx + 2}/${fieldOrder.length}</b> — Nhập <b>${fieldLabels[nextField]}</b>:`, { parse_mode: "HTML" }).catch(() => {});
    return true;
  }

  // All fields collected → validate readiness (SHARED rules) → preview/gate.
  const previewData: Record<string, any> = { ...data, qrProvider: "KHQR" };
  const readiness = getQrReadiness(previewData);
  if (!readiness.ready) {
    // NEVER allow a misleading save with incomplete merchant metadata.
    const kb = new InlineKeyboard()
      .text("↩️ Nhập lại từ đầu", `ops:qrmeta:wizard:${kind === "khqr_merchant" ? "khqr_merchant" : "khqr_simple"}:${data.accountId}`)
      .row()
      .text("❌ HỦY", "ops:qrmeta");
    await ctx.reply(
      `❌ <b>Chưa đủ thông tin để tạo KHQR động.</b>\n\nThiếu:\n${readiness.missing.map((m) => `• ${escapeHtml(m)}`).join("\n")}\n\n` +
        `💡 Nếu bạn không có Merchant ID / Acquiring Bank chính thức, hãy dùng <b>KHQR động (đơn giản)</b>.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return true;
  }

  const kb2 = new InlineKeyboard()
    .text("✅ LƯU", `ops:qrmeta:confirm:${data.accountId}`)
    .row()
    .text("❌ HỦY", "ops:qrmeta");
  const modeLine =
    data.khqrMode === "MERCHANT"
      ? `🏪 Merchant ID: <code>${escapeHtml(String(data.khqrMerchantId || ""))}</code>\n🏦 Acquiring Bank: <code>${escapeHtml(String(data.khqrAcquiringBank || ""))}</code>\n`
      : "";
  await ctx.reply(
    `⚠️ <b>XEM TRƯỚC CẤU HÌNH QR</b>\n\n` +
      `📍 Loại: <b>KHQR ${escapeHtml(String(data.khqrMode || "INDIVIDUAL"))} (động)</b>\n` +
      `🆔 Bakong ID: <code>${escapeHtml(String(data.khqrBakongAccountId || ""))}</code>\n` +
      modeLine +
      `👤 Tên: <code>${escapeHtml(String(data.khqrMerchantName || ""))}</code>\n` +
      `🏙 Thành phố: <code>${escapeHtml(String(data.khqrMerchantCity || ""))}</code>\n\n` +
      `Xác nhận lưu?`,
    { parse_mode: "HTML", reply_markup: kb2 }
  );
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

  // FINAL GATE — re-validate with the SHARED runtime rules before saving.
  // A dynamic provider is only saved when it is actually READY; otherwise the
  // Admin gets the exact missing-field list (no misleading successful save).
  const wouldBe = {
    currency: String(d.currency || ""),
    qrProvider: String(d.qrProvider || ""),
    bankBin: d.bankBin ?? null,
    accountNumber: d.accountNumber ?? null,
    khqrMode: d.khqrMode ?? null,
    khqrBakongAccountId: d.khqrBakongAccountId ?? null,
    khqrMerchantName: d.khqrMerchantName ?? null,
    khqrMerchantCity: d.khqrMerchantCity ?? null,
    khqrMerchantId: d.khqrMerchantId ?? null,
    khqrAcquiringBank: d.khqrAcquiringBank ?? null
  };
  // The account's currency governs the provider (USD→KHQR / VND→VietQR):
  wouldBe.currency = d.currency || (String(d.qrProvider) === "VIETQR" ? "VND" : "USD");
  const readiness = getQrReadiness(wouldBe);
  if (!readiness.ready && readiness.provider !== "STATIC") {
    await ctx.reply(
      `❌ <b>Chưa đủ thông tin để tạo QR động.</b>\n\nThiếu:\n${readiness.missing.map((m) => `• ${escapeHtml(m)}`).join("\n")}`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }

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
    const r = getQrReadiness(updated);
    await ctx.reply(
      `✅ <b>ĐÃ LƯU CẤU HÌNH QR</b>\n🏦 ${escapeHtml(updated.bankName)} (${updated.currency})\n` +
        `QR thanh toán: ${readinessLine(r)}\nĐơn mới sẽ dùng QR động theo cấu hình này.`,
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
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:wizard:(vietqr|khqr_simple|khqr_merchant):([a-zA-Z0-9_-]+)$/, (ctx) =>
  startAccountQrMetaWizard(ctx, ctx.match?.[1] || "", ctx.match?.[2] || "")
);
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:static:go:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMetaStatic(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMeta(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.command("qrmeta", (ctx) => showAccountQrMetaList(ctx));
