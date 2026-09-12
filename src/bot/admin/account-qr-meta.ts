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
import { decodeQrImagePayload } from "../../modules/payment-qr/qr-image-decode.js";
import { parseImportedQr, type ImportedQrMeta } from "../../modules/payment-qr/qr-import.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

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

export async function applyImportedQrMeta(
  accountId: string,
  adminId: string,
  meta: ImportedQrMeta
): Promise<{ ok: boolean; readiness: QrReadiness; reason?: string }> {
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) return { ok: false, readiness: getQrReadiness({}), reason: "account_missing" };

  const wouldBe = {
    currency: a.currency,
    qrProvider: meta.provider,
    bankBin: meta.bankBin ?? null,
    accountNumber: meta.bankNumber ?? null,
    khqrMode: meta.khqrMode ?? null,
    khqrBakongAccountId: meta.khqrBakongAccountId ?? null,
    khqrMerchantName: meta.khqrMerchantName ?? null,
    khqrMerchantCity: meta.khqrMerchantCity ?? null,
    khqrMerchantId: meta.khqrMerchantId ?? null,
    khqrAcquiringBank: meta.khqrAcquiringBank ?? null
  };
  const readiness = getQrReadiness(wouldBe);
  if (!readiness.ready) {
    return { ok: false, readiness, reason: "not_ready" };
  }

  // VietQR safety: the decoded account number must belong to THIS account —
  // an imported QR for another bank account is never silently re-pointed.
  if (meta.provider === "VIETQR" && meta.bankNumber && String(a.accountNumber) !== String(meta.bankNumber)) {
    logger.warn(
      { code: "QR_IMPORT_ACCOUNT_MISMATCH", accountId, adminId },
      "QR import: VietQR account number does not match the selected PaymentAccount"
    );
    return { ok: false, readiness, reason: "account_mismatch" };
  }

  await PaymentAccountService.updateQrMetadata({
    accountId,
    actorId: adminId,
    qrProvider: meta.provider,
    bankBin: meta.bankBin ?? null,
    khqrMode: meta.khqrMode ?? null,
    khqrBakongAccountId: meta.khqrBakongAccountId ?? null,
    khqrMerchantName: meta.khqrMerchantName ?? null,
    khqrMerchantCity: meta.khqrMerchantCity ?? null,
    khqrMerchantId: meta.khqrMerchantId ?? null,
    khqrAcquiringBank: meta.khqrAcquiringBank ?? null
  });
  logger.info(
    { code: "QR_IMPORT_SAVED", accountId, provider: meta.provider, khqrMode: meta.khqrMode ?? null, adminId },
    "QR import: PaymentAccount QR metadata saved (dynamic-QR ready)"
  );
  return { ok: true, readiness };
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
  // SIMPLEST setup path first: upload an existing bank QR — the bot decodes it
  // locally and configures dynamic QR from the REAL account metadata.
  kb.text("📷 Nhập từ QR ngân hàng", `ops:qrmeta:import:${accountId}`)
    .row();
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

  // ---- IMPORT: text input is never a field — the wizard waits for an IMAGE ----
  if (kind === "import") {
    await ctx.reply(
      "📷 Phiên nhập QR đang chờ <b>ảnh QR</b>. Vui lòng gửi ảnh (PNG/JPG), hoặc gửi /cancel để hủy.",
      { parse_mode: "HTML" }
    ).catch(() => {});
    return true;
  }

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

// ===========================================================================
// TASK 6 — 📷 NHẬP TỪ QR NGÂN HÀNG (upload existing QR → decode → configure)
//
// Admin NEVER needs to understand Bakong ID / Merchant ID / Acquiring Bank /
// bank BIN. Flow:
//   Payment Account → ⚙️ QR thanh toán → 📷 Nhập từ QR ngân hàng
//   → Admin uploads the bank's QR image (PNG/JPG)
//   → LOCAL decode (jsqr + pngjs/jpeg-js — never any external HTTP service)
//   → KHQR / VietQR classification + ACCOUNT metadata extraction (EMV TLV)
//   → preview (shared readiness check) → Admin confirms → saved.
//
// 6D: the source QR's fixed amount / memo are NOT the account config — they
// are shown for transparency only and never persisted (runtime Order QRs keep
// using the FROZEN Order amount + transferMemo).
// 6F: readiness uses the SAME shared getQrReadiness as PaymentQrService.
// ===========================================================================

