import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../middleware/identity.js";
import { requirePermission } from "../middleware/permissions.js";
import { PermissionService, ALL_PERMISSIONS, Permission } from "../../modules/permissions/permission-service.js";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { PaymentAccountService } from "../../modules/payment-accounts/account-service.js";
import { OrderService } from "../../modules/orders/order-service.js";
import { AuditService } from "../../modules/audit/audit-service.js";
import { LocalStorageService } from "../../modules/storage/local-storage-service.js";
import { FileService } from "../../modules/files/file-service.js";
import { env } from "../../config/env.js";
import { sendToCustomer, sendToAdminNotificationChat } from "../notifications.js";
import { getAdminMenuKeyboard, renderAdminStartText } from "../menus/admin-menu.js";
import { prisma } from "../../database/client.js";
import { AiProvider } from "../../modules/ai/ai-provider.js";
import { SystemConfigService } from "../../modules/system-config/system-config-service.js";
import { BackupService } from "../../modules/backup/backup-service.js";

export const adminHandler = new Composer<BotContext>();

export async function showAdminStart(ctx: BotContext) {
  const staff = ctx.identity?.staff;
  const isSuperAdmin = ctx.identity?.userType === "SUPER_ADMIN";
  const staffName = staff?.name || (isSuperAdmin ? "Super Admin" : "Quản trị viên");
  const text = renderAdminStartText(staffName, isSuperAdmin);
  const keyboard = getAdminMenuKeyboard(isSuperAdmin);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
}

// /admin command
adminHandler.command("admin", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền truy cập chức năng này.");
  }
  await showAdminStart(ctx);
});

// /testai and /testgemini commands for quick diagnostic in Telegram
adminHandler.command(["testai", "testgemini"], async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Chỉ quản trị viên mới có quyền kiểm tra kết nối AI.");
  }

  const waitMsg = await ctx.reply("⏳ Đang gửi yêu cầu kiểm tra tới Google Gemini API...");

  const result = await AiProvider.testGeminiConnection();

  if (result.ok) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `✅ <b>GOOGLE GEMINI AI HOẠT ĐỘNG TỐT!</b>\n\n` +
        `• <b>Model:</b> <code>${result.model}</code>\n` +
        `• <b>Độ trễ:</b> <code>${result.latencyMs} ms</code>\n` +
        `• <b>Phản hồi:</b>\n<i>"${result.reply}"</i>\n\n` +
        `💡 <i>API Key đã kết nối thành công và đã ghi nhận token sử dụng trên Google AI Studio.</i>`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `❌ <b>KẾT NỐI GEMINI AI THẤT BẠI!</b>\n\n` +
        `• <b>Model:</b> <code>${result.model}</code>\n` +
        `• <b>Chi tiết lỗi:</b>\n<code>${result.error}</code>\n\n` +
        `🔧 <b>Khắc phục:</b>\n` +
        `1. Kiểm tra biến <code>GEMINI_API_KEY</code> trong file <code>.env</code> trên VPS.\n` +
        `2. Xem quota tại <a href="https://aistudio.google.com/">Google AI Studio</a>.\n` +
        `3. Đảm bảo cấu hình <code>GEMINI_TEXT_MODEL=gemini-3.6-flash</code>.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  }
});

// Helper for rendering dynamic settings view
function renderSystemSettingsView(): { text: string; keyboard: InlineKeyboard } {
  const cfg = SystemConfigService.getConfig();
  const maskedKey = cfg.geminiApiKey
    ? `${cfg.geminiApiKey.slice(0, 7)}...${cfg.geminiApiKey.slice(-4)} (Đã kích hoạt)`
    : "❌ Chưa cài đặt (Dùng /setkey <key> để cài)";

  const history = BackupService.getHistory();
  const lastBackup = history[0];
  const lastBackupStr = lastBackup
    ? `${new Date(lastBackup.timestamp).toLocaleString("vi-VN")} (${lastBackup.sizeFormatted})`
    : "Chưa có bản sao lưu";

  const text =
    `⚙️ <b>BẢNG ĐIỀU KHIỂN CẤU HÌNH HỆ THỐNG (TELEGRAM CONTROL)</b>\n\n` +
    `🤖 <b>Google Gemini AI:</b>\n` +
    `• API Key: <code>${maskedKey}</code>\n` +
    `• Model AI: <code>${cfg.geminiTextModel}</code>\n\n` +
    `📢 <b>Kênh nhận thông báo đơn hàng:</b>\n` +
    `• Chat ID: <code>${cfg.adminNotificationChatId || "Chưa cấu hình (Gõ /sethere)"}</code>\n\n` +
    `💾 <b>Sao lưu hệ thống (Backup):</b>\n` +
    `• Tự động sao lưu: <b>${cfg.backupEnabled ? "BẬT" : "TẮT"}</b> (Chu kỳ: <b>${cfg.backupScheduleHours}h/lần</b>)\n` +
    `• Lần sao lưu gần nhất: <i>${lastBackupStr}</i>\n\n` +
    `💵 <b>Thông số tài chính:</b>\n` +
    `• Phí dịch vụ mặc định: <b>${cfg.defaultServiceFeeUsd} USD</b>\n` +
    `• Ngưỡng GD lớn: <b>${cfg.largeTransactionThresholdUsd.toLocaleString()} USD</b>\n` +
    `• Thời hạn giữ báo giá: <b>${cfg.quoteExpiryMinutes} phút</b>\n\n` +
    `📌 <b>CÁC LỆNH CÀI ĐẶT NHANH TỪ TELEGRAM:</b>\n` +
    `• <code>/setkey &lt;key&gt;</code> - Cài/Đổi Gemini API Key trực tiếp\n` +
    `• <code>/setmodel &lt;model&gt;</code> - Đổi Model AI\n` +
    `• <code>/sethere</code> - Đặt phòng chat này làm kênh nhận thông báo đơn hàng\n` +
    `• <code>/backup</code> - Kích hoạt sao lưu hệ thống ngay lập tức\n` +
    `• <code>/backups</code> - Xem lịch sử các bản sao lưu VPS\n` +
    `• <code>/setbackup &lt;giờ&gt;</code> - Đổi chu kỳ sao lưu (VD: <code>/setbackup 6</code>)\n` +
    `• <code>/togglebackup</code> - Bật/Tắt tự động sao lưu định kỳ\n` +
    `• <code>/setfee &lt;usd&gt;</code> - Đổi phí giao dịch mặc định\n` +
    `• <code>/setthreshold &lt;usd&gt;</code> - Đổi ngưỡng GD lớn\n` +
    `• <code>/testai</code> - Kiểm tra kết nối và độ trễ Gemini AI\n`;

  const keyboard = new InlineKeyboard()
    .text("🔑 Hướng dẫn đổi Key", "admin:settings:ask_key")
    .text("🤖 Chọn Model AI", "admin:settings:model_select")
    .row()
    .text("📢 Đặt kênh này (/sethere)", "admin:settings:sethere")
    .text("💾 Sao lưu ngay", "admin:backup:run_now")
    .row()
    .text("📜 Lịch sử Sao lưu", "admin:backup:history")
    .text("🧪 Test Gemini AI", "admin:settings:test_ai")
    .row()
    .text("🔄 Làm mới", "admin:settings:refresh")
    .text("🔙 Về Menu chính", "admin:menu:back_start");

  return { text, keyboard };
}

// /settings and /config commands
adminHandler.command(["settings", "config"], async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền truy cập bảng cài đặt hệ thống.");
  }
  const view = renderSystemSettingsView();
  await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
});

// /setkey command: Set Gemini API key directly from chat
adminHandler.command("setkey", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Chỉ quản trị viên mới có quyền cài đặt API Key.");
  }

  const newKey = ctx.match?.trim();
  if (!newKey) {
    return ctx.reply(
      "🔑 <b>HƯỚNG DẪN CÀI ĐẶT GOOGLE GEMINI API KEY:</b>\n\n" +
        "1. Lấy API Key miễn phí tại: https://aistudio.google.com/app/apikey\n" +
        "2. Gửi lệnh theo cú pháp:\n" +
        "<code>/setkey AIzaSyDxxxxxxxxxxxxxx</code>\n\n" +
        "💡 <i>Hệ thống sẽ kiểm tra kết nối với Google trước khi lưu. Khi lưu thành công, AI sẽ hoạt động ngay lập tức mà không cần khởi động lại VPS.</i>",
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
  }

  const waitMsg = await ctx.reply("⏳ Đang kiểm tra kết nối với Google Gemini API...");
  const testRes = await AiProvider.testGeminiConnection(newKey);

  if (!testRes.ok) {
    return ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `❌ <b>API KEY KHÔNG HỢP LỆ HOẶC KHÔNG KẾT NỐI ĐƯỢC:</b>\n\n` +
        `• Chi tiết lỗi:\n<code>${testRes.error}</code>\n\n` +
        `🔧 Hệ thống chưa lưu key này. Vui lòng kiểm tra lại key trên Google AI Studio.`,
      { parse_mode: "HTML" }
    );
  }

  SystemConfigService.updateConfig({ geminiApiKey: newKey }, ctx.identity?.telegramId || "ADMIN");

  await ctx.api.editMessageText(
    ctx.chat!.id,
    waitMsg.message_id,
    `✅ <b>ĐÃ CẬP NHẬT GOOGLE GEMINI API KEY THÀNH CÔNG!</b>\n\n` +
      `• Model: <code>${testRes.model}</code>\n` +
      `• Độ trễ: <code>${testRes.latencyMs} ms</code>\n` +
      `• Phản hồi thử nghiệm: <i>"${testRes.reply}"</i>\n\n` +
      `💾 <i>Key đã được lưu an toàn vào hệ thống VPS và kích hoạt ngay lập tức. Khách hàng giờ đây có thể trò chuyện với Trợ lý AI và phân tích hóa đơn thông minh!</i>`,
    { parse_mode: "HTML" }
  );
});

// /setmodel command: Set Gemini model
adminHandler.command("setmodel", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi Model AI.");
  }

  const model = ctx.match?.trim();
  if (!model) {
    const keyboard = new InlineKeyboard()
      .text("⚡ gemini-3.6-flash (Khuyên dùng)", "admin:set_model:gemini-3.6-flash")
      .row()
      .text("🪶 gemini-3.5-flash-lite (Siêu nhẹ)", "admin:set_model:gemini-3.5-flash-lite")
      .row()
      .text("🧠 gemini-3.8-flash (Model mới)", "admin:set_model:gemini-3.8-flash")
      .row()
      .text("🔙 Quay lại Cài đặt", "admin:menu:settings");

    return ctx.reply("🤖 <b>CHỌN MODEL GOOGLE GEMINI AI:</b>\n\nChọn một trong các model bên dưới:", {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  }

  SystemConfigService.updateConfig({ geminiTextModel: model }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Đã chuyển Model AI sang: <code>${model}</code>`, { parse_mode: "HTML" });
});

