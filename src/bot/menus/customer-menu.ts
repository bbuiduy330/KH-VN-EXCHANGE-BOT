import { InlineKeyboard } from "grammy";

export function getCustomerMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💱 Đổi tiền", "customer:menu:quote")
    .text("📦 Đơn của tôi", "customer:menu:orders")
    .row()
    .text("💬 Hỗ trợ", "customer:menu:support")
    .text("🏦 Tài khoản nhận tiền", "customer:menu:bank");
}

export function renderCustomerStartText(name: string): string {
  return (
    `👋 <b>Xin chào ${name || "Quý khách"}!</b>\n\n` +
    `Chào mừng bạn đến với hệ thống đổi tiền tệ KH-VN Exchange (USD / VND).\n\n` +
    `📌 <b>Hướng dẫn sử dụng nhanh:</b>\n` +
    `1. Nhấn <b>💱 Đổi tiền</b> hoặc nhắn tin số tiền cần đổi:\n` +
    `   <i>Ví dụ: "đổi 1000 USD sang VND" hoặc "100 đô"</i>\n` +
    `2. Nhấn <b>🏦 Tài khoản nhận tiền</b> để thiết lập ngân hàng thụ hưởng:\n` +
    `   <i>Cú pháp:</i> <code>/bank VND|MB Bank|NGUYEN VAN A|123456789</code>\n` +
    `3. Xác nhận báo giá, thanh toán theo QR và gửi ảnh biên lai.\n\n` +
    `🤖 Trợ lý AI và đội ngũ CSKH luôn sẵn sàng hỗ trợ trực tiếp tại khung chat này!`
  );
}
