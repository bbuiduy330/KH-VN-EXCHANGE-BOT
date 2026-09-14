/**
 * Admin rate management wizard.
 *
 * The authoritative data model has a SINGLE ExchangeRate row for USD/VND
 * (baseRate + buyMargin + sellMargin + fee). "USD → VND" = base - buyMargin,
 * "VND → USD" = 1 / (base + sellMargin). Editing either direction therefore
 * edits the same baseRate — made explicit in the UI (no fake second value).
 * All mutations go through QuoteService.setRateAndInvalidate().
 *
 * Fresh install: when no USD/VND row exists, startRateEdit starts a first-time
 * setup wizard (base rate → buyMargin → sellMargin → fee). The admin enters
 * every financial value explicitly — nothing is auto-seeded or guessed. The
 * save still goes through the same authoritative setRateAndInvalidate upsert.
 */
import { Decimal } from "decimal.js";
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { RuntimeConfigService } from "../../modules/system-config/runtime-config-service.js";
import { AuditService } from "../../modules/audit/audit-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { timeAgo } from "./admin-panel.js";
import { clearWizard, getAdminSession, isSessionExpired, startWizard, updateWizard, AdminWizard } from "./admin-session.js";
import { parseAndValidateMargin } from "../../modules/system-config/rate-margin-validation.js";

export const adminRatesHandler = new Composer<BotContext>();

export type RateParseResult =
  | { kind: "absolute"; value: number }
  | { kind: "delta"; value: number }
  | { kind: "error"; reason: string };

/**
 * Deterministic rate input parser. AI is NEVER used for this (only deterministic
 * parsing). Rejects ambiguous decimal/thousands separators.
 * Supported: "26200" (absolute), "+50" / "-100" (delta),
 * "tăng 50" / "giảm 100" / "tăng usd vnd thêm 50" (natural delta).
 */
export function parseRateInput(input: string): RateParseResult {
  const raw = (input || "").trim();
  if (!raw) return { kind: "error", reason: "Trống" };

  const nl = raw.toLowerCase();
  const hasTang = /t(ă|a)ng/.test(nl);
  const hasGiam = /gi(ả|a)m/.test(nl);
  if (hasTang && hasGiam) return { kind: "error", reason: "Mâu thuẫn (vừa tăng vừa giảm)" };

  if (hasGiam) {
    const m = nl.match(/gi(ả|a)m[^0-9]*([0-9]+)/);
    if (m && m[2]) return { kind: "delta", value: -Number(m[2]) };
    return { kind: "error", reason: "Thiếu con số cho 'giảm'" };
  }
  if (hasTang) {
    const m = nl.match(/t(ă|a)ng[^0-9]*([0-9]+)/);
    if (m && m[2]) return { kind: "delta", value: Number(m[2]) };
    return { kind: "error", reason: "Thiếu con số cho 'tăng'" };
  }

  if (/^[+-]\d+$/.test(raw)) {
    return { kind: "delta", value: Number(raw) };
  }

  // Reject ambiguous decimal/thousands separators ("1.000", "1,000").
  if (/[.,]/.test(raw)) {
    return { kind: "error", reason: "Không rõ dấu phẩy/chấm (nhập số nguyên như 26200)" };
  }

  const digitsOnly = raw.replace(/\s+/g, "");
  if (/^\d+$/.test(digitsOnly)) {
    const value = Number(digitsOnly);
    if (!Number.isFinite(value) || value <= 0) return { kind: "error", reason: "Phải là số dương" };
    return { kind: "absolute", value };
  }

  return { kind: "error", reason: "Không hiểu được giá trị nhập" };
}

/**
 * Deterministic parser for the first-time-setup margin/fee steps.
 * Plain non-negative integers only — ambiguous thousand/decimal separators
 * ("1.000", "1,000") are rejected, consistent with parseRateInput.
 */
export function parseNonNegativeInteger(input: string): number | null {
  const parsed = parseAndValidateMargin(input);
  return parsed.success ? parsed.value : null;
}

async function getUsdVnd() {
  return prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
}

/**
 * Lightweight helper that returns only the fields we need for margin preview
 * and validation (baseRate only). Avoids loading full exchangeRate rows where
 * possible.
 */
async function peekUsdVndRate(): Promise<{ baseRate: number } | null> {
  const row = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
  if (!row) return null;
  return { baseRate: Number(row.baseRate) };
}

function renderRateManagementText(rate: any): string {
  const lines = ["💱 <b>QUẢN LÝ TỶ GIÁ</b>", ""];
  if (!rate) {
    lines.push("⚠️ Chưa có tỷ giá USD/VND.");
    lines.push("Vui lòng thiết lập tỷ giá đầu tiên.");
    return lines.join("\n");
  }
  const buyMargin = RuntimeConfigService.getBuyMarginVnd();
  const sellMargin = RuntimeConfigService.getSellMarginVnd();
  const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(rate.baseRate, buyMargin, sellMargin);
  lines.push(`USD → VND: <b>1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND</b>`);
  lines.push(`VND → USD: <b>1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND</b>`);
  lines.push(`Base: ${MoneyService.formatAmount(rate.baseRate, "VND")}`);
  lines.push(`Lợi nhuận mua/bán: <b>${buyMargin}</b> / <b>${sellMargin}</b> VND`);
  lines.push("", `🕒 Cập nhật: ${timeAgo(rate.updatedAt)}`);
  lines.push(`👤 Cập nhật bởi: ${escapeHtml(rate.updatedBy || "—")}`);
  lines.push("", "ℹ️ VND → USD được suy ra từ USD → VND (một tỷ giá gốc).");
  lines.push("💵 Lợi nhuận mua/bán là cấu hình hệ thống — chỉnh trong mục bên dưới.");
  return lines.join("\n");
}