// /sethere command: Set current chat/group as admin notification channel
adminHandler.command("sethere", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đặt kênh thông báo.");
  }

  const chatId = String(ctx.chat!.id);
  SystemConfigService.updateConfig({ adminNotificationChatId: chatId }, ctx.identity?.telegramId || "ADMIN");

  await ctx.reply(
    `✅ <b>ĐÃ ĐẶT PHÒNG CHAT NÀY LÀM KÊNH NHẬN THÔNG BÁO ĐƠN HÀNG!</b>\n\n` +
      `• Chat ID: <code>${chatId}</code>\n` +
      `• Tiêu đề: <b>${ctx.chat && "title" in ctx.chat ? ctx.chat.title : "Chat riêng"}</b>\n\n` +
      `🔔 Từ bây giờ, tất cả thông báo đơn mới, khách gửi bill nạp tiền và các cảnh báo hệ thống sẽ được gửi vào đây.`,
    { parse_mode: "HTML" }
  );
});

// /setnotify command: Set specific chat ID
adminHandler.command("setnotify", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi kênh thông báo.");
  }

  const chatId = ctx.match?.trim();
  if (!chatId) {
    return ctx.reply("Vui lòng nhập Chat ID, ví dụ: <code>/setnotify -100123456789</code>\nHoặc vào phòng chat cần nhận và gõ <code>/sethere</code>", { parse_mode: "HTML" });
  }

  SystemConfigService.updateConfig({ adminNotificationChatId: chatId }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Đã đặt Chat ID nhận thông báo thành: <code>${chatId}</code>`, { parse_mode: "HTML" });
});

// /backup command: Run backup immediately from chat
adminHandler.command("backup", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền sao lưu hệ thống.");
  }

  const waitMsg = await ctx.reply("⏳ <b>ĐANG TIẾN HÀNH SAO LƯU DỮ LIỆU HỆ THỐNG TRÊN VPS...</b>\n<i>Quá trình này bao gồm Database và toàn bộ ảnh biên lai/chứng từ giao dịch.</i>", { parse_mode: "HTML" });

  const result = await BackupService.runBackup(ctx.identity?.telegramId || "ADMIN");

  if (result.success) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `✅ <b>SAO LƯU HỆ THỐNG THÀNH CÔNG!</b>\n\n` +
        `• Trạng thái: <b>HOÀN TẤT</b>\n` +
        `• Phương thức: <code>${result.record?.type || "SNAPSHOT"}</code>\n` +
        `• Dung lượng: <b>${result.record?.sizeFormatted || "OK"}</b>\n` +
        `• Chi tiết: <i>${result.record?.details || result.message}</i>\n` +
        `• Thời gian: <code>${new Date().toLocaleString("vi-VN")}</code>\n\n` +
        `💾 Dữ liệu đã được bảo vệ an toàn trên ổ đĩa VPS.`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `❌ <b>SAO LƯU THẤT BẠI:</b>\n\n<code>${result.message}</code>`,
      { parse_mode: "HTML" }
    );
  }
});

// /backups command: View backup history
adminHandler.command("backups", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền xem lịch sử sao lưu.");
  }

  const history = BackupService.getHistory();
  if (history.length === 0) {
    return ctx.reply("Chưa có bản sao lưu nào được tạo. Gõ <code>/backup</code> để tạo bản sao lưu đầu tiên.", { parse_mode: "HTML" });
  }

  let msg = `💾 <b>DANH SÁCH BẢN SAO LƯU HỆ THỐNG GẦN NHẤT:</b>\n\n`;
  for (const b of history.slice(0, 10)) {
    const timeStr = new Date(b.timestamp).toLocaleString("vi-VN");
    msg += `• <b>${b.id}</b> [${b.type}]\n  📅 ${timeStr} | 📦 ${b.sizeFormatted} | ${b.status === "SUCCESS" ? "✅" : "❌"}\n`;
  }

  msg += `\n💡 <i>Gõ /backup để chạy sao lưu ngay bây giờ.</i>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// /setbackup command: Set backup schedule in hours
adminHandler.command("setbackup", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi lịch sao lưu.");
  }

  const val = parseInt(ctx.match?.trim() || "", 10);
  if (isNaN(val) || val < 1 || val > 168) {
    return ctx.reply("Vui lòng nhập chu kỳ sao lưu bằng số giờ (từ 1 đến 168), ví dụ: <code>/setbackup 6</code>", { parse_mode: "HTML" });
  }

  SystemConfigService.updateConfig({ backupScheduleHours: val }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Đã đặt chu kỳ tự động sao lưu thành: <b>Mỗi ${val} giờ</b>`, { parse_mode: "HTML" });
});

// /togglebackup command: Toggle backup on/off
adminHandler.command("togglebackup", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi trạng thái sao lưu.");
  }

  const current = SystemConfigService.isBackupEnabled();
  const next = !current;
  SystemConfigService.updateConfig({ backupEnabled: next }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Tự động sao lưu định kỳ hiện đang: <b>${next ? "BẬT" : "TẮT"}</b>`, { parse_mode: "HTML" });
});