export async function startQrImportWizard(ctx: BotContext, accountId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return;
  }
  startWizard(String(ctx.from?.id || ""), "qrmeta_import", { accountId });
  await ctx.reply(
    `📷 <b>NHẬP CẤU HÌNH QR TỪ ẢNH QR NGÂN HÀNG</b>\n\n` +
      `Tài khoản: <b>${escapeHtml(a.bankName)} (${a.currency})</b>\n\n` +
      `1. Gửi ảnh QR tĩnh của ngân hàng (PNG/JPG) vào khung chat.\n` +
      `2. Hệ thống đọc QR TRÊN MÁY (không gửi ảnh đi đâu) và tự nhận dạng KHQR / VietQR.\n` +
      `3. Kiểm tra bản xem trước → ✅ Xác nhận để bật QR động.\n\n` +
      `ℹ️ Số tiền / nội dung có sẵn trong QR gốc KHÔNG được dùng — mỗi đơn sẽ tự tạo QR đúng số tiền + nội dung riêng.\n\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

/** Vietnamese preview text for imported metadata + shared readiness output. */
export function previewImportedQr(a: { currency: string; accountNumber?: string; bankName?: string }, meta: ImportedQrMeta): string {
  const r = getQrReadiness({
    currency: a.currency,
    qrProvider: meta.provider,
    bankBin: meta.bankBin ?? null,
    accountNumber: meta.bankNumber ?? null,
    khqrMode: meta.khqrMode ?? null,
    khqrBakongAccountId: meta.khqrBakongAccountId ?? null,
    khqrMerchantName: meta.khqrMerchantName ?? null,
    khqrMerchantCity: meta.khqrMerchantCity ?? null,
    khqrMerchantId: meta.khqrMerchantId ?? null,
    khqrAcquiringBank: meta.khqrAcquiringBank ?? null
  });

  const lines: string[] = [];
  if (meta.provider === "KHQR") {
    lines.push(meta.khqrMode === "MERCHANT" ? `🏢 <b>KHQR MERCHANT</b>` : `🇰🇭 <b>KHQR INDIVIDUAL</b>`);
    lines.push(`🆔 Bakong ID: <code>${escapeHtml(meta.khqrBakongAccountId || "")}</code>`);
    lines.push(`👤 Tên: <code>${escapeHtml(meta.khqrMerchantName || "")}</code>`);
    lines.push(`🏙 Thành phố: <code>${escapeHtml(meta.khqrMerchantCity || "")}</code>`);
    if (meta.khqrMode === "MERCHANT") {
      lines.push(`🏪 Merchant ID: <code>${escapeHtml(meta.khqrMerchantId || "")}</code>`);
      lines.push(`🏦 Acquiring Bank: <code>${escapeHtml(meta.khqrAcquiringBank || "")}</code>`);
    }
    lines.push(meta.crcValid === false ? `⚠️ CRC KHQR KHÔNG hợp lệ — ảnh có thể bị mờ/mất góc.` : "");
  } else {
    const bank = resolveVietQrBank(String(meta.bankBin || ""));
    lines.push(`🇻🇳 <b>VietQR</b>`);
    lines.push(`🏦 Ngân hàng: <code>${escapeHtml(bank?.bankName || meta.bankBin || "")}</code> (BIN <code>${escapeHtml(meta.bankBin || "")}</code>)`);
    lines.push(`💳 Số TK: <code>${escapeHtml(meta.bankNumber || "")}</code>`);
    if (a.accountNumber && meta.bankNumber && String(a.accountNumber) !== String(meta.bankNumber)) {
      lines.push(`⚠️ Số TK trong QR KHÁC số TK của tài khoản này — không thể lưu.`);
    }
  }
  lines.push("", `QR thanh toán: ${readinessLine(r)}`);
  if (meta.sourceAmount || meta.sourceMemo) {
    lines.push(
      `ℹ️ QR gốc chứa số tiền <code>${escapeHtml(meta.sourceAmount || "")}</code>` +
        `${meta.sourceMemo ? ` / nội dung "<code>${escapeHtml(meta.sourceMemo)}</code>"` : ""} — ` +
        `<b>chỉ mang tính tham khảo</b>, KHÔNG dùng cho cấu hình: mỗi đơn tự tạo QR đúng số tiền + memo riêng.`
    );
  }
  if (!r.ready) {
    lines.push(`🟡 <b>Chưa thể bật QR động</b>\nThiếu: ${r.missing.map((m) => escapeHtml(m)).join(", ")}`);
  }
  return lines.filter(Boolean).join("\n");
}

/** Admin media intake for the 📷 QR import wizard (photo OR document).
 *
 * Bounds: ADMIN-only (payment_account.edit permission) + PRIVATE chat only;
 * Telegram document/photo size capped (QR images are small — oversize files
 * are rejected before download); PNG/JPEG magic bytes validated by the local
 * decoder. NO external HTTP decoding service — decode is in-process.
 */
/**
 * Router-level intake for the 📷 QR import wizard (photo OR document).
 *
 * NEVER-SILENT: returns `true` for any update it consumes and ALWAYS replies
 * with either a preview or an explicit Vietnamese error — an unexpected
 * exception is caught in the wrapper below and surfaced to the Admin too.
 * Intake precedence: called FIRST among the Admin media handlers (see router)
 * so an active qrmeta_import wizard can never be starved by the generic
 * Admin/CSKH/customer media relay.
 */
export async function handleAccountQrImportMedia(ctx: BotContext): Promise<boolean> {
  try {
    return await runQrImportMediaFlow(ctx);
  } catch (err: any) {
    logger.error({ err: err?.message }, "QR import: unexpected failure during media intake");
    await ctx.reply(
      `❌ Có lỗi khi xử lý ảnh QR: ${escapeHtml(err?.message || "lỗi không xác định")}.\nVui lòng thử gửi lại ảnh, hoặc gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return true;
  }
}