export function getRateManagementKeyboard(hasRate = true): InlineKeyboard {
  if (!hasRate) {
    // Fresh install: the only meaningful action is the first-time setup.
    return new InlineKeyboard()
      .text("🛠 Thiết lập tỷ giá đầu tiên", "ops:rate:edit:usd_vnd")
      .row()
      .text("🏠 Menu Admin", "ops:home");
  }
  return new InlineKeyboard()
    .text("✏️ USD → VND", "ops:rate:edit:usd_vnd")
    .text("✏️ VND → USD", "ops:rate:edit:vnd_usd")
    .row()
    .text("🔄 Cập nhật cả hai", "ops:rate:edit:both")
    .row()
    .text("⚡ Điều chỉnh nhanh", "ops:rate:quick:menu")
    .row()
    .text("📝 Ghi chú báo giá", "ops:qfooter")
    .text("💵 Lợi nhuận mua/bán", "ops:rates:margin")
    .row()
    .text("📣 Thông báo tỷ giá", "ops:broadcast:rate")
    .row()
    .text("ℹ️ Chi tiết tỷ giá", "ops:rates:detail")
    .text("🏠 Menu Admin", "ops:home");
}

export async function showRateManagement(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "rate.view"))) return;
  const rate = await getUsdVnd();
  const text = renderRateManagementText(rate);
  const kb = getRateManagementKeyboard(!!rate);
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

const RATE_DIRECTION_LABEL: Record<string, string> = {
  usd_vnd: "USD → VND",
  vnd_usd: "VND → USD",
  both: "Cả hai chiều",
  quick: "Điều chỉnh nhanh"
};

/**
 * Apply a parsed rate input against the current baseRate (VND per 1 USD).
 * Both customer directions derive from this single baseRate — this function
 * NEVER inverts to 1/rate, so VND→USD editing cannot accidentally store a
 * reciprocal value.
 */
export function applyRateInput(current: number, parsed: RateParseResult): number {
  if (parsed.kind === "absolute") return parsed.value;
  if (parsed.kind === "delta") return current + parsed.value;
  // Error kind: caller should have rejected it before reaching here — treat as no-op.
  return current;
}

export async function startRateEdit(ctx: BotContext, direction: string): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const rate = await getUsdVnd();
  if (!rate) {
    // Fresh install: no ExchangeRate row yet — start the first-time setup
    // wizard instead of dead-ending. The admin creates the initial USD/VND
    // rate step by step; nothing is auto-seeded or guessed.
    const adminId = String(ctx.from?.id || "");
    startWizard(adminId, "rate_edit", {
      direction,
      isCreate: true,
      currentBaseRate: 0,
      pair: "USD/VND"
    });
    await ctx.reply(
      `⚠️ <b>Chưa có tỷ giá USD/VND.</b>\n` +
        `Vui lòng thiết lập tỷ giá đầu tiên.\n\n` +
        `💱 <b>BƯỚC 1/4 — NHẬP TỶ GIÁ GỐC (VND / 1 USD)</b>\n\n` +
        `Nhập một số nguyên, ví dụ: <code>26200</code>\n` +
        `Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }
  const adminId = String(ctx.from?.id || "");
  startWizard(adminId, "rate_edit", {
    direction,
    currentBaseRate: Number(rate.baseRate),
    pair: "USD/VND"
  });
  const label = RATE_DIRECTION_LABEL[direction] || "USD → VND";
  await ctx.reply(
    `💱 <b>NHẬP TỶ GIÁ GỐC (VND / 1 USD)</b>\n\n` +
      `${escapeHtml(label)} — chỉnh cùng một tỷ giá gốc.\n` +
      `Hiện tại: <b>${MoneyService.formatAmount(rate.baseRate, "VND")}</b>\n\n` +
      `USD → VND = base − buyMargin\n` +
      `VND → USD = base + sellMargin\n\n` +
      `Nhập một trong các dạng:\n` +
      `<code>26200</code> — đặt tuyệt đối\n` +
      `<code>+50</code> / <code>-100</code> — tăng/giảm\n` +
      `<code>tăng 50</code> / <code>giảm 100</code>\n` +
      `<code>tăng usd vnd thêm 50</code>\n\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

export async function handleRateWizardInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard || wizard.kind !== "rate_edit") return false;

  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên nhập tỷ giá đã hết hạn. Vui lòng bắt đầu lại.").catch(() => {});
    return true;
  }

  // First-time setup (fresh DB): no ExchangeRate row yet. The admin enters
  // base rate, margins and fee explicitly — every value is authoritative.
  if (wizard.data.isCreate) {
    await handleRateCreateInput(ctx, adminId, wizard, text);
    return true;
  }

  const parsed = parseRateInput(text);
  if (parsed.kind === "error") {
    await ctx.reply(`❌ ${escapeHtml(parsed.reason)}. Nhập lại (ví dụ: 26200, +50, -100, tăng 50) hoặc /cancel.`).catch(() => {});
    return true;
  }

  const current = Number(wizard.data.currentBaseRate);
  const newBase = applyRateInput(current, parsed);
  if (!Number.isFinite(newBase) || newBase <= 0) {
    await ctx.reply("❌ Tỷ giá mới không hợp lệ (phải lớn hơn 0). Nhập lại.").catch(() => {});
    return true;
  }

  updateWizard(adminId, { step: 2, data: { newBaseRate: newBase } });
  await showRatePreview(ctx, adminId);
  return true;
}