// /setfee command: Set default service fee in USD
adminHandler.command("setfee", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi phí dịch vụ.");
  }

  const val = parseFloat(ctx.match?.trim() || "");
  if (isNaN(val) || val < 0) {
    return ctx.reply("Vui lòng nhập phí dạng số (USD), ví dụ: <code>/setfee 2</code> hoặc <code>/setfee 1.5</code>", { parse_mode: "HTML" });
  }

  SystemConfigService.updateConfig({ defaultServiceFeeUsd: val }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Đã đổi phí dịch vụ mặc định thành: <b>${val} USD</b>`, { parse_mode: "HTML" });
});

// /setthreshold command: Set large transaction threshold in USD
adminHandler.command("setthreshold", async (ctx) => {
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền đổi ngưỡng giao dịch lớn.");
  }

  const val = parseFloat(ctx.match?.trim() || "");
  if (isNaN(val) || val <= 0) {
    return ctx.reply("Vui lòng nhập số tiền (USD), ví dụ: <code>/setthreshold 5000</code>", { parse_mode: "HTML" });
  }

  SystemConfigService.updateConfig({ largeTransactionThresholdUsd: val }, ctx.identity?.telegramId || "ADMIN");
  await ctx.reply(`✅ Đã đổi ngưỡng cảnh báo giao dịch lớn thành: <b>${val.toLocaleString()} USD</b>`, { parse_mode: "HTML" });
});

// /rates command
adminHandler.command("rates", async (ctx) => {
  const allowed = await requirePermission(ctx, "rate.view");
  if (!allowed) return;

  const rates = await QuoteService.getAllRates();
  if (rates.length === 0) return ctx.reply("Chưa có tỷ giá nào được cấu hình.");

  let msg = `📈 <b>DANH SÁCH TỶ GIÁ HIỆN TẠI:</b>\n\n`;
  for (const r of rates) {
    msg +=
      `• <b>${r.pair}</b>:\n` +
      `  Tỷ giá gốc: <code>${r.baseRate}</code>\n` +
      `  Mua vào: -<code>${r.buyMargin}</code> | Bán ra: +<code>${r.sellMargin}</code>\n` +
      `  Phí: <code>${r.fee} ${r.feeCurrency}</code> | Cập nhật bởi: <i>${r.updatedBy}</i>\n\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// /setrate command
adminHandler.command("setrate", async (ctx) => {
  const allowed = await requirePermission(ctx, "rate.edit");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  const text = ctx.match?.trim();
  if (!text) {
    return ctx.reply(
      "Cú pháp: <code>/setrate CẶP base buyMargin sellMargin fee feeCurrency</code>\n\n" +
        "Ví dụ: <code>/setrate USD/VND 26300 50 100 2 USD</code>",
      { parse_mode: "HTML" }
    );
  }

  const parts = text.split(/\s+/);
  if (parts.length < 6) {
    return ctx.reply("Thiếu tham số. Cần 6 tham số: <code>CẶP base buyMargin sellMargin fee feeCurrency</code>", {
      parse_mode: "HTML"
    });
  }

  const [pair, baseRate, buyMargin, sellMargin, fee, feeCurrency] = parts as [string, string, string, string, string, string];

  try {
    const updated = await QuoteService.setRate(pair, baseRate, buyMargin, sellMargin, fee, feeCurrency, adminId);
    await AuditService.log({
      actorId: adminId,
      actorRole: ctx.identity?.userType || "ADMIN",
      action: "RATE_UPDATED",
      targetType: "EXCHANGE_RATE",
      targetId: pair,
      details: { baseRate, buyMargin, sellMargin, fee, feeCurrency }
    });

    await ctx.reply(
      `✅ <b>ĐÃ CẬP NHẬT TỶ GIÁ CẶP ${updated.pair}:</b>\n\n` +
        `• Tỷ giá gốc: <b>${updated.baseRate}</b>\n` +
        `• Buy margin: <b>${updated.buyMargin}</b>\n` +
        `• Sell margin: <b>${updated.sellMargin}</b>\n` +
        `• Phí dịch vụ: <b>${updated.fee} ${updated.feeCurrency}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi thiết lập tỷ giá: ${err.message}`);
  }
});

// /accounts command
adminHandler.command("accounts", async (ctx) => {
  const allowed = await requirePermission(ctx, "payment_account.view");
  if (!allowed) return;

  const accounts = await PaymentAccountService.getAllAccounts();
  if (accounts.length === 0) return ctx.reply("Chưa có tài khoản nhận tiền nào.");

  let msg = `🏦 <b>DANH SÁCH TÀI KHOẢN NHẬN TIỀN &amp; QR:</b>\n\n`;
  for (const a of accounts) {
    msg +=
      `• [<b>${a.currency}</b>] <b>${a.bankName}</b> - <code>${a.accountNumber}</code> (${a.accountName})\n` +
      `  Tag: <i>${a.tag}</i> | QR Version: <b>v${a.qrVersion}</b> | SHA: <code>${a.qrSha256 ? a.qrSha256.slice(0, 10) + "..." : "Không có"}</code>\n\n`;
  }
  msg += `<i>Thêm QR mới: Gửi ảnh kèm chú thích: /addqr CURRENCY|BANK|NAME|NUMBER|TAG</i>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// /pending command
adminHandler.command("pending", async (ctx) => {
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const pendingOrders = await prisma.order.findMany({
    where: { status: { in: ["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS"] } },
    include: { customer: true },
    orderBy: { createdAt: "asc" }
  });
  const waitingPayout = await OrderService.getOrdersByStatus("WAITING_PAYOUT");
  const payoutSent = await OrderService.getOrdersByStatus("PAYOUT_SENT");

  if (pendingOrders.length === 0 && waitingPayout.length === 0 && payoutSent.length === 0) {
    return ctx.reply("✅ Hiện không có đơn hàng nào đang chờ xử lý.");
  }

  let msg = `📋 <b>DANH SÁCH ĐƠN HÀNG CẦN XỬ LÝ:</b>\n\n`;

  if (pendingOrders.length > 0) {
    msg += `<b>1. Chờ kiểm tra tiền nạp (${pendingOrders.length}):</b>\n`;
    for (const o of pendingOrders) {
      const tag = o.status === "SUSPICIOUS" ? " [🚨 CẢNH BÁO]" : o.status === "MANUAL_REVIEW" ? " [⚠️ THỦ CÔNG]" : "";
      msg += `• Đơn <code>${o.id}</code>: ${o.sourceAmount} ${o.sourceCurrency} ➔ ${o.targetAmount} ${o.targetCurrency}${tag}\n`;
    }
  }

  if (waitingPayout.length > 0) {
    msg += `\n<b>2. Đã nhận tiền, chờ chi trả (${waitingPayout.length}):</b>\n`;
    for (const o of waitingPayout) {
      msg += `• Đơn <code>${o.id}</code>: Cần chi <b>${o.targetAmount} ${o.targetCurrency}</b>\n`;
    }
  }

  if (payoutSent.length > 0) {
    msg += `\n<b>3. Đã chi trả, chờ xác nhận bước 2 (${payoutSent.length}):</b>\n`;
    for (const o of payoutSent) {
      msg += `• Đơn <code>${o.id}</code>: Chờ duyệt hoàn tất\n`;
    }
  }

  const keyboard = new InlineKeyboard();
  if (pendingOrders.length > 0) {
    keyboard.text("💰 Duyệt nạp tiền", "admin:menu:pending_pay");
  }
  if (waitingPayout.length > 0 || payoutSent.length > 0) {
    keyboard.text("💸 Duyệt chi tiền", "admin:menu:pending_payout");
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// /order command - view comprehensive order detail
adminHandler.command("order", async (ctx) => {
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const orderId = ctx.match?.trim();
  if (!orderId) return ctx.reply("Cú pháp: <code>/order &lt;Mã_Đơn&gt;</code>", { parse_mode: "HTML" });

  const order = await OrderService.getOrder(orderId);
  if (!order) return ctx.reply(`❌ Không tìm thấy đơn hàng <code>${orderId}</code>.`, { parse_mode: "HTML" });

  const receivingSnapshot = order.receivingAccountSnapshot as any;
  const payoutSnapshot = order.payoutBankSnapshot as any;

  let msg =
    `📦 <b>CHI TIẾT ĐƠN HÀNG: ${order.id}</b>\n\n` +
    `• Trạng thái: <code>${order.status}</code>\n` +
    `• Khách hàng: <b>${order.customer?.fullName || order.customer?.username || order.customerId}</b> (ID: <code>${order.customerId}</code>)\n` +
    `• Telegram ID: <code>${order.customer?.telegramId}</code>\n\n` +
    `💵 <b>TIỀN NẠP:</b> <b>${order.sourceAmount} ${order.sourceCurrency}</b>\n` +
    `• Tài khoản nhận: ${receivingSnapshot?.bankName} - <code>${receivingSnapshot?.accountNumber}</code> (${receivingSnapshot?.accountName})\n` +
    `• QR Version: v${receivingSnapshot?.qrVersion || 1}\n\n` +
    `💸 <b>TIỀN CHI:</b> <b>${order.targetAmount} ${order.targetCurrency}</b>\n` +
    `• Tài khoản chi trả: ${payoutSnapshot?.bankName} - <code>${payoutSnapshot?.accountNumber}</code> (${payoutSnapshot?.accountName})\n` +
    `• Tỷ giá: <b>${order.rate}</b> | Phí: <b>${order.fee} ${order.feeCurrency}</b>\n\n` +
    `🕒 Ngày tạo: ${new Date(order.createdAt).toLocaleString("vi-VN")}\n`;

  if (order.stateHistories && order.stateHistories.length > 0) {
    msg += `\n📜 <b>Lịch sử chuyển trạng thái:</b>\n`;
    for (const h of order.stateHistories.slice(-4)) {
      msg += `• [${h.fromStatus} ➔ ${h.toStatus}] bởi ${h.actorRole} lúc ${new Date(h.createdAt).toLocaleTimeString()}\n`;
    }
  }

  const keyboard = new InlineKeyboard();
  if (["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS"].includes(order.status)) {
    keyboard.text("💰 Duyệt tiền nạp", `admin:pay:step1:${order.id}`).row();
  } else if (order.status === "PAYOUT_SENT") {
    keyboard.text("✅ Hoàn tất đơn", `admin:payout:complete:${order.id}`).row();
  }
  keyboard.text("📁 Trạng thái lưu trữ VPS", `admin:storage:status:${order.id}`);

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// Callback for viewing order detail
adminHandler.callbackQuery(/^admin:order:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const orderId = ctx.match?.[1];
  if (!orderId) return;

  const order = await OrderService.getOrder(orderId);
  if (!order) return ctx.reply(`❌ Không tìm thấy đơn hàng <code>${orderId}</code>.`, { parse_mode: "HTML" });

  const receivingSnapshot = order.receivingAccountSnapshot as any;
  const payoutSnapshot = order.payoutBankSnapshot as any;

  let msg =
    `📦 <b>CHI TIẾT ĐƠN HÀNG: ${order.id}</b>\n\n` +
    `• Trạng thái: <code>${order.status}</code>\n` +
    `• Khách hàng: <b>${order.customer?.fullName || order.customerId}</b>\n\n` +
    `💵 Tiền nạp: <b>${order.sourceAmount} ${order.sourceCurrency}</b>\n` +
    `• Vào: ${receivingSnapshot?.bankName} - <code>${receivingSnapshot?.accountNumber}</code>\n\n` +
    `💸 Tiền chi: <b>${order.targetAmount} ${order.targetCurrency}</b>\n` +
    `• Tới: ${payoutSnapshot?.bankName} - <code>${payoutSnapshot?.accountNumber}</code> (${payoutSnapshot?.accountName})\n`;

  const keyboard = new InlineKeyboard();
  if (["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS"].includes(order.status)) {
    keyboard.text("💰 Duyệt tiền nạp", `admin:pay:step1:${order.id}`).row();
  } else if (order.status === "PAYOUT_SENT") {
    keyboard.text("✅ Hoàn tất đơn", `admin:payout:complete:${order.id}`).row();
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// Step 1: Verify payment received (supports admin:pay:step1:* and pay_step1:*)
adminHandler.callbackQuery(/^(?:admin:pay:step1:|pay_step1:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "payment.verify");
  if (!allowed) return;

  const orderId = ctx.match?.[1];
  if (!orderId) return;
  const order = await OrderService.getOrder(orderId);
  if (!order) return ctx.reply("Không tìm thấy đơn hàng.");

  const receivingSnapshot = order.receivingAccountSnapshot as any;
  const keyboard = new InlineKeyboard()
    .text("⚠️ XÁC NHẬN ĐÃ KIỂM TRA APP NGÂN HÀNG", `admin:pay:step2:${orderId}`)
    .row()
    .text("❌ Hủy bỏ", "admin:menu:pending_pay");

  let detailMsg =
    `⚠️ <b>CẢNH BÁO XÁC NHẬN TIỀN VÀO (BƯỚC 1/2)</b>\n\n` +
    `• Mã đơn: <code>${order.id}</code>\n` +
    `• Trạng thái hiện tại: <code>${order.status}</code>\n` +
    `• Số tiền cần thực nhận: <b>${order.sourceAmount} ${order.sourceCurrency}</b>\n` +
    `• Tài khoản đích: <b>${receivingSnapshot?.bankName}</b> - <code>${receivingSnapshot?.accountNumber}</code> (${receivingSnapshot?.accountName})\n` +
    `• Khách hàng: <b>${order.customer?.fullName || order.customerId}</b>\n`;

  if (order.customerBillSha256) {
    detailMsg += `• SHA-256 biên lai: <code>${order.customerBillSha256}</code>\n`;
  }
  if (order.aiExtractedData && Object.keys(order.aiExtractedData).length > 0) {
    detailMsg += `• AI trích xuất: <code>${JSON.stringify(order.aiExtractedData)}</code>\n`;
  }

  detailMsg += `\n<i>Nguyên tắc tài chính an toàn:</i> Bạn đã mở ứng dụng ngân hàng và chắc chắn tiền thực tế đã vào tài khoản?`;

  // Send photo of customer bill if available
  if (order.customerBillFileId) {
    const evidence = await prisma.fileEvidence.findUnique({ where: { id: order.customerBillFileId } });
    if (evidence?.filePath) {
      const buffer = await FileService.getFile(evidence.filePath);
      if (buffer) {
        await ctx.replyWithPhoto(new InputFile(buffer), {
          caption: `📸 Biên lai nạp tiền cho đơn ${order.id}`
        });
      }
    }
  }

  await ctx.reply(detailMsg, { parse_mode: "HTML", reply_markup: keyboard });
});

// Step 2: Final verify (supports admin:pay:step2:* and pay_step2:*)
adminHandler.callbackQuery(/^(?:admin:pay:step2:|pay_step2:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "payment.verify");
  if (!allowed) return;

  const orderId = ctx.match?.[1];
  if (!orderId) return;
  const adminId = String(ctx.from?.id || "");

  try {
    const updated = await OrderService.confirmPaymentReceived(orderId, adminId);

    // Notify customer
    const customer = await prisma.customer.findUnique({ where: { id: updated.customerId } });
    if (customer) {
      await sendToCustomer(
        customer.telegramId,
        `✅ <b>XÁC NHẬN ĐÃ NHẬN TIỀN CHO ĐƠN ${updated.id}</b>\n\n` +
          `Hệ thống đã xác nhận tiền vào tài khoản thành công.\n` +
          `Giao dịch viên đang tiến hành chi trả <b>${updated.targetAmount} ${updated.targetCurrency}</b> tới tài khoản ngân hàng của quý khách.`
      );
    }

    await ctx.reply(
      `✅ <b>ĐÃ XÁC NHẬN NHẬN TIỀN THÀNH CÔNG</b>\n\n` +
        `• Đơn: <code>${updated.id}</code> chuyển sang trạng thái <b>WAITING_PAYOUT</b>.\n` +
        `• Cần chi trả: <b>${updated.targetAmount} ${updated.targetCurrency}</b>.\n` +
        `<i>Vui lòng chuyển tiền cho khách và gửi ảnh bill kèm caption:</i> <code>/payout ${updated.id}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi xác nhận: ${err.message}`);
  }
});

// Step 2 of payout completion: payout_complete:*
adminHandler.callbackQuery(/^(?:admin:payout:complete:|payout_complete:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "payout.approve");
  if (!allowed) return;

  const orderId = ctx.match?.[1];
  if (!orderId) return;
  const adminId = String(ctx.from?.id || "");

  try {
    const completed = await OrderService.completePayout(orderId, adminId);

    // Notify customer
    const customer = await prisma.customer.findUnique({ where: { id: completed.customerId } });
    if (customer) {
      await sendToCustomer(
        customer.telegramId,
        `🎉 <b>GIAO DỊCH HOÀN TẤT THÀNH CÔNG!</b>\n\n` +
          `Đơn hàng <code>${completed.id}</code> đã được hoàn tất chi trả <b>${completed.targetAmount} ${completed.targetCurrency}</b>.\n` +
          `Cảm ơn quý khách đã tin tưởng và sử dụng dịch vụ!`
      );
    }

    await ctx.reply(
      `🎉 <b>ĐƠN HÀNG ${completed.id} ĐÃ ĐƯỢC HOÀN TẤT THÀNH CÔNG (COMPLETED)!</b>\n` +
        `• Toàn bộ hồ sơ, hóa đơn và hội thoại đã được đưa vào hàng đợi đồng bộ Google Drive.`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
});

// Staff management center: /staff
adminHandler.command("staff", async (ctx) => {
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const keyboard = new InlineKeyboard()
    .text("👥 Danh sách nhân viên", "staff_list:1")
    .text("➕ Thêm nhân viên", "staff_invite_menu")
    .row()
    .text("⏳ Chờ phê duyệt", "staff_pending_list")
    .text("📜 Hoạt động nhân sự", "staff_audit_all");

  await ctx.reply(
    `👥 <b>TRUNG TÂM QUẢN LÝ NHÂN SỰ &amp; PHÂN QUYỀN</b>\n\n` +
      `Vui lòng chọn một mục bên dưới để thao tác:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
});

// Staff callbacks (preserves existing rich staff UI)
adminHandler.callbackQuery("staff_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const keyboard = new InlineKeyboard()
    .text("👥 Danh sách nhân viên", "staff_list:1")
    .text("➕ Thêm nhân viên", "staff_invite_menu")
    .row()
    .text("⏳ Chờ phê duyệt", "staff_pending_list")
    .text("📜 Hoạt động nhân sự", "staff_audit_all");

  await ctx.editMessageText(
    `👥 <b>TRUNG TÂM QUẢN LÝ NHÂN SỰ &amp; PHÂN QUYỀN</b>\n\n` +
      `Vui lòng chọn một mục bên dưới để thao tác:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
});

adminHandler.callbackQuery(/^staff_list:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const pageStr = String(ctx.match?.[1] || "1");
  const page = parseInt(pageStr, 10) || 1;
  const { items, total, totalPages } = await PermissionService.getAllStaff(page, 5);

  if (items.length === 0) {
    const keyboard = new InlineKeyboard().text("➕ Tạo mã mời nhân viên", "staff_invite_menu");
    return ctx.editMessageText("👥 Hiện chưa có nhân sự nào được cấu hình trong hệ thống.", {
      reply_markup: keyboard
    });
  }

  let msg = `👥 <b>DANH SÁCH NHÂN SỰ (Trang ${page}/${totalPages} - Tổng: ${total})</b>\n\n`;
  const keyboard = new InlineKeyboard();

  items.forEach((s: any, idx: number) => {
    const statusIcon = s.status === "ACTIVE" ? "🟢" : s.status === "PENDING" ? "🟡" : "🔴";
    msg += `${idx + 1}. ${statusIcon} [<b>${s.role}</b>] <b>${s.name}</b> (ID: <code>${s.telegramId}</code>) - ${s.status}\n`;
    keyboard.text(`👤 ${s.name} (${s.role})`, `staff_detail:${s.telegramId}`).row();
  });

  if (page > 1) {
    keyboard.text("◀ Trước", `staff_list:${page - 1}`);
  }
  keyboard.text(`Trang ${page}/${totalPages}`, `staff_list:${page}`);
  if (page < totalPages) {
    keyboard.text("Sau ▶", `staff_list:${page + 1}`);
  }
  keyboard.row().text("🔙 Quay lại Menu", "staff_menu");

  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery(/^staff_detail:(\d+|super-admin)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const targetTid = String(ctx.match?.[1] || "");
  if (!targetTid) return;
  const staff = await PermissionService.getStaffUser(targetTid);
  if (!staff) return ctx.reply("Không tìm thấy nhân viên.");

  const perms = staff.permissions || [];
  const statusIcon = staff.status === "ACTIVE" ? "🟢 ACTIVE" : staff.status === "PENDING" ? "🟡 PENDING" : "🔴 DISABLED";

  let msg =
    `👤 <b>HỒ SƠ NHÂN SỰ: ${staff.name}</b>\n\n` +
    `• Telegram User ID: <code>${staff.telegramId}</code>\n` +
    `• Vai trò: <b>${staff.role}</b>\n` +
    `• Trạng thái: <b>${statusIcon}</b>\n` +
    `• Số lượng quyền: <b>${perms.length}</b>/${ALL_PERMISSIONS.length}\n` +
    `• Ngày tạo: ${new Date(staff.createdAt || Date.now()).toLocaleDateString()}\n`;

  const keyboard = new InlineKeyboard()
    .text("🔑 Xem quyền", `staff_perms:${staff.telegramId}`)
    .text("⚙️ Sửa quyền", `staff_editperms:${staff.telegramId}`)
    .row()
    .text("📜 Xem hoạt động", `staff_audit:${staff.telegramId}`)
    .text(staff.status === "ACTIVE" ? "🚫 Khóa tài khoản" : "🟢 Mở khóa", `staff_togglestatus:${staff.telegramId}`)
    .row()
    .text("🔄 Reset Ticket Ownership", `staff_resetconv:${staff.telegramId}`)
    .row()
    .text("🔙 Danh sách nhân viên", "staff_list:1");

  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery(/^staff_perms:(\d+|super-admin)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const targetTid = String(ctx.match?.[1] || "");
  if (!targetTid) return;
  const staff = await PermissionService.getStaffUser(targetTid);
  if (!staff) return ctx.reply("Không tìm thấy nhân viên.");

  let msg = `🔑 <b>DANH SÁCH QUYỀN HẠN CỦA ${staff.name.toUpperCase()} (${staff.role})</b>\n\n`;
  for (const p of ALL_PERMISSIONS) {
    const has = await PermissionService.hasPermission(staff.telegramId, p);
    msg += `${has ? "✅" : "❌"} <code>${p}</code>\n`;
  }

  const keyboard = new InlineKeyboard()
    .text("⚙️ Sửa quyền", `staff_editperms:${staff.telegramId}`)
    .text("🔙 Quay lại hồ sơ", `staff_detail:${staff.telegramId}`);

  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery(/^staff_editperms:(\d+|super-admin)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "permission.manage");
  if (!allowed) return;

  const targetTid = String(ctx.match?.[1] || "");
  if (!targetTid) return;
  const staff = await PermissionService.getStaffUser(targetTid);
  if (!staff) return ctx.reply("Không tìm thấy nhân viên.");

  if (PermissionService.isSuperAdmin(targetTid)) {
    return ctx.reply("⛔ Không thể thay đổi phân quyền của Super Admin.");
  }

  let msg =
    `⚙️ <b>SỬA PHÂN QUYỀN CHO: ${staff.name} (${staff.role})</b>\n` +
    `Bấm vào từng quyền bên dưới để Bật (✅) hoặc Tắt (❌):\n\n`;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < ALL_PERMISSIONS.length; i += 2) {
    const p1 = ALL_PERMISSIONS[i];
    if (!p1) continue;
    const has1 = await PermissionService.hasPermission(staff.telegramId, p1);
    keyboard.text(`${has1 ? "✅" : "❌"} ${p1}`, `perm_toggle:${staff.telegramId}:${p1}`);

    const p2 = ALL_PERMISSIONS[i + 1];
    if (p2) {
      const has2 = await PermissionService.hasPermission(staff.telegramId, p2);
      keyboard.text(`${has2 ? "✅" : "❌"} ${p2}`, `perm_toggle:${staff.telegramId}:${p2}`);
    }
    keyboard.row();
  }
  keyboard.text("✅ Hoàn tất & Quay lại", `staff_detail:${staff.telegramId}`);

  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery(/^perm_toggle:(\d+):([a-z0-9_.]+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "permission.manage");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  const targetTid = String(ctx.match?.[1] || "");
  const permToToggle = String(ctx.match?.[2] || "") as Permission;
  if (!targetTid || !permToToggle) return;

  try {
    await PermissionService.togglePermission(adminId, targetTid, permToToggle);

    const staff = await PermissionService.getStaffUser(targetTid);
    if (!staff) return;

    const keyboard = new InlineKeyboard();
    for (let i = 0; i < ALL_PERMISSIONS.length; i += 2) {
      const p1 = ALL_PERMISSIONS[i];
      if (!p1) continue;
      const has1 = await PermissionService.hasPermission(staff.telegramId, p1);
      keyboard.text(`${has1 ? "✅" : "❌"} ${p1}`, `perm_toggle:${staff.telegramId}:${p1}`);

      const p2 = ALL_PERMISSIONS[i + 1];
      if (p2) {
        const has2 = await PermissionService.hasPermission(staff.telegramId, p2);
        keyboard.text(`${has2 ? "✅" : "❌"} ${p2}`, `perm_toggle:${staff.telegramId}:${p2}`);
      }
      keyboard.row();
    }
    keyboard.text("✅ Hoàn tất & Quay lại", `staff_detail:${staff.telegramId}`);

    await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi phân quyền: ${err.message}`);
  }
});

