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
    .text("⚙️ System", "admin:menu:system");

  if (isSuperAdmin) {
    keyboard.row().text("👑 Super Admin Controls", "admin:menu:super_admin");
  }

  return keyboard;
}

export function renderAdminStartText(staffName: string, isSuperAdmin: boolean = false): string {
  const title = isSuperAdmin ? "👑 HỆ THỐNG QUẢN TRỊ SUPER ADMIN" : "🛡 HỆ THỐNG QUẢN TRỊ ADMIN";
  return (
    `<b>${title}</b>\n\n` +
    `Xin chào <b>${staffName || "Quản trị viên"}</b>,\n\n` +
    `📌 <b>Các lệnh quản trị chính:</b>\n` +
    `• <code>/pending</code> - Các đơn chờ duyệt nạp / chi tiền\n` +
    `• <code>/rates</code> - Xem tỷ giá | <code>/setrate</code> - Cập nhật tỷ giá\n` +
    `• <code>/accounts</code> - Danh sách tài khoản nhận | Gửi ảnh + <code>/addqr</code>\n` +
    `• <code>/staff</code> - Danh sách &amp; phân quyền nhân sự\n` +
    `• <code>/invite &lt;id&gt; &lt;tên&gt; &lt;ADMIN|CSKH&gt;</code> - Mời nhân sự\n` +
    `• <code>/storage &lt;orderId&gt;</code> - Kiểm tra kho lưu trữ đơn hàng trên VPS\n` +
    `• <code>/audit</code> - Xem nhật ký kiểm toán bảo mật\n\n` +
    `Chọn bảng điều khiển bên dưới:`
  );
}
