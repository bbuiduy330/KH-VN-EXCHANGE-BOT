import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../middleware/identity.js";
import { prisma } from "../../../database/client.js";
import { SystemSecretService } from "../../../modules/system-config/system-secret-service.js";
import { RuntimeConfigService } from "../../../modules/system-config/runtime-config-service.js";
import { LocalStorageService } from "../../../modules/storage/local-storage-service.js";
import { env } from "../../../config/env.js";

export const dashboardHandler = new Composer<BotContext>();

export function getAdminHomeKeyboard(isSuperAdmin: boolean = false): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📊 Tổng quan", "admin:menu:dashboard")
    .text("📦 Đơn hàng", "admin:menu:orders")
    .row()
    .text("💱 Tỷ giá", "admin:menu:rates")
    .text("🏦 QR / Tài khoản", "admin:menu:accounts")
    .row()
    .text("💬 CSKH", "admin:menu:cskh")
    .text("👥 Nhân viên", "admin:menu:staff")
    .row()
    .text("🤖 AI / Gemini", "admin:menu:ai")
    .text("💾 Lưu trữ & Backup", "admin:menu:backup")
    .row()
    .text("🔔 Thông báo", "admin:menu:notifications")
    .text("⚙️ Cài đặt", "admin:menu:settings")
    .row()
    .text("📜 Audit Log", "admin:menu:audit")
    .text("🩺 System Health", "admin:menu:health");

  if (isSuperAdmin) {
    kb.row().text("🚀 First Run Setup", "admin:menu:firstrun");
  }

  return kb;
}

export function getBackAndHomeKeyboard(backCallback: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("⬅️ Quay lại", backCallback)
    .text("🏠 Trang chính", "admin:menu:home");
}

export async function showAdminStart(ctx: BotContext) {
  const staff = ctx.identity?.staff;
  const isSuperAdmin = ctx.identity?.userType === "SUPER_ADMIN";
  const staffName = staff?.name || (isSuperAdmin ? "Super Admin" : "Quản trị viên");

  const text =
    `🛡️ <b>HỆ THỐNG QUẢN TRỊ KH-VN EXCHANGE</b>\n\n` +
    `Xin chào <b>${staffName}</b>! (${ctx.identity?.userType})\n` +
    `Vui lòng chọn tính năng bên dưới để bắt đầu:`;

  const keyboard = getAdminHomeKeyboard(isSuperAdmin);

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  }
}

// Return to admin home
dashboardHandler.callbackQuery("admin:menu:home", async (ctx) => {
  await showAdminStart(ctx);
});

// Dashboard Overview
dashboardHandler.callbackQuery("admin:menu:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  const isSuperAdmin = ctx.identity?.userType === "SUPER_ADMIN";

  const [totalOrders, waitingVerify, waitingPayout, ratesCount, staffCount] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "WAITING_ADMIN_VERIFY" } }),
    prisma.order.count({ where: { status: "WAITING_PAYOUT" } }),
    prisma.exchangeRate.count(),
    prisma.staff.count({ where: { status: "ACTIVE" } })
  ]);

  const text =
    `📊 <b>TỔNG QUAN HỆ THỐNG</b>\n\n` +
    `• <b>Tổng số đơn:</b> <code>${totalOrders}</code>\n` +
    `• <b>Đơn chờ duyệt tiền vào:</b> <code>${waitingVerify}</code>\n` +
    `• <b>Đơn chờ chuyển tiền ra:</b> <code>${waitingPayout}</code>\n` +
    `• <b>Cặp tỷ giá đang cấu hình:</b> <code>${ratesCount}</code>\n` +
    `• <b>Nhân sự đang hoạt động:</b> <code>${staffCount}</code>\n\n` +
    `<i>Bấm phím tắt bên dưới để xử lý nhanh:</i>`;

  const kb = new InlineKeyboard()
    .text("🔍 Đơn chờ duyệt", "admin:orders:filter:WAITING_ADMIN_VERIFY")
    .text("💸 Đơn chờ chi trả", "admin:orders:filter:WAITING_PAYOUT")
    .row()
    .text("⬅️ Quay lại", "admin:menu:home")
    .text("🏠 Trang chính", "admin:menu:home");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// First Run Setup Checklist
dashboardHandler.callbackQuery("admin:menu:firstrun", async (ctx) => {
  await ctx.answerCallbackQuery();
  const isSuperAdmin = ctx.identity?.userType === "SUPER_ADMIN";
  if (!isSuperAdmin) {
    return ctx.reply("⛔ Chỉ Super Admin mới có quyền truy cập First Run Setup.");
  }

  // Evaluate Checklist
  const geminiResolved = await SystemSecretService.resolveGeminiApiKey();
  const hasGemini = Boolean(geminiResolved.key && geminiResolved.key.length > 0);

  const ratesCount = await prisma.exchangeRate.count();
  const hasRates = ratesCount > 0;

  const accountsCount = await prisma.paymentAccount.count();
  const hasAccounts = accountsCount > 0;

  const isStorageOk = LocalStorageService.isReady();
  const isBackupEnabled = RuntimeConfigService.isBackupEnabled();
  const hasSuperAdmin = Boolean(env.SUPER_ADMIN_TELEGRAM_ID);

  const text =
    `🚀 <b>FIRST RUN SETUP & CHECKLIST HOÀN TẤT TRIỂN KHAI</b>\n\n` +
    `Hệ thống kiểm tra các thành phần cốt lõi để sẵn sàng vận hành an toàn:\n\n` +
    `1. <b>Cơ sở dữ liệu (PostgreSQL/DB):</b> ✅ Hoạt động bình thường\n` +
    `2. <b>Lưu trữ bằng chứng cục bộ:</b> ${isStorageOk ? "✅ Sẵn sàng" : "⚠️ Cần kiểm tra thư mục"}\n` +
    `3. <b>Super Admin Telegram:</b> ${hasSuperAdmin ? `✅ Đã thiết lập (<code>${env.SUPER_ADMIN_TELEGRAM_ID}</code>)` : "⚠️ Chưa thiết lập"}\n` +
    `4. <b>Google Gemini AI Key:</b> ${hasGemini ? `✅ Đã cấu hình (${geminiResolved.source})` : "❌ Chưa cấu hình"}\n` +
    `5. <b>Tỷ giá quy đổi (Rates):</b> ${hasRates ? `✅ Đã có ${ratesCount} cặp tỷ giá` : "❌ Chưa cấu hình tỷ giá"}\n` +
    `6. <b>Tài khoản nhận tiền (QR):</b> ${hasAccounts ? `✅ Đã có ${accountsCount} tài khoản` : "❌ Chưa cấu hình QR/Tài khoản"}\n` +
    `7. <b>Sao lưu từ xa (Backup):</b> ${isBackupEnabled ? "✅ Đã bật" : "⚠️ Đang tắt"}\n\n` +
    `<i>Bấm các nút dưới đây để thiết lập ngay các mục còn thiếu:</i>`;

  const kb = new InlineKeyboard();

  if (!hasGemini) {
    kb.text("🔑 Cài Gemini API Key", "admin:ai:setkey").row();
  }
  if (!hasRates) {
    kb.text("💱 Cài đặt tỷ giá", "admin:menu:rates").row();
  }
  if (!hasAccounts) {
    kb.text("🏦 Thêm tài khoản QR", "admin:menu:accounts").row();
  }
  if (!isBackupEnabled) {
    kb.text("💾 Bật sao lưu", "admin:backup:toggle").row();
  }

  kb.text("⬅️ Quay lại", "admin:menu:home")
    .text("🔄 Quét lại", "admin:menu:firstrun");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});