adminHandler.callbackQuery(/^staff_togglestatus:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  try {
    const targetTid = String(ctx.match?.[1] || "");
    if (!targetTid) return;
    const updated = await PermissionService.toggleStaffStatus(adminId, targetTid);
    await ctx.reply(`✅ Đã chuyển trạng thái nhân sự <b>${updated.name}</b> sang: <b>${updated.status}</b>`, {
      parse_mode: "HTML"
    });
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
});

adminHandler.callbackQuery(/^staff_resetconv:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  try {
    const targetTid = String(ctx.match?.[1] || "");
    if (!targetTid) return;
    const { resetCount } = await PermissionService.resetStaffConversations(adminId, targetTid);
    await ctx.reply(`✅ Đã thu hồi và chuyển ${resetCount} cuộc trò chuyện của nhân viên này về chế độ AUTO AI.`);
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
});

adminHandler.callbackQuery(/^staff_audit:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "audit.view");
  if (!allowed) return;

  const targetTid = String(ctx.match?.[1] || "");
  if (!targetTid) return;
  const logs = await AuditService.getLogs(targetTid, 8);

  let msg = `📜 <b>NHẬT KÝ HOẠT ĐỘNG CỦA NHÂN VIÊN (ID: ${targetTid}):</b>\n\n`;
  if (logs.length === 0) {
    msg += `Chưa có nhật ký hoạt động nào được ghi nhận.`;
  } else {
    for (const l of logs) {
      msg += `• [${l.action}] lúc ${new Date(l.createdAt).toLocaleTimeString()} - ${JSON.stringify(l.details || {})}\n`;
    }
  }

  const keyboard = new InlineKeyboard().text("🔙 Quay lại hồ sơ", `staff_detail:${targetTid}`);
  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery("staff_audit_all", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "audit.view");
  if (!allowed) return;

  const logs = await AuditService.getLogs(undefined, 10);
  let msg = `📜 <b>NHẬT KÝ BẢO MẬT &amp; NHÂN SỰ GẦN NHẤT:</b>\n\n`;
  for (const l of logs) {
    msg += `• [${l.action}] bởi <code>${l.actorId}</code> (${l.actorRole}) lúc ${new Date(l.createdAt).toLocaleTimeString()}\n`;
  }

  const keyboard = new InlineKeyboard().text("🔙 Quay lại Menu", "staff_menu");
  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery("staff_invite_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const keyboard = new InlineKeyboard()
    .text("➕ Tạo mã mời CSKH (24h)", "staff_create_invite:CSKH")
    .row()
    .text("➕ Tạo mã mời ADMIN (24h)", "staff_create_invite:ADMIN")
    .row()
    .text("🔙 Quay lại", "staff_menu");

  await ctx.editMessageText(
    `➕ <b>TẠO MÃ MỜI NHÂN VIÊN MỚI</b>\n\n` +
      `Mã mời chỉ sử dụng được 1 lần và có hiệu lực trong 24 giờ.\n` +
      `Chọn vai trò để phát hành mã mời:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
});

adminHandler.callbackQuery(/^staff_create_invite:(ADMIN|CSKH)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  const role = String(ctx.match?.[1] || "CSKH") as "ADMIN" | "CSKH";

  try {
    const invite = await PermissionService.createInvite(adminId, role, 24);
    const keyboard = new InlineKeyboard().text("🔙 Quay lại danh sách", "staff_menu");

    await ctx.editMessageText(
      `🎟 <b>ĐÃ TẠO MÃ MỜI NHÂN SỰ (${role})</b>\n\n` +
        `• Mã mời: <code>${invite.code}</code>\n` +
        `• Vai trò: <b>${invite.role}</b>\n` +
        `• Hạn dùng: 24 giờ (hết hạn lúc ${new Date(invite.expiresAt).toLocaleTimeString()})\n` +
        `• Quy tắc bảo mật: Dùng 1 lần duy nhất, yêu cầu Admin duyệt sau khi nhập.\n\n` +
        `<i>Hướng dẫn nhân sự mới:</i> Vào bot và gõ lệnh sau:\n` +
        `<code>/start ${invite.code}</code>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
});

