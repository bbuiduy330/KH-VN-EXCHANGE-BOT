/**
 * Admin secondary screens — Rate (Phase 1), AI status, Payment accounts,
 * Staff, Config, Audit, Help, Advanced commands. All read-only for Phase 1.
 */
import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { prisma } from "../../database/client.js";
import { PaymentAccountService } from "../../modules/payment-accounts/account-service.js";
import { AuditService } from "../../modules/audit/audit-service.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { SystemSecretService } from "../../modules/system-config/system-secret-service.js";
import { RuntimeConfigService } from "../../modules/system-config/runtime-config-service.js";
import { GeminiModelStrategy } from "../../modules/ai/gemini-models.js";
import { MoneyService } from "../../modules/money/money-service.js";
import { escapeHtml } from "../menus/cskh-panel.js";
import { maskAccountNumber, timeAgo } from "./admin-panel.js";

export const adminScreensHandler = new Composer<BotContext>();

async function replyOrEdit(ctx: BotContext, text: string, kb: InlineKeyboard): Promise<void> {
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
// Rate screen (Phase 1 — read-only, no one-click mutation)
// ---------------------------------------------------------------------------

export async function showRateScreen(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "rate.view"))) return;

  const usdVnd = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
  const lines = ["💱 <b>QUẢN LÝ TỶ GIÁ</b>", ""];

  if (usdVnd) {
    const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(usdVnd.baseRate, usdVnd.buyMargin, usdVnd.sellMargin);
    lines.push(`USD → VND: <b>1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND</b>`);
    lines.push(`VND → USD: <b>1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND</b>`);
    lines.push("", `🕒 Cập nhật: ${timeAgo(usdVnd.updatedAt)}`);
    lines.push(`👤 Cập nhật bởi: ${escapeHtml(usdVnd.updatedBy || "—")}`);
  } else {
    lines.push("Chưa cấu hình cặp USD/VND.");
  }

  const kb = new InlineKeyboard()
    .text("✏️ USD → VND", "ops:rates:edit:usd_vnd")
    .text("✏️ VND → USD", "ops:rates:edit:vnd_usd")
    .row()
    .text("🔄 Cập nhật cả hai", "ops:rates:edit:both")
    .row()
    .text("ℹ️ Chi tiết tỷ giá", "ops:rates:detail")
    .text("🏠 Menu Admin", "ops:home");

  await replyOrEdit(ctx, lines.join("\n"), kb);
}

/** Pure detail render — deliberately never claims historical rate history. */
export function renderRateDetailText(usdVnd: any): string {
  const lines = ["ℹ️ <b>CHI TIẾT TỶ GIÁ</b>", ""];
  if (!usdVnd) {
    lines.push("Chưa cấu hình cặp USD/VND.");
    return lines.join("\n");
  }
  const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(usdVnd.baseRate, usdVnd.buyMargin, usdVnd.sellMargin);
  lines.push(`USD → VND: <b>1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND</b>`);
  lines.push(`VND → USD: <b>1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND</b>`);
  lines.push(
    "",
    `Base: ${MoneyService.formatAmount(usdVnd.baseRate, "VND")}`,
    `Buy margin: -${usdVnd.buyMargin}`,
    `Sell margin: +${usdVnd.sellMargin}`,
    `Phí: ${MoneyService.formatMoney(usdVnd.fee, usdVnd.feeCurrency)}`,
    "",
    `🕒 Cập nhật: ${timeAgo(usdVnd.updatedAt)}`,
    `👤 Cập nhật bởi: ${escapeHtml(usdVnd.updatedBy || "—")}`,
    "",
    "⚠️ Chưa có bảng lịch sử tỷ giá (sẽ bổ sung ở Phase 2)."
  );
  return lines.join("\n");
}

export async function showRateDetail(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "rate.view"))) return;
  const usdVnd = await prisma.exchangeRate.findUnique({ where: { pair: "USD/VND" } });
  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, renderRateDetailText(usdVnd), kb);
}

async function rateEditPlaceholder(ctx: BotContext): Promise<void> {
  ctx.answerCallbackQuery().catch(() => {});
  const text =
    `✏️ <b>CẬP NHẬT TỶ GIÁ (Phase 2)</b>\n\n` +
    `Trình cập nhật tỷ giá linh hoạt (26200, +50, -100, "tăng usd vnd thêm 50", cập nhật cả hai chiều, xem trước số báo giá bị vô hiệu, xác nhận cuối, setRateAndInvalidate()) sẽ ra mắt ở Phase 2.\n\n` +
    `Hiện tại dùng lệnh an toàn:\n<code>/setrate USD/VND base buyMargin sellMargin fee feeCurrency</code>`;
  await ctx.reply(text, { parse_mode: "HTML" });
}