async function runQrImportMediaFlow(ctx: BotContext): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (!session.wizard || session.wizard.kind !== "qrmeta_import") return false;
  // NOTE (runtime silence fix): a photo/document update has NO callback query.
  // The previous `ctx.answerCallbackQuery()` call here could throw/escape on
  // message updates, killing the handler before ANY reply — the reported
  // total silence for both KHQR and VietQR images. It is removed.
  if (ctx.chat?.type !== "private") {
    // QR/account configuration is a private-chat financial-config action.
    await ctx.reply("⚠️ Vui lòng thực hiện cấu hình QR trong <b>chat riêng với bot</b>.", { parse_mode: "HTML" }).catch(() => {});
    return true;
  }
  if (!(await requirePermission(ctx, "payment_account.edit"))) return true;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⌛️ Phiên đã hết hạn. Mở lại từ ⚙️ Cấu hình QR.").catch(() => {});
    return true;
  }

  // Bounded size: reject oversized uploads BEFORE downloading.
  const MAX_IMPORT_BYTES = (env.MAX_UPLOAD_MB || 10) * 1024 * 1024;
  const doc = ctx.message?.document;
  if (doc?.file_size && doc.file_size > MAX_IMPORT_BYTES) {
    await ctx.reply(`⚠️ Ảnh quá lớn (giới hạn ${env.MAX_UPLOAD_MB || 10}MB). Vui lòng nén/gửi ảnh nhỏ hơn.`).catch(() => {});
    return true;
  }
  // Bounded type: only image documents are accepted (PDF/zip/etc. rejected).
  const docMime = doc?.mime_type || "";
  if (doc && docMime && !docMime.startsWith("image/")) {
    await ctx.reply("❌ Vui lòng gửi ẢNH QR (PNG/JPG) — tệp này không phải ảnh.").catch(() => {});
    return true;
  }

  // NEVER-SILENT contract: every failure path below replies with an explicit
  // Vietnamese Admin message; the outer catch logs the technical reason
  // server-side (no secrets) so an unexpected failure can never vanish.
  logger.info(
    { code: "QR_IMPORT_MEDIA_RECEIVED", adminId, accountId: session.wizard.data.accountId },
    "QR import: media intake reached"
  );

  const accountId = String(session.wizard.data.accountId || "");
  const a = await PaymentAccountService.getAccountById(accountId);
  if (!a) {
    clearWizard(adminId);
    await ctx.reply("❌ Không tìm thấy tài khoản.").catch(() => {});
    return true;
  }

  const fileId = ctx.message?.photo?.length
    ? ctx.message.photo[ctx.message.photo.length - 1]?.file_id
    : ctx.message?.document?.file_id;
  if (!fileId) {
    await ctx.reply("📷 Vui lòng gửi <b>ảnh QR</b> (PNG/JPG), hoặc gửi /cancel để hủy.", { parse_mode: "HTML" }).catch(() => {});
    return true;
  }

  let buffer: Buffer;
  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Tải ảnh thất bại (HTTP ${res.status})`);
    buffer = Buffer.from(await res.arrayBuffer());
    // Post-download bound (photo file_size is not always declared upfront):
    if (buffer.length > MAX_IMPORT_BYTES) {
      await ctx.reply(`⚠️ Ảnh quá lớn (giới hạn ${env.MAX_UPLOAD_MB || 10}MB). Vui lòng nén/gửi ảnh nhỏ hơn.`).catch(() => {});
      return true;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, "QR import: image download failed");
    await ctx.reply(`❌ Không tải được ảnh: ${escapeHtml(err?.message || "lỗi tải")}`).catch(() => {});
    return true; // wizard stays open so Admin can upload another image
  }

  // LOCAL decode → classify → extract ACCOUNT metadata. No external HTTP
  // service, no AI — the image never leaves this process.
  let payload: string | null;
  try {
    payload = await decodeQrImagePayload(buffer);
  } catch (err: any) {
    logger.warn({ code: "QR_IMPORT_DECODE_FAILED", reason: err?.message }, "QR import: image decode threw");
    await ctx.reply(`❌ ${escapeHtml(err?.message || "Không đọc được QR từ ảnh.")}`).catch(() => {});
    return true; // wizard stays open for another image
  }
  if (!payload) {
    logger.warn({ code: "QR_IMPORT_DECODE_FAILED", reason: "no_symbol_found" }, "QR import: no QR symbol in image");
    await ctx.reply(
      "❌ Không tìm thấy mã QR nào trong ảnh. Vui lòng gửi ảnh rõ hơn (QR chiếm phần lớn khung ảnh), hoặc /cancel."
    ).catch(() => {});
    return true;
  }
  const meta = parseImportedQr(payload);
  if (!meta || !meta.provider) {
    logger.warn({ code: "QR_IMPORT_DECODE_FAILED", reason: "unrecognized_payload" }, "QR import: payload is neither KHQR nor VietQR");
    await ctx.reply(
      "❌ QR này không phải KHQR (Bakong) hoặc VietQR (NAPAS) — hệ thống chỉ hỗ trợ hai loại này cho QR động."
    ).catch(() => {});
    return true; // wizard stays open for another image
  }
  if (meta.provider === "KHQR") {
    // Metadata booleans only — never log the Bakong ID / merchant fields.
    logger.info(
      {
        code: "QR_IMPORT_PARSED_KHQR",
        khqrMode: meta.khqrMode ?? null,
        hasBakongId: Boolean(meta.khqrBakongAccountId),
        hasMerchantName: Boolean(meta.khqrMerchantName),
        hasMerchantCity: Boolean(meta.khqrMerchantCity),
        crcValid: meta.crcValid ?? null
      },
      "QR import: parsed KHQR payload"
    );
  } else {
    logger.info(
      {
        code: "QR_IMPORT_PARSED_VIETQR",
        hasBankBin: Boolean(meta.bankBin),
        accountMatches: Boolean(meta.bankNumber && String(a.accountNumber) === String(meta.bankNumber))
      },
      "QR import: parsed VietQR payload"
    );
  }

  const preview = previewImportedQr(a, meta);
  updateWizard(adminId, { data: { preview: meta } });
  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN LƯU", `ops:qrmeta:import:confirm:${accountId}`)
    .row()
    .text("❌ HỦY", `ops:qrmeta:edit:${accountId}`);
  await ctx.reply(preview, { parse_mode: "HTML", reply_markup: kb });
  return true;
}

/** Final confirm: SAME shared readiness gate — never save a broken config. */
export async function confirmAccountQrImport(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "payment_account.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (!session.wizard || session.wizard.kind !== "qrmeta_import" || !session.wizard.data.preview) {
    await ctx.reply("⚠️ Không có phiên nhập QR hợp lệ. Mở lại từ ⚙️ Cấu hình QR.").catch(() => {});
    return;
  }
  const accountId = String(session.wizard.data.accountId || "");
  const meta: ImportedQrMeta = session.wizard.data.preview;
  const outcome = await applyImportedQrMeta(accountId, adminId, meta);
  if (!outcome.ok) {
    if (outcome.reason === "account_mismatch") {
      clearWizard(adminId);
      await ctx.reply(
        "❌ Số tài khoản trong QR KHÔNG khớp tài khoản này. Không lưu — hãy upload QR của đúng tài khoản.",
        { parse_mode: "HTML" }
      ).catch(() => {});
      return;
    }
    await ctx.reply(
      `🟡 <b>Chưa thể bật QR động</b>\nThiếu: ${outcome.readiness.missing.map((m) => escapeHtml(m)).join(", ")}\n\nCấu hình CHƯA được lưu. Hãy chọn 📷 Nhập từ QR ngân hàng bằng QR đầy đủ hơn, hoặc nhập thủ công.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
    return;
  }
  clearWizard(adminId);
  const updated = await PaymentAccountService.getAccountById(accountId);
  await ctx.reply(
    `✅ <b>ĐÃ LƯU CẤU HÌNH QR TỪ ẢNH NGÂN HÀNG</b>\n🏦 ${escapeHtml(updated?.bankName || "")} (${updated?.currency})\n` +
      `QR thanh toán: ${readinessLine(outcome.readiness)}\n` +
      `Đơn mới sẽ tự tạo QR động đúng số tiền + nội dung chuyển khoản của từng đơn (QR gốc không khóa số tiền/memo).`,
    { parse_mode: "HTML" }
  ).catch(() => {});
}

accountQrMetaHandler.callbackQuery("ops:qrmeta", (ctx) => showAccountQrMetaList(ctx));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:edit:([a-zA-Z0-9_-]+)$/, (ctx) => showAccountQrMetaEdit(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:import:([a-zA-Z0-9_-]+)$/, (ctx) => startQrImportWizard(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:import:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrImport(ctx));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:wizard:(vietqr|khqr_simple|khqr_merchant):([a-zA-Z0-9_-]+)$/, (ctx) =>
  startAccountQrMetaWizard(ctx, ctx.match?.[1] || "", ctx.match?.[2] || "")
);
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:static:go:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMetaStatic(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.callbackQuery(/^ops:qrmeta:confirm:([a-zA-Z0-9_-]+)$/, (ctx) => confirmAccountQrMeta(ctx, ctx.match?.[1] || ""));
accountQrMetaHandler.command("qrmeta", (ctx) => showAccountQrMetaList(ctx));