adminHandler.callbackQuery("staff_pending_list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const pending = await PermissionService.getPendingApprovals();
  if (pending.length === 0) {
    const keyboard = new InlineKeyboard().text("🔙 Quay lại", "staff_menu");
    return ctx.editMessageText("✅ Hiện không có yêu cầu nhân sự nào đang chờ phê duyệt.", {
      reply_markup: keyboard
    });
  }

  let msg = `⏳ <b>DANH SÁCH NHÂN SỰ CHỜ PHÊ DUYỆT (${pending.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();

  for (const p of pending) {
    msg += `• 👤 <b>${p.name}</b> (ID: <code>${p.telegramId}</code>) - Vai trò: <b>${p.role}</b>\n`;
    keyboard
      .text(`✅ Duyệt: ${p.name}`, `staff_approve:${p.telegramId}:1`)
      .text(`❌ Từ chối`, `staff_approve:${p.telegramId}:0`)
      .row();
  }
  keyboard.text("🔙 Quay lại Menu", "staff_menu");

  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery(/^staff_approve:(\d+):(1|0)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const adminId = String(ctx.from?.id || "");
  const targetTid = String(ctx.match?.[1] || "");
  const approved = String(ctx.match?.[2] || "0") === "1";
  if (!targetTid) return;

  try {
    const updated = await PermissionService.approveStaff(adminId, targetTid, approved);
    await ctx.reply(
      approved
        ? `✅ <b>ĐÃ PHÊ DUYỆT NHÂN SỰ THÀNH CÔNG</b>\nNhân viên <b>${updated.name}</b> (${updated.role}) hiện đã ACTIVE!`
        : `❌ <b>ĐÃ TỪ CHỐI NHÂN SỰ</b>\nYêu cầu của <b>${updated.name}</b> đã bị từ chối.`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Lỗi: ${err.message}`);
  }
});