// ---------------------------------------------------------------------------
// AI status screen (SAFE status only — never expose the key)
// ---------------------------------------------------------------------------

export async function showAiStatus(ctx: BotContext): Promise<void> {
  const resolved = await SystemSecretService.resolveGeminiApiKey();
  const configured = Boolean(resolved.key && resolved.key.length > 0);
  const sourceLabel = resolved.source === "ENCRYPTED_DB" ? "ENCRYPTED_DB" : resolved.source === "ENV" ? "ENV" : "NONE";
  const textModel = RuntimeConfigService.getGeminiTextModel();
  const transcribeModel = RuntimeConfigService.getGeminiTranscribeModel() || GeminiModelStrategy.getPrimaryModel();

  const lines = [
    "🤖 <b>TRẠNG THÁI AI</b>",
    "",
    `🔑 API Key: ${configured ? "✅ Đã cấu hình" : "❌ Chưa cấu hình"}`,
    `Nguồn: <b>${sourceLabel}</b>`,
    "",
    `🧠 Text model: <b>${escapeHtml(textModel)}</b>`,
    `🎙 Voice model hiệu dụng: <b>${escapeHtml(transcribeModel)}</b>`
  ];

  const kb = new InlineKeyboard()
    .text("🧪 Test AI", "ops:ai:test")
    .text("🏠 Menu Admin", "ops:home");

  await replyOrEdit(ctx, lines.join("\n"), kb);
}

async function testAi(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Đang kiểm tra AI...");
  const waitMsg = await ctx.reply("⏳ Đang kiểm tra kết nối Google Gemini API...");
  const result = await AiProvider.testGeminiConnection();

  const lines = [
    "🧪 <b>KẾT QUẢ KIỂM TRA AI</b>",
    "",
    `Kết nối: ${result.ok ? "✅ OK" : "❌ LỖI"}`,
    `Model thực tế: <b>${escapeHtml(result.actualModel || "N/A")}</b>`,
    `Độ trễ: ${result.latencyMs} ms`
  ];
  if (!result.ok && result.error) {
    lines.push(`Lỗi: <code>${escapeHtml(String(result.error).slice(0, 200))}</code>`);
  }

  await ctx.api.editMessageText(ctx.chat!.id, waitMsg.message_id, lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("🏠 Menu Admin", "ops:home")
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Payment accounts (SYSTEM receiving accounts — NOT customer payout banks)
// ---------------------------------------------------------------------------

export async function showPaymentAccounts(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "payment_account.view"))) return;
  const accounts = await PaymentAccountService.getAllAccounts();

  const lines = ["🏦 <b>TÀI KHOẢN THANH TOÁN (NHẬN TIỀN)</b>", ""];
  if (accounts.length === 0) {
    lines.push("Chưa có tài khoản nhận nào.");
  } else {
    for (const a of accounts) {
      lines.push(
        `• <b>${escapeHtml(a.currency)}</b> ${escapeHtml(a.bankName)} · ${escapeHtml(maskAccountNumber(a.accountNumber))} · ${a.isActive ? "🟢 Hoạt động" : "⚪ Tạm ngưng"}${a.isDefault ? " · Mặc định" : ""}`
      );
    }
  }

  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, lines.join("\n"), kb);
}

// ---------------------------------------------------------------------------
// Staff list (readable, no full internal UUID)
// ---------------------------------------------------------------------------

export async function showStaffList(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "staff.manage"))) return;
  const staff = await prisma.staffUser.findMany({ orderBy: { createdAt: "asc" }, take: 50 });

  const lines = ["👨‍💼 <b>NHÂN VIÊN</b>", ""];
  if (staff.length === 0) {
    lines.push("Chưa có nhân sự nào.");
  } else {
    const roleLabel: Record<string, string> = { SUPER_ADMIN: "Super Admin", ADMIN: "Admin", CSKH: "CSKH" };
    const statusLabel: Record<string, string> = { ACTIVE: "🟢 Hoạt động", PENDING: "🟡 Chờ duyệt", DISABLED: "⚪ Vô hiệu" };
    for (const s of staff) {
      lines.push(`• <b>${escapeHtml(s.name)}</b> (${roleLabel[s.role] || s.role}) · ${statusLabel[s.status] || s.status} · TG <code>${escapeHtml(s.telegramId)}</code>`);
    }
  }

  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, lines.join("\n"), kb);
}

// ---------------------------------------------------------------------------
// Config / Audit / Help / Advanced
// ---------------------------------------------------------------------------