/**
 * First-time setup wizard steps (fresh DB, no ExchangeRate row):
 * step 1 = base rate (absolute only), 2 = buyMargin, 3 = sellMargin,
 * 4 = fee (USD), 5 = preview/confirm. No value is invented by the system.
 */
async function handleRateCreateInput(ctx: BotContext, adminId: string, wizard: AdminWizard, text: string): Promise<void> {
  const step = Number(wizard.step);

  if (step === 1) {
    const parsed = parseRateInput(text);
    if (parsed.kind === "error") {
      await ctx.reply(`❌ ${escapeHtml(parsed.reason)}. Nhập tỷ giá tuyệt đối (ví dụ: 26200) hoặc /cancel.`).catch(() => {});
      return;
    }
    if (parsed.kind === "delta") {
      await ctx.reply("❌ Đây là lần thiết lập đầu tiên — hãy nhập tỷ giá tuyệt đối (ví dụ: 26200).").catch(() => {});
      return;
    }
    if (!Number.isFinite(parsed.value) || parsed.value <= 0) {
      await ctx.reply("❌ Tỷ giá không hợp lệ (phải lớn hơn 0). Nhập lại.").catch(() => {});
      return;
    }
    updateWizard(adminId, { step: 2, data: { newBaseRate: parsed.value } });
    await ctx.reply(
      `💱 <b>BƯỚC 2/4 — BUY MARGIN (VND, trừ khỏi base)</b>\n\n` +
        `USD → VND = base − buyMargin\n` +
        `Nhập số nguyên ≥ 0 (ví dụ: <code>50</code>). Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (step === 2) {
    const buy = parseNonNegativeInteger(text);
    if (buy === null) {
      await ctx.reply("❌ Nhập số nguyên ≥ 0 (ví dụ: 50) hoặc /cancel.").catch(() => {});
      return;
    }
    updateWizard(adminId, { step: 3, data: { newBuyMargin: buy } });
    await ctx.reply(
      `💱 <b>BƯỚC 3/4 — SELL MARGIN (VND, cộng vào base)</b>\n\n` +
        `VND → USD = base + sellMargin\n` +
        `Nhập số nguyên ≥ 0 (ví dụ: <code>100</code>). Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (step === 3) {
    const sell = parseNonNegativeInteger(text);
    if (sell === null) {
      await ctx.reply("❌ Nhập số nguyên ≥ 0 (ví dụ: 100) hoặc /cancel.").catch(() => {});
      return;
    }
    updateWizard(adminId, { step: 4, data: { newSellMargin: sell } });
    await ctx.reply(
      `💱 <b>BƯỚC 4/4 — PHÍ (USD)</b>\n\n` +
        `Nhập số nguyên ≥ 0 (ví dụ: <code>2</code>). Gửi /cancel để hủy.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (step === 4) {
    const fee = parseNonNegativeInteger(text);
    if (fee === null) {
      await ctx.reply("❌ Nhập số nguyên ≥ 0 (ví dụ: 2) hoặc /cancel.").catch(() => {});
      return;
    }
    updateWizard(adminId, { step: 5, data: { newFee: fee } });
    await showCreatePreview(ctx, adminId);
    return;
  }
}

async function showCreatePreview(ctx: BotContext, adminId: string): Promise<void> {
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard) return;

  const base = Number(wizard.data.newBaseRate);
  const buy = Number(wizard.data.newBuyMargin);
  const sell = Number(wizard.data.newSellMargin);
  const fee = Number(wizard.data.newFee);
  if (![base, buy, sell, fee].every((v) => Number.isFinite(v))) {
    clearWizard(adminId);
    await ctx.reply("⚠️ Dữ liệu thiết lập không đầy đủ. Vui lòng bắt đầu lại từ màn hình Tỷ giá.").catch(() => {});
    return;
  }

  const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(base, buy, sell);
  const pending = await prisma.quote.count({ where: { status: "PENDING" } });

  const text =
    `⚠️ <b>XÁC NHẬN THIẾT LẬP TỶ GIÁ ĐẦU TIÊN (USD/VND)</b>\n\n` +
    `Base: <b>${MoneyService.formatAmount(base, "VND")}</b>\n` +
    `Buy margin: <b>-${buy}</b>\n` +
    `Sell margin: <b>+${sell}</b>\n` +
    `Phí: <b>${fee} USD</b>\n\n` +
    `USD → VND: <b>1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND</b>\n` +
    `VND → USD: <b>1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND</b>\n\n` +
    `Quote PENDING đang tồn tại: <b>${pending}</b>\n\n` +
    `Khi xác nhận:\n` +
    `• tạo tỷ giá USD/VND đầu tiên\n` +
    `• toàn bộ PENDING quotes (nếu có) sẽ hết hiệu lực`;

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", "ops:rate:confirm")
    .row()
    .text("❌ HỦY", "ops:rate:cancel");

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

async function showRatePreview(ctx: BotContext, adminId: string): Promise<void> {
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard) return;

  const current = Number(wizard.data.currentBaseRate);
  const newBase = Number(wizard.data.newBaseRate);
  const delta = newBase - current;
  const pending = await prisma.quote.count({ where: { status: "PENDING" } });
  const label = RATE_DIRECTION_LABEL[wizard.data.direction] || "USD → VND";

  const text =
    `⚠️ <b>XÁC NHẬN THAY ĐỔI TỶ GIÁ</b>\n\n` +
    `${escapeHtml(label)}\n\n` +
    `Hiện tại: <b>${MoneyService.formatAmount(current, "VND")}</b>\n` +
    `Mới: <b>${MoneyService.formatAmount(newBase, "VND")}</b>\n` +
    `Thay đổi: <b>${delta >= 0 ? "+" : ""}${delta}</b>\n\n` +
    `Quote PENDING đang tồn tại: <b>${pending}</b>\n\n` +
    `Khi xác nhận:\n` +
    `• áp dụng tỷ giá mới\n` +
    `• toàn bộ PENDING quotes sẽ hết hiệu lực\n` +
    `• đơn đã xác nhận giữ nguyên tỷ giá khóa`;

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", "ops:rate:confirm")
    .row()
    .text("❌ HỦY", "ops:rate:cancel");

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function confirmRateChange(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;

  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session.wizard;
  if (!wizard || wizard.kind !== "rate_edit") {
    await ctx.reply("⚠️ Không có phiên đổi tỷ giá nào đang hoạt động.").catch(() => {});
    return;
  }
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn. Vui lòng bắt đầu lại.").catch(() => {});
    return;
  }

  // First-time setup: there is no existing rate row — the wizard itself
  // carries base/margins/fee. The authoritative save path is unchanged.
  if (wizard.data.isCreate) {
    const newBaseRate = Number(wizard.data.newBaseRate);
    const newBuyMargin = Number(wizard.data.newBuyMargin);
    const newSellMargin = Number(wizard.data.newSellMargin);
    const newFee = Number(wizard.data.newFee);
    if (
      !Number.isFinite(newBaseRate) || newBaseRate <= 0 ||
      !Number.isFinite(newBuyMargin) || newBuyMargin < 0 ||
      !Number.isFinite(newSellMargin) || newSellMargin < 0 ||
      !Number.isFinite(newFee) || newFee < 0
    ) {
      clearWizard(adminId);
      await ctx.reply("⚠️ Dữ liệu thiết lập không đầy đủ. Vui lòng bắt đầu lại từ màn hình Tỷ giá.").catch(() => {});
      return;
    }
    try {
      const res = await QuoteService.setRateAndInvalidate(
        "USD/VND",
        newBaseRate,
        newBuyMargin,
        newSellMargin,
        newFee,
        "USD",
        adminId,
        ctx.identity?.userType || "ADMIN"
      );
      clearWizard(adminId);
      const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(newBaseRate, newBuyMargin, newSellMargin);
      await ctx.reply(
        `✅ <b>ĐÃ TẠO TỶ GIÁ USD/VND</b>\n\n` +
          `Base: <b>${MoneyService.formatAmount(newBaseRate, "VND")}</b>\n` +
          `USD → VND: <b>${MoneyService.formatAmount(effectiveBuy, "VND")} VND</b>\n` +
          `VND → USD: <b>${MoneyService.formatAmount(effectiveSell, "VND")} VND</b>\n` +
          `Quote PENDING đã hết hiệu lực: <b>${res.invalidatedCount}</b>`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Tạo tỷ giá thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
    }
    return;
  }

  const rate = await getUsdVnd();
  if (!rate) {
    clearWizard(adminId);
    await ctx.reply("Chưa cấu hình cặp USD/VND.").catch(() => {});
    return;
  }

  if (Number(rate.baseRate) !== Number(wizard.data.currentBaseRate)) {
    clearWizard(adminId);
    await ctx.reply("⚠️ Tỷ giá đã thay đổi từ lúc xem trước. Vui lòng xem lại và xác nhận lại.").catch(() => {});
    return;
  }

  const newBaseRate = Number(wizard.data.newBaseRate);
  try {
    const res = await QuoteService.setRateAndInvalidate(
      "USD/VND",
      newBaseRate,
      rate.buyMargin,
      rate.sellMargin,
      rate.fee,
      rate.feeCurrency,
      adminId,
      ctx.identity?.userType || "ADMIN"
    );
    clearWizard(adminId);
    await ctx.reply(
      `✅ <b>ĐÃ CẬP NHẬT TỶ GIÁ</b>\n\n` +
        `USD → VND: <b>${MoneyService.formatAmount(newBaseRate, "VND")}</b>\n` +
        `Quote PENDING đã hết hiệu lực: <b>${res.invalidatedCount}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Cập nhật thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function cancelRateChange(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thay đổi tỷ giá.").catch(() => {});
}

export async function showQuickAdjustMenu(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const rate = await getUsdVnd();
  const base = rate ? Number(rate.baseRate) : 0;
  const kb = new InlineKeyboard()
    .text("-100", "ops:rate:quick:-100")
    .text("-50", "ops:rate:quick:-50")
    .text("-10", "ops:rate:quick:-10")
    .row()
    .text("+10", "ops:rate:quick:10")
    .text("+50", "ops:rate:quick:50")
    .text("+100", "ops:rate:quick:100")
    .row()
    .text("🏠 Menu Admin", "ops:home");
  await ctx.reply(
    `⚡ <b>ĐIỀU CHỈNH NHANH</b>\n\n` +
      `Base hiện tại: <b>${MoneyService.formatAmount(base, "VND")}</b>\n` +
      `Chọn mức tăng/giảm (chỉ xem trước, chưa áp dụng):`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

export async function quickAdjust(ctx: BotContext, delta: number): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const rate = await getUsdVnd();
  if (!rate) {
    await ctx.reply("Chưa cấu hình cặp USD/VND.").catch(() => {});
    return;
  }
  const adminId = String(ctx.from?.id || "");
  const current = Number(rate.baseRate);
  const newBase = current + delta;
  if (newBase <= 0) {
    await ctx.reply("❌ Kết quả điều chỉnh không hợp lệ (≤ 0).").catch(() => {});
    return;
  }
  startWizard(adminId, "rate_edit", {
    direction: "quick",
    currentBaseRate: current,
    newBaseRate: newBase,
    pair: "USD/VND"
  });
  updateWizard(adminId, { step: 2 });
  await showRatePreview(ctx, adminId);
}

adminRatesHandler.callbackQuery("ops:rates", (ctx) => showRateManagement(ctx));
adminRatesHandler.callbackQuery(/^ops:rate:edit:(usd_vnd|vnd_usd|both)$/, (ctx) => startRateEdit(ctx, ctx.match?.[1] || "usd_vnd"));
adminRatesHandler.callbackQuery("ops:rate:quick:menu", (ctx) => showQuickAdjustMenu(ctx));
adminRatesHandler.callbackQuery(/^ops:rate:quick:(-?\d+)$/, async (ctx) => {
  const delta = Number(ctx.match?.[1] || 0);
  await quickAdjust(ctx, delta);
});
adminRatesHandler.callbackQuery("ops:rate:confirm", (ctx) => confirmRateChange(ctx));
adminRatesHandler.callbackQuery("ops:rate:cancel", (ctx) => cancelRateChange(ctx));

// ---------------------------------------------------------------------------
// 💵 LỢI NHUẬN MUA/BÁN (USD/VND) — Admin-configurable margins.
//
// buyMarginVnd / sellMarginVnd live as SystemSetting KVs (no schema change).
// They apply ONLY to the USD/VND pair's quote/order calculations; every other
// pair keeps its own ExchangeRate-row margins (fallback unchanged).
//
// INDEPENDENT EDIT FLOWS: BUY and SELL are edited independently. Each flow:
//   tap edit → enter value → preview old/new effective rate → explicit ✅ Confirm → save
// Neither flow forces the admin through the other margin.
//
// MAX VALUE: 10,000 VND. Margins are integer VND units.
// RATE SAFETY: baseRate − buyMarginVnd > 0 (effective buy rate must stay positive).
//
// SNAPSHOT SAFETY: quotes and orders freeze margin/rate at creation time, so
// editing the margin affects only NEW quotes/orders — existing ones keep the
// value they were committed at. Unlike a rate change, PENDING quotes are NOT
// invalidated here: their amounts were already shown to the customer.
// ---------------------------------------------------------------------------

export async function showMarginManagement(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const buy = RuntimeConfigService.getBuyMarginVnd();
  const sell = RuntimeConfigService.getSellMarginVnd();
  const lines = [
    "💵 <b>LỢI NHUẬN MUA/BÁN (USD/VND)</b>",
    "",
    `Mua (USD → VND): <b>${buy} VND</b> — trừ khỏi base`,
    `Bán (VND → USD): <b>${sell} VND</b> — cộng vào base`,
    "",
    "Áp dụng cho BÁO GIÁ & ĐƠN HÀNG MỚI. Các báo giá/đơn đã tạo giữ nguyên theo giá đã chốt (snapshot).",
    "Các cặp tiền khác (USD/KHR, VND/KHR…) vẫn dùng margin riêng trong mục quản lý tỷ giá.",
    "",
    `Giới hạn: 0 – 10.000 VND (số nguyên)`
  ];
  const kb = new InlineKeyboard()
    .text("✏️ Tỷ giá cơ sở", "ops:rates:edit")
    .text("✏️ Biên mua", "ops:margin:edit:buy")
    .text("✏️ Biên bán", "ops:margin:edit:sell")
    .row()
    .text("👁 Xem trước", "ops:margin:preview")
    .row()
    .text("⬅️ Quay lại", "ops:rates")
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

export async function startBuyMarginEdit(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  startWizard(adminId, "margin_buy_edit", {});
  const currentBuy = RuntimeConfigService.getBuyMarginVnd();
  await ctx.reply(
    `✏️ <b>CHỈNH BIÊN MUA (USD → VND)</b>\n\n` +
      `USD → VND = base − buyMargin\n\n` +
      `Hiện tại: <b>${currentBuy} VND</b>\n\n` +
      `Nhập số nguyên từ 0 đến 10.000 (ví dụ: <code>200</code>).\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

export async function startSellMarginEdit(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  startWizard(adminId, "margin_sell_edit", {});
  const currentSell = RuntimeConfigService.getSellMarginVnd();
  await ctx.reply(
    `✏️ <b>CHỈNH BIÊN BÁN (VND → USD)</b>\n\n` +
      `VND → USD = base + sellMargin\n\n` +
      `Hiện tại: <b>${currentSell} VND</b>\n\n` +
      `Nhập số nguyên từ 0 đến 10.000 (ví dụ: <code>200</code>).\n` +
      `Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
}

export async function handleMarginWizardInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  const wizard = session?.wizard;
  if (!wizard) return false;

  if (wizard.kind === "margin_buy_edit" || wizard.kind === "margin_sell_edit") {
    return handleIndependentMarginInput(ctx, adminId, wizard, text);
  }

  return false;
}

async function handleIndependentMarginInput(
  ctx: BotContext,
  adminId: string,
  wizard: AdminWizard,
  text: string
): Promise<boolean> {
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên chỉnh lợi nhuận đã hết hạn. Vui lòng bắt đầu lại.").catch(() => {});
    return true;
  }

  // Step 1: parse and validate input (uses shared domain validator)
  if (Number(wizard.step) === 1) {
    // Narrow the wizard kind ONCE (session state stores it as a plain string);
    // the dispatcher in handleMarginWizardInput already restricted it to these
    // two kinds before delegating here.
    const kind = wizard.kind;
    if (kind !== "margin_buy_edit" && kind !== "margin_sell_edit") return false;

    const isBuy = kind === "margin_buy_edit";
    const validation = parseAndValidateMargin(
      text,
      isBuy ? (await peekUsdVndRate())?.baseRate : undefined,
      isBuy
    );
    if (!validation.success) {
      await ctx.reply(` ${validation.error} Nhập lại hoặc /cancel.`).catch(() => {});
      return true;
    }
    // A successful validation always carries the validated integer; the result
    // type keeps `value` nullable, so narrow explicitly (never coerce null).
    const newValue = validation.value;
    if (newValue === null) return true;

    updateWizard(adminId, { step: 2, data: { newValue } });
    await showMarginPreview(ctx, adminId, kind, newValue);
    return true;
  }

  return true;
}

async function showMarginPreview(
  ctx: BotContext,
  adminId: string,
  kind: "margin_buy_edit" | "margin_sell_edit",
  newValue: number
): Promise<void> {
  const oldBuy = RuntimeConfigService.getBuyMarginVnd();
  const oldSell = RuntimeConfigService.getSellMarginVnd();
  const isBuy = kind === "margin_buy_edit";
  const oldValue = isBuy ? oldBuy : oldSell;
  const delta = newValue - Number(oldValue);
  const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;

  // Calculate effective rates for preview
  const rate = await peekUsdVndRate();
  let effectiveBuyOld = "--";
  let effectiveBuyNew = "--";
  let effectiveSellOld = "--";
  let effectiveSellNew = "--";

  if (rate) {
    const { effectiveBuy: ebOld, effectiveSell: esOld } = MoneyService.calculateEffectiveRates(
      new Decimal(rate.baseRate), oldBuy, oldSell
    );
    const buyMarginNew = isBuy ? newValue : Number(oldBuy);
    const sellMarginNew = isBuy ? Number(oldSell) : newValue;
    const { effectiveBuy: ebNew, effectiveSell: esNew } = MoneyService.calculateEffectiveRates(
      new Decimal(rate.baseRate), buyMarginNew, sellMarginNew
    );
    effectiveBuyOld = MoneyService.formatAmount(ebOld, "VND");
    effectiveBuyNew = MoneyService.formatAmount(ebNew, "VND");
    effectiveSellOld = MoneyService.formatAmount(esOld, "VND");
    effectiveSellNew = MoneyService.formatAmount(esNew, "VND");
  }

  const kb = new InlineKeyboard()
    .text("✅ XÁC NHẬN", `ops:margin:confirm:${isBuy ? "buy" : "sell"}`)
    .row()
    .text("❌ HỦY", "ops:margin:cancel");

  const title = isBuy ? "✏️ CHỈNH BIÊN MUA (USD → VND)" : "✏️ CHỈNH BIÊN BÁN (VND → USD)";
  const directionLabel = isBuy
    ? `USD → VND = base − buyMargin\neffectiveBuy = base − buyMargin`
    : `VND → USD = base + sellMargin\neffectiveSell = base + sellMargin`;

  await ctx.reply(
    `👁 <b>XEM TRƯỚC — ${title}</b>\n\n` +
      `${directionLabel}\n\n` +
      `Giá trị cũ: <b>${oldValue} VND</b>\n` +
      `Giá trị mới: <b>${newValue} VND</b>\n` +
      `Thay đổi: ${deltaStr} VND\n\n` +
      `Tỷ giá hiệu dụng (nếu có baseRate):\n` +
      `  USD → VND (effectiveBuy):\n` +
      `    Cũ: <b>${effectiveBuyOld} VND</b>\n` +
      `    Mới: <b>${effectiveBuyNew} VND</b>\n` +
      `  VND → USD (effectiveSell):\n` +
      `    Cũ: <b>1 USD = ${effectiveSellOld} VND</b>\n` +
      `    Mới: <b>1 USD = ${effectiveSellNew} VND</b>\n\n` +
      `Khi xác nhận:\n` +
      `• chỉ ${isBuy ? "biên mua" : "biên bán"} sẽ được cập nhật\n` +
      `• ${isBuy ? "biên bán" : "biên mua"} giữ nguyên\n` +
      `• áp dụng cho báo giá & đơn hàng MỚI (USD/VND)\n` +
      `• báo giá/đơn đã tồn tại giữ nguyên theo giá đã chốt\n` +
      `• PENDING quotes KHÔNG bị hủy giá`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

export async function confirmMarginChange(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const wizard = getAdminSession(adminId)?.wizard;
  if (!wizard) {
    await ctx.reply("⚠️ Không có phiên chỉnh lợi nhuận nào đang hoạt động.").catch(() => {});
    return;
  }

  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn. Vui lòng bắt đầu lại.").catch(() => {});
    return;
  }

  const kind = wizard.kind;
  const isBuy = kind === "margin_buy_edit";
  const isSell = kind === "margin_sell_edit";

  if (!isBuy && !isSell) {
    await ctx.reply("⚠️ Phiên chỉnh lợi nhuận không hợp lệ. Vui lòng bắt đầu lại.").catch(() => {});
    clearWizard(adminId);
    return;
  }

  const newValue = Number(wizard.data.newValue);
  if (!Number.isFinite(newValue) || newValue < 0 || newValue > 10000) {
    clearWizard(adminId);
    await ctx.reply("⚠️ Dữ liệu không hợp lệ. Vui lòng bắt đầu lại.").catch(() => {});
    return;
  }

  // ── Confirm-time revalidation: base rate may have changed since input/preview.
  // For BUY margin, independently verify current baseRate - pendingMargin > 0
  // using the CURRENT authoritative base rate (via prisma, already imported),
  // BEFORE calling the setter.
  if (isBuy) {
    const currentRate = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
    if (currentRate) {
      const currentBaseRate = Number(currentRate.baseRate);
      if (Number.isFinite(currentBaseRate) && currentBaseRate - newValue <= 0) {
        clearWizard(adminId);
        await ctx.reply(
          `❌ Giá trị này không còn hợp lệ.\n` +
          `Hiện tại baseRate = ${currentBaseRate} VND.\n` +
          `baseRate − buyMargin = ${currentBaseRate - newValue} ≤ 0.\n` +
          `Effective buy rate phải > 0. Vui lòng nhập lại.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        return;
      }
    }
  }

  try {
    const oldValue = isBuy
      ? RuntimeConfigService.getBuyMarginVnd()
      : RuntimeConfigService.getSellMarginVnd();

    if (isBuy) {
      await RuntimeConfigService.setBuyMarginVnd(newValue, adminId);
      await AuditService.log({
        actorId: adminId,
        actorRole: ctx.identity?.userType || "ADMIN",
        action: "RATE_BUY_MARGIN_UPDATED",
        targetType: "SYSTEM_SETTING",
        targetId: "buyMarginVnd",
        details: { oldValue: String(oldValue), newValue: String(newValue) }
      });
      await ctx.reply(
        `✅ <b>ĐÃ CẬP NHẬT BIÊN MUA (USD → VND)</b>\n\n` +
          `Giá trị cũ: <b>${oldValue} VND</b>\n` +
          `Giá trị mới: <b>${newValue} VND</b>\n\n` +
          `Áp dụng cho báo giá & đơn hàng MỚI.\n` +
          `Biên bán giữ nguyên.`,
        { parse_mode: "HTML" }
      );
    } else {
      await RuntimeConfigService.setSellMarginVnd(newValue, adminId);
      await AuditService.log({
        actorId: adminId,
        actorRole: ctx.identity?.userType || "ADMIN",
        action: "RATE_SELL_MARGIN_UPDATED",
        targetType: "SYSTEM_SETTING",
        targetId: "sellMarginVnd",
        details: { oldValue: String(oldValue), newValue: String(newValue) }
      });
      await ctx.reply(
        `✅ <b>ĐÃ CẬP NHẬT BIÊN BÁN (VND → USD)</b>\n\n` +
          `Giá trị cũ: <b>${oldValue} VND</b>\n` +
          `Giá trị mới: <b>${newValue} VND</b>\n\n` +
          `Áp dụng cho báo giá & đơn hàng MỚI.\n` +
          `Biên mua giữ nguyên.`,
        { parse_mode: "HTML" }
      );
    }

    clearWizard(adminId);
  } catch (err: any) {
    await ctx.reply(`❌ Cập nhật利润 thất bại: ${escapeHtml(err?.message || "lỗi không xác định")}`, { parse_mode: "HTML" }).catch(() => {});
  }
}

export async function cancelMarginChange(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  clearWizard(String(ctx.from?.id || ""));
  await ctx.reply("Đã hủy thao tác chỉnh lợi nhuận.").catch(() => {});
}

adminRatesHandler.callbackQuery("ops:rates:margin", (ctx) => showMarginManagement(ctx));
adminRatesHandler.callbackQuery("ops:margin:edit:buy", (ctx) => startBuyMarginEdit(ctx));
adminRatesHandler.callbackQuery("ops:margin:edit:sell", (ctx) => startSellMarginEdit(ctx));
adminRatesHandler.callbackQuery("ops:margin:preview", (ctx) => {
  // Preview is shown inline after input; this callback is unused
  ctx.answerCallbackQuery();
});
adminRatesHandler.callbackQuery("ops:margin:confirm", (ctx) => confirmMarginChange(ctx));
adminRatesHandler.callbackQuery("ops:margin:confirm:buy", (ctx) => confirmMarginChange(ctx));
adminRatesHandler.callbackQuery("ops:margin:confirm:sell", (ctx) => confirmMarginChange(ctx));
adminRatesHandler.callbackQuery("ops:margin:cancel", (ctx) => cancelMarginChange(ctx));

// ---------------------------------------------------------------------------
// 📝 GHI CHÚ BÁO GIÁ — Admin-editable multilingual quote footer (Part 3).
// PRESENTATION ONLY: appended to newly rendered customer Quote cards. NEVER
// affects rate / amounts / fee / expiry / Order state / financial snapshots.
// Stored in existing SystemSetting KV storage (RuntimeConfigService) — no new
// columns. Admin manages each locale explicitly; NO AI translation.
// ---------------------------------------------------------------------------

const QUOTE_FOOTER_MAX_LEN = 500;
const QUOTE_FOOTER_LOCALES: { locale: "vi" | "en" | "km" | "zh"; flag: string; label: string }[] = [
  { locale: "vi", flag: "🇻🇳", label: "VI" },
  { locale: "en", flag: "🇬🇧", label: "EN" },
  { locale: "km", flag: "🇰🇭", label: "KM" },
  { locale: "zh", flag: "🇨🇳", label: "ZH" }
];

/** Frozen-quote-safe: footer is read at RENDER time for NEW quotes only. */
export function getQuoteFooterFor(locale: string): string {
  return RuntimeConfigService.getQuoteFooter(locale);
}

export async function showQuoteFooterSettings(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const enabled = RuntimeConfigService.get<boolean>("quoteFooterEnabled", false);
  const lines = ["📝 <b>GHI CHÚ BÁO GIÁ</b>", "", `Trạng thái: ${enabled ? "🟢 Bật" : "⚪ Tắt"}`, ""];
  const kb = new InlineKeyboard();
  for (const { locale, flag, label } of QUOTE_FOOTER_LOCALES) {
    const text = String(RuntimeConfigService.get<string>(`quoteFooter${locale.toUpperCase()}`, "") || "").trim();
    lines.push(`${flag} ${label}: ${text ? escapeHtml(text).slice(0, 120) : "(chưa đặt)"}`);
    kb.text(`✏️ Sửa ${label}`, `ops:qfooter:edit:${locale}`);
    if (locale === "en" || locale === "zh") kb.row();
  }
  lines.push("", "<i>Chỉ hiển thị trên báo giá MỚI. Không ảnh hưởng tỷ giá/tiền/hạn.</i>");
  kb.row().text("🟢 Bật/Tắt", "ops:qfooter:toggle").text("👁 Xem trước", "ops:qfooter:preview");
  kb.row().text("⬅️ Tỷ giá", "ops:rates").text("🏠 Menu Admin", "ops:home");
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

adminRatesHandler.callbackQuery("ops:qfooter", (ctx) => showQuoteFooterSettings(ctx));

adminRatesHandler.callbackQuery(/^ops:qfooter:edit:(vi|en|km|zh)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const locale = ctx.match?.[1] || "vi";
  startWizard(adminId, "quote_footer", { locale });
  const current = String(RuntimeConfigService.get<string>(`quoteFooter${locale.toUpperCase()}`, "") || "");
  await ctx.reply(
    `✏️ <b>SỬA GHI CHÚ BÁO GIÁ (${locale.toUpperCase()})</b>\n\n` +
      (current ? `Hiện tại:\n<code>${escapeHtml(current)}</code>\n\n` : "") +
      "Gửi nội dung PLAIN TEXT mới (nhiều dòng, @username, địa chỉ, SĐT đều được).\n" +
      `Tối đa ${QUOTE_FOOTER_MAX_LEN} ký tự. Gửi /cancel để hủy.`,
    { parse_mode: "HTML" }
  );
});

adminRatesHandler.callbackQuery("ops:qfooter:toggle", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const adminId = String(ctx.from?.id || "");
  const next = !RuntimeConfigService.get<boolean>("quoteFooterEnabled", false);
  await RuntimeConfigService.set<boolean>("quoteFooterEnabled", next, adminId);
  await AuditService.log({
    actorId: adminId,
    actorRole: "ADMIN",
    action: next ? "QUOTE_FOOTER_ENABLED" : "QUOTE_FOOTER_DISABLED",
    targetType: "SYSTEM_SETTING",
    targetId: "quoteFooter",
    details: { enabled: next }
  });
  await showQuoteFooterSettings(ctx);
});

adminRatesHandler.callbackQuery("ops:qfooter:preview", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await requirePermission(ctx, "rate.edit"))) return;
  const lines = ["👁 <b>XEM TRƯỚC FOOTER BÁO GIÁ</b>", "", "──────────"];
  for (const { locale, flag, label } of QUOTE_FOOTER_LOCALES) {
    const footer = getQuoteFooterFor(locale);
    lines.push(`${flag} ${label}: ${footer ? escapeHtml(footer) : "(không có)"}`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" }).catch(() => {});
});

/** Admin freeform input for the quote_footer wizard (dispatched from admin/index.ts). */
export async function handleQuoteFooterInput(ctx: BotContext, text: string): Promise<boolean> {
  const adminId = String(ctx.from?.id || "");
  const session = getAdminSession(adminId);
  if (session.wizard?.kind !== "quote_footer") return false;
  if (isSessionExpired(adminId)) {
    clearWizard(adminId);
    await ctx.reply("⏱ Phiên đã hết hạn.").catch(() => {});
    return true;
  }
  const locale = String(session.wizard.data?.locale || "vi");
  const content = text.trim();
  if (content.toLowerCase() === "xoa" || content === "-") {
    await RuntimeConfigService.set(`quoteFooter${locale.toUpperCase()}`, "", adminId);
    clearWizard(adminId);
    await ctx.reply("✅ Đã xóa ghi chú cho ngôn ngữ này.").catch(() => {});
    await showQuoteFooterSettings(ctx);
    return true;
  }
  if (content.length > QUOTE_FOOTER_MAX_LEN) {
    await ctx.reply(`❌ Quá dài (${content.length}/${QUOTE_FOOTER_MAX_LEN} ký tự). Gửi lại ngắn hơn.`).catch(() => {});
    return true;
  }
  await RuntimeConfigService.set(`quoteFooter${locale.toUpperCase()}`, content, adminId);
  clearWizard(adminId);
  await AuditService.log({
    actorId: adminId,
    actorRole: "ADMIN",
    action: "QUOTE_FOOTER_UPDATED",
    targetType: "SYSTEM_SETTING",
    targetId: `quoteFooter${locale.toUpperCase()}`,
    details: { locale, length: content.length }
  });
  await ctx.reply("✅ Đã lưu ghi chú báo giá (áp dụng cho báo giá MỚI).").catch(() => {});
  await showQuoteFooterSettings(ctx);
  return true;
}


