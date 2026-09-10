import { InlineKeyboard } from "grammy";

export function getAdminMenuKeyboard(isSuperAdmin: boolean = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📦 Đơn hàng", "admin:menu:orders")
    .text("💰 Chờ xác nhận tiền", "admin:menu:pending_pay")
    .row()
    .text("💸 Chờ payout", "admin:menu:pending_payout")
    .text("💱 Tỷ giá", "admin:menu:rates")
    .row()
    .text("🏦 QR / Tài khoản", "admin:menu:accounts")
    .text("👥 Khách hàng", "admin:menu:customers")
    .row()
    .text("👨‍💼 Nhân viên", "admin:menu:staff")
    .text("🔐 Phân quyền", "admin:menu:perms")
    .row()
    .text("📜 Audit", "admin:menu:audit")
    .text("💾 Sao lưu", "admin:menu:backup")
    .row()
    .text("❓ Hướng dẫn", "admin:menu:help");

  if (isSuperAdmin) {
    keyboard.row().text("🤖 AI / Gemini", "admin:menu:ai");
    keyboard.row().text("⚙️ Cài đặt hệ thống (Settings)", "admin:menu:settings");
    keyboard.row().text("🛡 Super Admin Controls", "admin:menu:super_admin");
  } else {
    keyboard.row().text("🩺 System Status", "admin:menu:system");
  }

  return keyboard;
}

export function renderAdminStartText(staffName: string, isSuperAdmin: boolean = false): string {
  const title = isSuperAdmin ? "🛡 HỆ THỐNG QUẢN TRỊ SUPER ADMIN" : "🛡 HỆ THỐNG QUẢN TRỊ ADMIN";
  return (
    `<b>${title}</b>\n\n` +
    `Xin chào <b>${staffName || "Quản trị viên"}</b>.\n` +
    `Chọn một chức năng bên dưới.\n` +
    `Cần lệnh chi tiết? Bấm <b>❓ Hướng dẫn</b>.`
  );
}