export async function showConfig(ctx: BotContext): Promise<void> {
  const cfg = RuntimeConfigService.getConfig();
  const lines = [
    "⚙️ <b>CẤU HÌNH</b>",
    "",
    `🧠 Text model: <b>${escapeHtml(cfg.geminiTextModel)}</b>`,
    `🎙 Voice model: <b>${escapeHtml(cfg.geminiTranscribeModel || GeminiModelStrategy.getPrimaryModel())}</b>`,
    `💾 Sao lưu tự động: ${cfg.backupEnabled ? "BẬT" : "TẮT"}`,
    `💵 Phí dịch vụ mặc định: ${cfg.defaultServiceFeeUsd} USD`,
    `⚠️ Ngưỡng giao dịch lớn: ${cfg.largeTransactionThresholdUsd} USD`,
    `⏱ Quote hết hạn: ${cfg.quoteExpiryMinutes} phút`,
    `🔔 Cảnh báo chờ thanh toán: ${cfg.paymentWaitAlertMinutes} phút`
  ];
  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, lines.join("\n"), kb);
}

export async function showAudit(ctx: BotContext): Promise<void> {
  if (!(await requirePermission(ctx, "audit.view"))) return;
  const logs = await AuditService.getLogs(undefined, 8);
  const lines = ["📜 <b>NHẬT KÝ GẦN ĐÂY</b>", ""];
  if (logs.length === 0) {
    lines.push("Chưa có bản ghi nào.");
  } else {
    for (const l of logs) {
      lines.push(`• [${escapeHtml(l.action)}] ${escapeHtml(l.actorRole)} ${escapeHtml(l.actorId)} · ${timeAgo(l.createdAt)}`);
    }
  }
  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, lines.join("\n"), kb);
}

export async function showHelp(ctx: BotContext): Promise<void> {
  const text =
    `❓ <b>HƯỚNG DẪN</b>\n\n` +
    `Dùng bàn phím cố định bên dưới ô nhập để điều hướng:\n` +
    `• 🏠 <b>Menu Admin</b> — mở Trung tâm quản trị.\n` +
    `• 🔴 <b>Việc cần xử lý</b> — bill chờ xác minh, chờ payout, khách chờ CSKH.\n` +
    `• 📦 <b>Đơn hàng</b> — danh sách, lọc, tìm đơn.\n` +
    `• 💱 <b>Tỷ giá</b> — xem tỷ giá hiện tại.\n` +
    `• 👥 <b>Khách hàng</b> — tìm và xem khách.\n` +
    `• 💬 <b>CSKH</b> — phiên hỗ trợ đang chờ / đang xử lý.`;
  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, text, kb);
}

export async function showAdvancedCommands(ctx: BotContext): Promise<void> {
  const text =
    `⌨️ <b>LỆNH NÂNG CAO</b>\n\n` +
    `Các lệnh kỹ thuật (không cần dùng cho vận hành hằng ngày):\n` +
    `• 💱 <code>/rates</code> · <code>/setrate</code>\n` +
    `• 🏦 <code>/accounts</code> · <code>/addqr</code>\n` +
    `• 👨‍💼 <code>/staff</code> · <code>/invite</code>\n` +
    `• 🤖 <code>/setkey</code> · <code>/testai</code>\n` +
    `• 💾 <code>/backup</code> · <code>/audit</code>`;
  const kb = new InlineKeyboard().text("🏠 Menu Admin", "ops:home");
  await replyOrEdit(ctx, text, kb);
}

adminScreensHandler.callbackQuery("ops:rates", (ctx) => showRateScreen(ctx));
adminScreensHandler.callbackQuery(/^ops:rates:edit:(usd_vnd|vnd_usd|both)$/, (ctx) => rateEditPlaceholder(ctx));
adminScreensHandler.callbackQuery("ops:rates:detail", (ctx) => showRateDetail(ctx));
adminScreensHandler.callbackQuery("ops:ai", (ctx) => showAiStatus(ctx));
adminScreensHandler.callbackQuery("ops:ai:test", (ctx) => testAi(ctx));
adminScreensHandler.callbackQuery("ops:accounts", (ctx) => showPaymentAccounts(ctx));
adminScreensHandler.callbackQuery("ops:staff", (ctx) => showStaffList(ctx));
adminScreensHandler.callbackQuery("ops:config", (ctx) => showConfig(ctx));
adminScreensHandler.callbackQuery("ops:audit", (ctx) => showAudit(ctx));
adminScreensHandler.callbackQuery("ops:help", (ctx) => showHelp(ctx));
adminScreensHandler.callbackQuery("ops:advanced", (ctx) => showAdvancedCommands(ctx));


