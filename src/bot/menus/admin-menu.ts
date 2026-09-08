import { InlineKeyboard } from "grammy";

export function getAdminMenuKeyboard(isSuperAdmin: boolean = false): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("📦 Đơn hàng", "admin:menu:orders")
    .text("💰 Chờ xác nhận tiền", "admin:menu:pending_pay")
    .row()
    .text("💸 Chờ payout", "admin:menu:pending_payout")
    .text("📈 Tỷ giá", "admin:menu:rates")
    .row()
    .text("🏦 QR / Tài khoản", "admin:menu:accounts")
    .text("👥 Khách hàng", "admin:menu:customers")
    .row()
    .text("👨‍💼 Nhân viên", "admin:menu:staff")
    .text("🔐 Phân quyền", "admin:menu:perms")
    .row()
    .text("📜 Audit", "admin:menu:audit")
    .text("💾 Sao lưu", "admin:menu:backup");

  if (isSuperAdmin) {
    keyboard.row().text("⚙️ Cài đặt hệ thống (Settings)", "admin:menu:settings");
    keyboard.row().text("👑 Super Admin Controls", "admin:menu:super_admin");
  } else {
    keyboard.row().text("⚙️ System Status", "admin:menu:system");
  }

  return keyboard;
}

export function renderAdminStartText(staffName: string, isSuperAdmin: boolean = false): string {
  const title = isSuperAdmin ? "👑 HỆ THỐNG QUẢN TRỊ SUPER ADMIN" : "🛡 HỆ THỐNG QUẢN TRỊ ADMIN";
  return (
    `<b>${title}</b>\n\n` +
    `Xin chào <b>${staffName || "Quản trị viên"}</b>,\n\n` +
    `📌 <b>Các lệnh quản trị chính:</b>\n` +
    `• <code>/settings</code> - <b>Cài đặt hệ thống (API Key, Model AI, Kênh thông báo, Backup)</b>\n` +
    `• <code>/setkey &lt;key&gt;</code> - Cài Google Gemini API Key trực tiếp từ Telegram\n` +
    `• <code>/setmodel &lt;model&gt;</code> - Đổi Model AI (gemini-3.6-flash, gemini-3.5-flash-lite...)\n` +
    `• <code>/sethere</code> - Đặt phòng chat/nhóm này làm kênh nhận thông báo đơn hàng\n` +
    `• <code>/backup</code> - Chạy sao lưu hệ thống ngay lập tức\n` +
    `• <code>/backups</code> - Xem lịch sử các bản sao lưu đã lưu trên VPS\n` +
    `• <code>/testai</code> - Kiểm tra kết nối và độ trễ Gemini AI\n` +
    `• <code>/rates</code> - Xem tỷ giá | <code>/setrate</code> - Cập nhật tỷ giá\n` +
    `• <code>/accounts</code> - Danh sách tài khoản nhận | Gửi ảnh + <code>/addqr</code>\n` +
    `• <code>/staff</code> - Danh sách &amp; phân quyền nhân sự\n` +
    `• <code>/invite &lt;id&gt; &lt;tên&gt; &lt;ADMIN|CSKH&gt;</code> - Mời nhân sự\n\n` +
    `Chọn bảng điều khiển bên dưới:`
  );
}