// /invite command
adminHandler.command("invite", async (ctx) => {
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const text = ctx.match?.trim();
  if (!text) return ctx.reply("Cú pháp: <code>/invite &lt;telegramId&gt; &lt;tên&gt; &lt;ADMIN|CSKH&gt;</code>", { parse_mode: "HTML" });

  const parts = text.split(/\s+/);
  if (parts.length < 3) return ctx.reply("Cần đủ 3 tham số: telegramId, tên, vai trò");

  const [telegramId, name, role] = parts as [string, string, "ADMIN" | "CSKH"];
  if (role !== "ADMIN" && role !== "CSKH") {
    return ctx.reply("Vai trò phải là ADMIN hoặc CSKH");
  }

  await PermissionService.inviteStaff({ telegramId, name, role });
  await ctx.reply(`✅ Đã kích hoạt nhân sự <b>${name}</b> với vai trò <b>${role}</b>.`, { parse_mode: "HTML" });
});

// /storage & /drive commands
adminHandler.command(["storage", "drive"], async (ctx) => {
  const adminId = String(ctx.from?.id || "");
  const hasPerm =
    (await PermissionService.hasPermission(adminId, "order.view")) ||
    (await PermissionService.hasPermission(adminId, "audit.view"));
  if (!hasPerm) return ctx.reply("⛔ Bạn không có quyền xem dữ liệu lưu trữ VPS.");

  const orderId = ctx.match?.trim();
  if (!orderId) return ctx.reply("Cú pháp: <code>/storage &lt;Mã_Đơn_Hàng&gt;</code>", { parse_mode: "HTML" });

  const status = await LocalStorageService.getOrderArchiveStatus(orderId);
  if (!status) return ctx.reply(`❌ Không tìm thấy đơn hàng <code>${orderId}</code>.`, { parse_mode: "HTML" });

  const icon = (s: string) => (s === "SUCCESS" ? "✅" : s === "FAILED" ? "⚠️" : s === "N/A" ? "➖" : "⚪");

  const msg =
    `📁 <b>KHO LƯU TRỮ CHỨNG TỪ VPS (Đơn ${orderId}):</b>\n\n` +
    `• Thư mục lưu trữ: <code>${status.storageFolder || "Chưa tạo"}</code>\n` +
    `• Tồn tại trên đĩa: ${status.existsOnDisk ? "✅ Có" : "❌ Chưa"}\n` +
    `• Tổng số tập tin: <b>${status.filesCount}</b>\n` +
    `• Thông tin đơn hàng (order.json): ${icon(status.metadataStatus)} <b>${status.metadataStatus}</b>\n` +
    `• Thông tin khách hàng (customer.json): ${icon(status.customerStatus)} <b>${status.customerStatus}</b>\n` +
    `• Mã QR thanh toán: ${icon(status.qrStatus)} <b>${status.qrStatus}</b>\n` +
    `• Biên lai khách chuyển: ${icon(status.customerBillStatus)} <b>${status.customerBillStatus}</b>\n` +
    `• Biên lai chi tiền: ${icon(status.payoutBillStatus)} <b>${status.payoutBillStatus}</b>\n` +
    `• Hội thoại (txt &amp; json): ${icon(status.conversationStatus)} <b>${status.conversationStatus}</b>\n` +
    `• Nhật ký kiểm toán (audit.json): ${icon(status.auditStatus)} <b>${status.auditStatus}</b>`;

  const keyboard = new InlineKeyboard().text("🔄 Lưu trữ lại (Archive Now)", `admin:storage:archive:${orderId}`);
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// Storage status callback (supports admin:storage:status:* and admin:drive:status:*)
adminHandler.callbackQuery(/^(?:admin:storage:status:|admin:drive:status:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const adminId = String(ctx.from?.id || "");
  const hasPerm =
    (await PermissionService.hasPermission(adminId, "order.view")) ||
    (await PermissionService.hasPermission(adminId, "audit.view"));
  if (!hasPerm) return ctx.reply("⛔ Bạn không có quyền xem dữ liệu lưu trữ VPS.");

  const orderId = String(ctx.match?.[1] || "");
  if (!orderId) return;

  const status = await LocalStorageService.getOrderArchiveStatus(orderId);
  if (!status) return ctx.reply(`❌ Không tìm thấy đơn hàng <code>${orderId}</code>.`, { parse_mode: "HTML" });

  const icon = (s: string) => (s === "SUCCESS" ? "✅" : s === "FAILED" ? "⚠️" : s === "N/A" ? "➖" : "⚪");

  const msg =
    `📁 <b>KHO LƯU TRỮ CHỨNG TỪ VPS (Đơn ${orderId}):</b>\n\n` +
    `• Thư mục lưu trữ: <code>${status.storageFolder || "Chưa tạo"}</code>\n` +
    `• Tồn tại trên đĩa: ${status.existsOnDisk ? "✅ Có" : "❌ Chưa"}\n` +
    `• Tổng số tập tin: <b>${status.filesCount}</b>\n` +
    `• Thông tin đơn hàng (order.json): ${icon(status.metadataStatus)} <b>${status.metadataStatus}</b>\n` +
    `• Thông tin khách hàng (customer.json): ${icon(status.customerStatus)} <b>${status.customerStatus}</b>\n` +
    `• Mã QR thanh toán: ${icon(status.qrStatus)} <b>${status.qrStatus}</b>\n` +
    `• Biên lai khách chuyển: ${icon(status.customerBillStatus)} <b>${status.customerBillStatus}</b>\n` +
    `• Biên lai chi tiền: ${icon(status.payoutBillStatus)} <b>${status.payoutBillStatus}</b>\n` +
    `• Hội thoại (txt &amp; json): ${icon(status.conversationStatus)} <b>${status.conversationStatus}</b>\n` +
    `• Nhật ký kiểm toán (audit.json): ${icon(status.auditStatus)} <b>${status.auditStatus}</b>`;

  const keyboard = new InlineKeyboard().text("🔄 Lưu trữ lại (Archive Now)", `admin:storage:archive:${orderId}`);
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

// Storage archive callback (supports admin:storage:archive:*, admin:drive:retry:*, drive_retry:*)
adminHandler.callbackQuery(/^(?:admin:storage:archive:|admin:drive:retry:|drive_retry:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const adminId = String(ctx.from?.id || "");
  const hasPerm =
    (await PermissionService.hasPermission(adminId, "order.view")) ||
    (await PermissionService.hasPermission(adminId, "audit.view"));
  if (!hasPerm) return ctx.reply("⛔ Bạn không có quyền kích hoạt lưu trữ chứng từ.");

  const orderId = String(ctx.match?.[1] || "");
  if (!orderId) return;

  await ctx.reply(`🔄 Đang lưu trữ toàn bộ dữ liệu đơn hàng <code>${orderId}</code> vào VPS...`, { parse_mode: "HTML" });
  await LocalStorageService.archiveFullOrder(orderId);
  await ctx.reply(`✅ Đã hoàn tất lưu trữ chứng từ và nhật ký đơn hàng trên VPS.`);
});

// /audit command
adminHandler.command("audit", async (ctx) => {
  const allowed = await requirePermission(ctx, "audit.view");
  if (!allowed) return;

  const logs = await AuditService.getLogs(undefined, 10);
  let msg = `🛡 <b>NHẬT KÝ KIỂM TOÁN GẦN NHẤT:</b>\n\n`;
  for (const l of logs) {
    msg += `• [${l.action}] bởi <code>${l.actorId}</code> (${l.actorRole}) lúc ${new Date(l.createdAt).toLocaleTimeString()}\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

// Menu button callbacks
adminHandler.callbackQuery("admin:menu:orders", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const orders = await OrderService.getAllOrders(10);
  let msg = `📦 <b>DANH SÁCH 10 ĐƠN HÀNG GẦN ĐÂY:</b>\n\n`;
  for (const o of orders) {
    msg += `• <code>${o.id}</code>: ${o.sourceAmount} ${o.sourceCurrency} ➔ ${o.targetAmount} ${o.targetCurrency} [<b>${o.status}</b>]\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

adminHandler.callbackQuery("admin:menu:pending_pay", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const pendingOrders = await prisma.order.findMany({
    where: { status: { in: ["WAITING_ADMIN_VERIFY", "CUSTOMER_SENT_BILL", "MANUAL_REVIEW", "SUSPICIOUS"] } },
    include: { customer: true },
    orderBy: { createdAt: "asc" }
  });
  if (pendingOrders.length === 0) {
    return ctx.reply("✅ Không có đơn hàng nào đang chờ xác nhận tiền nạp.");
  }

  let msg = `💰 <b>ĐƠN HÀNG CHỜ XÁC NHẬN TIỀN NẠP (${pendingOrders.length}):</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const o of pendingOrders) {
    const flag = o.status === "SUSPICIOUS" ? " [🚨 CẢNH BÁO]" : o.status === "MANUAL_REVIEW" ? " [⚠️ THỦ CÔNG]" : "";
    msg += `• Đơn <code>${o.id}</code>: Cần nhận <b>${o.sourceAmount} ${o.sourceCurrency}</b>${flag}\n`;
    keyboard.text(`🔍 Duyệt nhận: ${o.id}`, `admin:pay:step1:${o.id}`).row();
  }
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery("admin:menu:pending_payout", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "order.view");
  if (!allowed) return;

  const waitingPayout = await OrderService.getOrdersByStatus("WAITING_PAYOUT");
  const payoutSent = await OrderService.getOrdersByStatus("PAYOUT_SENT");

  if (waitingPayout.length === 0 && payoutSent.length === 0) {
    return ctx.reply("✅ Không có đơn hàng nào đang chờ chi tiền.");
  }

  let msg = `💸 <b>DANH SÁCH ĐƠN HÀNG CẦN CHI TIỀN:</b>\n\n`;
  const keyboard = new InlineKeyboard();

  if (waitingPayout.length > 0) {
    msg += `<b>Chờ chuyển tiền &amp; upload bill (${waitingPayout.length}):</b>\n`;
    for (const o of waitingPayout) {
      msg += `• Đơn <code>${o.id}</code>: Cần chuyển <b>${o.targetAmount} ${o.targetCurrency}</b>\n`;
    }
    msg += `\n<i>(Chuyển tiền xong, gửi ảnh bill kèm caption: /payout &lt;orderId&gt;)</i>\n\n`;
  }

  if (payoutSent.length > 0) {
    msg += `<b>Đã upload bill, chờ duyệt hoàn tất (${payoutSent.length}):</b>\n`;
    for (const o of payoutSent) {
      msg += `• Đơn <code>${o.id}</code>: ${o.targetAmount} ${o.targetCurrency}\n`;
      keyboard.text(`✅ Hoàn tất đơn ${o.id}`, `admin:payout:complete:${o.id}`).row();
    }
  }

  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery("admin:menu:rates", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "rate.view");
  if (!allowed) return;

  const rates = await QuoteService.getAllRates();
  let msg = `📈 <b>TỶ GIÁ HỆ THỐNG:</b>\n\n`;
  for (const r of rates) {
    msg += `• <b>${r.pair}</b>: Gốc ${r.baseRate} | Mua -${r.buyMargin} | Bán +${r.sellMargin} | Phí ${r.fee} ${r.feeCurrency}\n`;
  }
  msg += `\n<i>Cập nhật bằng lệnh:</i>\n<code>/setrate CẶP base buyMargin sellMargin fee feeCurrency</code>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

adminHandler.callbackQuery("admin:menu:accounts", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "payment_account.view");
  if (!allowed) return;

  const accounts = await PaymentAccountService.getAllAccounts();
  let msg = `🏦 <b>TÀI KHOẢN NHẬN TIỀN:</b>\n\n`;
  for (const a of accounts) {
    msg += `• [<b>${a.currency}</b>] ${a.bankName} - <code>${a.accountNumber}</code> (${a.accountName})\n`;
  }
  msg += `\n<i>Thêm QR mới: Gửi ảnh kèm: /addqr CURRENCY|BANK|NAME|NUMBER|TAG</i>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
});

adminHandler.callbackQuery("admin:menu:customers", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "customer.view");
  if (!allowed) return;

  const customers = await prisma.customer.findMany({ take: 10, orderBy: { createdAt: "desc" } });
  let msg = `👥 <b>10 KHÁCH HÀNG GẦN NHẤT:</b>\n\n`;
  for (const c of customers) {
    msg += `• [<code>${c.id}</code>] <b>${c.fullName || c.username || c.telegramId}</b> (Telegram: <code>${c.telegramId}</code>)\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

adminHandler.callbackQuery("admin:menu:staff", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "staff.manage");
  if (!allowed) return;

  const keyboard = new InlineKeyboard()
    .text("👥 Danh sách nhân viên", "staff_list:1")
    .text("➕ Thêm nhân viên", "staff_invite_menu")
    .row()
    .text("⏳ Chờ phê duyệt", "staff_pending_list")
    .text("📜 Hoạt động nhân sự", "staff_audit_all");

  await ctx.reply(`👥 <b>QUẢN TRỊ NHÂN SỰ:</b>`, { parse_mode: "HTML", reply_markup: keyboard });
});

adminHandler.callbackQuery("admin:menu:perms", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "permission.manage");
  if (!allowed) return;

  await ctx.reply(
    `🔐 <b>QUẢN TRỊ PHÂN QUYỀN:</b>\n` +
      `Vui lòng vào <b>👨‍💼 Nhân viên</b> ➔ Chọn nhân viên ➔ Chọn <b>⚙️ Sửa quyền</b> để cấp/thu hồi quyền chi tiết theo nguyên tắc bảo mật tối thiểu.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("👥 Mở danh sách nhân sự", "staff_list:1")
    }
  );
});

adminHandler.callbackQuery("admin:menu:audit", async (ctx) => {
  await ctx.answerCallbackQuery();
  const allowed = await requirePermission(ctx, "audit.view");
  if (!allowed) return;

  const logs = await AuditService.getLogs(undefined, 8);
  let msg = `📜 <b>NHẬT KÝ HOẠT ĐỘNG KIỂM TOÁN:</b>\n\n`;
  for (const l of logs) {
    msg += `• [${l.action}] bởi <code>${l.actorId}</code> lúc ${new Date(l.createdAt).toLocaleTimeString()}\n`;
  }
  await ctx.reply(msg, { parse_mode: "HTML" });
});

adminHandler.callbackQuery("admin:menu:system", async (ctx) => {
  await ctx.answerCallbackQuery();
  const storageHealth = await LocalStorageService.checkStorageHealth();
  const health = {
    status: "ok",
    nodeEnv: env.NODE_ENV,
    timezone: env.TIMEZONE,
    storageStatus: storageHealth.writable ? "Hoạt động (Ghi/Đọc OK)" : "Cảnh báo lỗi ghi",
    backupStatus: env.BACKUP_ENABLED ? "Đã bật (Restic)" : "Chưa kích hoạt",
    gemini: env.GEMINI_API_KEY ? "Hoạt động" : "Chưa cấu hình"
  };

  await ctx.reply(
    `⚙️ <b>TRẠNG THÁI HỆ THỐNG:</b>\n\n` +
      `• Môi trường: <b>${health.nodeEnv}</b>\n` +
      `• Múi giờ: <b>${health.timezone}</b>\n` +
      `• Lưu trữ cục bộ VPS: <b>${health.storageStatus}</b>\n` +
      `• Sao lưu mã hóa Restic: <b>${health.backupStatus}</b>\n` +
      `• Trợ lý Gemini AI: <b>${health.gemini}</b>\n` +
      `• Cổng HTTP: <b>${env.PORT}</b>`,
    { parse_mode: "HTML" }
  );
});

adminHandler.callbackQuery("admin:menu:super_admin", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.identity?.userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Chức năng này chỉ dành riêng cho Super Admin.");
  }

  const view = renderSystemSettingsView();
  await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
});

// Dynamic Settings Callback Handlers
adminHandler.callbackQuery("admin:menu:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Chỉ quản trị viên mới có quyền truy cập cài đặt.");
  }

  const view = renderSystemSettingsView();
  await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
});

adminHandler.callbackQuery("admin:settings:refresh", async (ctx) => {
  await ctx.answerCallbackQuery("Đã làm mới thông số!");
  const view = renderSystemSettingsView();
  try {
    await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  } catch {
    await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  }
});

adminHandler.callbackQuery("admin:settings:ask_key", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🔑 <b>HƯỚNG DẪN CÀI/ĐỔI GOOGLE GEMINI API KEY:</b>\n\n` +
      `1. Lấy API key miễn phí tại: https://aistudio.google.com/app/apikey\n` +
      `2. Nhắn trực tiếp cho bot cú pháp:\n` +
      `<code>/setkey AIzaSyDxxxxxxxxxxxxxx</code>\n\n` +
      `⚡ <i>Hệ thống sẽ ping thử API với Google. Khi thành công, bot sẽ lưu vào ổ cứng VPS và kích hoạt ngay tức thì.</i>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
});

adminHandler.callbackQuery("admin:settings:model_select", async (ctx) => {
  await ctx.answerCallbackQuery();
  const keyboard = new InlineKeyboard()
    .text("⚡ gemini-3.6-flash (Khuyên dùng)", "admin:set_model:gemini-3.6-flash")
    .row()
    .text("🪶 gemini-3.5-flash-lite (Siêu nhanh)", "admin:set_model:gemini-3.5-flash-lite")
    .row()
    .text("🧠 gemini-3.8-flash (Model mới)", "admin:set_model:gemini-3.8-flash")
    .row()
    .text("🔙 Quay lại Cài đặt", "admin:menu:settings");

  await ctx.reply("🤖 <b>CHỌN MODEL GOOGLE GEMINI AI:</b>\n\nChọn model bạn muốn sử dụng:", {
    parse_mode: "HTML",
    reply_markup: keyboard
  });
});

adminHandler.callbackQuery(/^admin:set_model:(.+)$/, async (ctx) => {
  const model = ctx.match[1];
  await ctx.answerCallbackQuery(`Đã chọn ${model}`);
  SystemConfigService.updateConfig({ geminiTextModel: model }, ctx.identity?.telegramId || "ADMIN");

  await ctx.reply(`✅ <b>ĐÃ ĐỔI MODEL GEMINI SANG:</b> <code>${model}</code>`, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("⚙️ Mở lại Cài đặt", "admin:menu:settings")
  });
});

adminHandler.callbackQuery("admin:settings:sethere", async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = String(ctx.chat!.id);
  SystemConfigService.updateConfig({ adminNotificationChatId: chatId }, ctx.identity?.telegramId || "ADMIN");

  await ctx.reply(
    `✅ <b>ĐÃ THIẾT LẬP KÊNH THÔNG BÁO!</b>\n\n` +
      `• Chat ID: <code>${chatId}</code>\n` +
      `Tất cả thông báo đơn mới và thanh toán của khách sẽ được gửi tới đây.`,
    { parse_mode: "HTML" }
  );
});

adminHandler.callbackQuery("admin:settings:test_ai", async (ctx) => {
  await ctx.answerCallbackQuery("Đang kiểm tra AI...");
  const waitMsg = await ctx.reply("⏳ Đang gửi yêu cầu kiểm tra tới Google Gemini API...");
  const result = await AiProvider.testGeminiConnection();

  if (result.ok) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `✅ <b>GOOGLE GEMINI AI HOẠT ĐỘNG TỐT!</b>\n\n` +
        `• <b>Model:</b> <code>${result.model}</code>\n` +
        `• <b>Độ trễ:</b> <code>${result.latencyMs} ms</code>\n` +
        `• <b>Phản hồi:</b>\n<i>"${result.reply}"</i>`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `❌ <b>KẾT NỐI GEMINI AI THẤT BẠI:</b>\n\n<code>${result.error}</code>\n\nDùng lệnh <code>/setkey &lt;key&gt;</code> để cài lại API Key.`,
      { parse_mode: "HTML" }
    );
  }
});

// Backup Menu & Callbacks
adminHandler.callbackQuery("admin:menu:backup", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userType = ctx.identity?.userType;
  if (userType !== "ADMIN" && userType !== "SUPER_ADMIN") {
    return ctx.reply("⛔ Bạn không có quyền truy cập chức năng sao lưu.");
  }

  const history = BackupService.getHistory();
  const last = history[0];
  const lastStr = last
    ? `• Lần sao lưu gần nhất: <b>${new Date(last.timestamp).toLocaleString("vi-VN")}</b> (${last.sizeFormatted} - ${last.status})\n• Vị trí: <code>${last.targetPath}</code>\n`
    : "• Chưa có bản sao lưu nào.\n";

  const cfg = SystemConfigService.getConfig();
  const keyboard = new InlineKeyboard()
    .text("💾 Sao lưu ngay bây giờ", "admin:backup:run_now")
    .row()
    .text("📜 Xem danh sách bản sao lưu", "admin:backup:history")
    .text("🔄 Bật/Tắt tự động", "admin:backup:toggle")
    .row()
    .text("🔙 Về Menu chính", "admin:menu:back_start");

  await ctx.reply(
    `💾 <b>HỆ THỐNG SAO LƯU DỮ LIỆU (VPS BACKUP ENGINE):</b>\n\n` +
      `${lastStr}` +
      `• Tự động sao lưu định kỳ: <b>${cfg.backupEnabled ? "BẬT" : "TẮT"}</b>\n` +
      `• Chu kỳ tự động: <b>Mỗi ${cfg.backupScheduleHours} giờ</b>\n\n` +
      `📌 <i>Dữ liệu sao lưu bao gồm: Toàn bộ cơ sở dữ liệu PostgreSQL + kho chứng từ hóa đơn và mã QR giao dịch.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
});

adminHandler.callbackQuery("admin:backup:run_now", async (ctx) => {
  await ctx.answerCallbackQuery("Đang sao lưu...");
  const waitMsg = await ctx.reply("⏳ <b>ĐANG TIẾN HÀNH SAO LƯU HỆ THỐNG...</b>\n<i>Vui lòng đợi vài giây...</i>", { parse_mode: "HTML" });
  const result = await BackupService.runBackup(ctx.identity?.telegramId || "ADMIN");

  if (result.success) {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `✅ <b>SAO LƯU THÀNH CÔNG!</b>\n\n` +
        `• Mã snapshot: <code>${result.record?.id}</code>\n` +
        `• Dung lượng: <b>${result.record?.sizeFormatted}</b>\n` +
        `• Chi tiết: <i>${result.record?.details}</i>\n` +
        `• Thời gian: <code>${new Date().toLocaleString("vi-VN")}</code>`,
      { parse_mode: "HTML" }
    );
  } else {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      waitMsg.message_id,
      `❌ <b>SAO LƯU THẤT BẠI:</b>\n\n<code>${result.message}</code>`,
      { parse_mode: "HTML" }
    );
  }
});

adminHandler.callbackQuery("admin:backup:history", async (ctx) => {
  await ctx.answerCallbackQuery();
  const history = BackupService.getHistory();
  if (history.length === 0) {
    return ctx.reply("Chưa có bản sao lưu nào. Bấm '💾 Sao lưu ngay bây giờ' để tạo bản sao lưu đầu tiên.");
  }

  let msg = `📜 <b>LỊCH SỬ CÁC BẢN SAO LƯU GẦN NHẤT:</b>\n\n`;
  for (const b of history.slice(0, 8)) {
    const t = new Date(b.timestamp).toLocaleString("vi-VN");
    msg += `• <b>${b.id}</b> (${b.type})\n  📅 ${t} | 📦 ${b.sizeFormatted} | ${b.status === "SUCCESS" ? "✅ Thành công" : "❌ Thất bại"}\n`;
  }

  await ctx.reply(msg, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("💾 Sao lưu ngay", "admin:backup:run_now")
      .text("🔙 Menu sao lưu", "admin:menu:backup")
  });
});

adminHandler.callbackQuery("admin:backup:toggle", async (ctx) => {
  const current = SystemConfigService.isBackupEnabled();
  const next = !current;
  SystemConfigService.updateConfig({ backupEnabled: next }, ctx.identity?.telegramId || "ADMIN");
  await ctx.answerCallbackQuery(`Đã ${next ? "BẬT" : "TẮT"} tự động sao lưu`);
  await ctx.reply(`✅ Đã đổi trạng thái tự động sao lưu sang: <b>${next ? "BẬT" : "TẮT"}</b>`, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("🔙 Menu sao lưu", "admin:menu:backup")
  });
});

adminHandler.callbackQuery("admin:menu:back_start", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAdminStart(ctx);
});

