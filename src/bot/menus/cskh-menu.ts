import { InlineKeyboard } from "grammy";

export function getCskhMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Khách đang chờ", "cskh:menu:tickets")
    .text("💬 Hội thoại của tôi", "cskh:menu:mytickets")
    .row()
    .text("📦 Đơn hàng", "cskh:menu:orders")
    .text("🔎 Tìm khách", "cskh:menu:find_customer")
    .row()
    .text("📝 Ghi chú", "cskh:menu:notes")
    .text("🤖 Trả về AI", "cskh:menu:release_prompt");
}

export function renderCskhStartText(staffName: string): string {
  return (
    `🎧 <b>BÀN LÀM VIỆC CHĂM SÓC KHÁCH HÀNG (CSKH)</b>\n\n` +
    `Xin chào <b>${staffName || "Nhân viên CSKH"}</b>,\n\n` +
    `📌 <b>Các lệnh hỗ trợ:</b>\n` +
    `• <code>/tickets</code> - Danh sách khách đang chờ hỗ trợ\n` +
    `• <code>/claim &lt;ID_Khách&gt;</code> - Tiếp nhận hỗ trợ (chuyển sang HUMAN)\n` +
    `• <code>/release &lt;ID_Khách&gt;</code> - Hoàn tất (trả về AI AUTO)\n` +
    `• <code>/msg &lt;ID_Khách&gt; &lt;Nội dung&gt;</code> - Nhắn tin tới khách\n` +
    `• <code>/note &lt;ID_Khách&gt; &lt;Nội dung&gt;</code> - Thêm ghi chú nội bộ\n` +
    `• <code>/history &lt;ID_Khách&gt;</code> - Xem lịch sử &amp; ghi chú khách\n` +
    `• <code>/translate &lt;ngôn ngữ&gt; &lt;nội dung&gt;</code> - Dịch thử tin nhắn\n\n` +
    `Chọn một chức năng bên dưới:`
  );
}