// Admin Photo Handler: /addqr or /payout caption
export async function handleAdminPhoto(ctx: BotContext) {
  const adminId = String(ctx.from?.id || "");
  const caption = ctx.message?.caption?.trim() || "";
  const photo = ctx.message?.photo?.pop();
  if (!photo) return;

  const file = await ctx.api.getFile(photo.file_id);
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());

  if (caption.startsWith("/addqr")) {
    const allowed = await requirePermission(ctx, "payment_account.edit");
    if (!allowed) return;

    const dataStr = caption.replace("/addqr", "").trim();
    const parts = dataStr.split("|").map((p) => p.trim());
    if (parts.length < 4) {
      return ctx.reply("Cú pháp: <code>/addqr CURRENCY|BANK_NAME|ACCOUNT_NAME|ACCOUNT_NUMBER|TAG</code>", {
        parse_mode: "HTML"
      });
    }

    const [currency, bankName, accountName, accountNumber, tag] = parts as [string, string, string, string, string?];
    const account = await PaymentAccountService.addAccount(
      {
        currency,
        bankName,
        accountName,
        accountNumber,
        tag: tag || "default",
        qrFileBuffer: buffer,
        qrFileName: `qr_${currency}_${accountNumber}.png`,
        qrMimeType: "image/png"
      },
      adminId
    );

    await ctx.reply(
      `✅ <b>ĐÃ LƯU MÃ QR CHO TÀI KHOẢN [${account.currency}]:</b>\n\n` +
        `• Ngân hàng: <b>${account.bankName}</b>\n` +
        `• Số tài khoản: <code>${account.accountNumber}</code>\n` +
        `• Tên tài khoản: <b>${account.accountName}</b>\n` +
        `• Phiên bản QR: <b>v${account.qrVersion}</b>\n` +
        `• SHA-256: <code>${account.qrSha256}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (caption.startsWith("/payout")) {
    const allowed = await requirePermission(ctx, "payout.approve");
    if (!allowed) return;

    const orderId = caption.replace("/payout", "").trim();
    if (!orderId) return ctx.reply("Vui lòng nhập mã đơn sau /payout, ví dụ: <code>/payout ORD-XXX</code>", { parse_mode: "HTML" });

    try {
      const order = await OrderService.submitPayoutBill(
        orderId,
        adminId,
        buffer,
        `payout_${orderId}.jpg`,
        "image/jpeg"
      );

      const keyboard = new InlineKeyboard().text("✅ Hoàn tất đơn (BƯỚC 2/2)", `admin:payout:complete:${order.id}`);

      await ctx.reply(
        `📤 <b>ĐÃ TẢI LÊN BIÊN LAI CHI TRẢ CHO ĐƠN ${order.id}</b>\n\n` +
          `• Trạng thái hiện tại: <b>PAYOUT_SENT</b>\n` +
          `• Vui lòng kiểm tra lại lần cuối và bấm nút bên dưới để hoàn tất đơn hàng:`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Lỗi tải biên lai chi tiền: ${err.message}`);
    }
    return;
  }

  await ctx.reply("Gửi ảnh kèm caption <code>/addqr ...</code> hoặc <code>/payout &lt;orderId&gt;</code>", {
    parse_mode: "HTML"
  });
}
