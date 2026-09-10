import { InlineKeyboard } from "grammy";
import { Quote, Order, ExchangeRate } from "@prisma/client";
import { QuoteService } from "../../modules/quotes/quote-service.js";
import { MoneyService } from "../../modules/money/money-service.js";

/**
 * Customer-facing Vietnamese labels for active order statuses.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  WAITING_PAYMENT: "⏳ Chờ bạn chuyển khoản",
  CUSTOMER_SENT_BILL: "📸 Đã nhận biên lai — chờ đối soát",
  WAITING_ADMIN_VERIFY: "🔍 Nhân viên đang đối soát biên lai",
  PAYMENT_CONFIRMED: "✅ Đã xác nhận thanh toán — chờ giải ngân",
  WAITING_PAYOUT: "💸 Đang chờ chuyển tiền ra",
  PAYOUT_SENT: "💰 Đã chuyển tiền — chờ bạn xác nhận",
  MANUAL_REVIEW: "🛠 Đơn đang được xử lý thủ công",
  SUSPICIOUS: "⚠️ Đơn cần kiểm tra thêm"
};

export function getCustomerMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💱 Đổi tiền", "customer:menu:quote")
    .text("📦 Đơn của tôi", "customer:menu:orders")
    .row()
    .text("💬 Hỗ trợ", "customer:menu:support")
    .text("🏦 Tài khoản nhận tiền", "customer:menu:bank");
}

/**
 * Rates-first welcome for customers without any active transaction.
 * Two-way USD/VND only, customer-facing (no buy/sell terminology).
 */
export async function renderCustomerWelcomeText(name: string): Promise<string> {
  let ratesBlock = "";
  try {
    const allRates: ExchangeRate[] = await QuoteService.getAllRates();
    const usdVnd = allRates.find((r) => r.pair === "USD/VND");
    if (usdVnd) {
      const { effectiveBuy, effectiveSell } = MoneyService.calculateEffectiveRates(
        usdVnd.baseRate,
        usdVnd.buyMargin,
        usdVnd.sellMargin
      );
      ratesBlock =
        `🇺🇸 USD → 🇻🇳 VND\n` +
        `1 USD = ${MoneyService.formatAmount(effectiveBuy, "VND")} VND\n\n` +
        `🇻🇳 VND → 🇺🇸 USD\n` +
        `1 USD = ${MoneyService.formatAmount(effectiveSell, "VND")} VND\n`;
    }
  } catch {
    ratesBlock = `Tỷ giá được cập nhật liên tục theo thị trường.\n`;
  }

  return (
    `👋 <b>Xin chào ${name || "Quý khách"}!</b>\n\n` +
    `💱 <b>TỶ GIÁ HÔM NAY</b>\n\n` +
    ratesBlock +
    `\nAnh/chị chỉ cần nhắn tự nhiên:\n` +
    `• <i>100 đô</i>\n` +
    `• <i>500$ lấy tiền Việt</i>\n` +
    `• <i>10 triệu lấy đô</i>\n` +
    `• <i>20tr đổi USD</i>\n\n` +
    `🤖 Trợ lý AI và đội ngũ CSKH luôn sẵn sàng hỗ trợ trực tiếp tại khung chat này!`
  );
}

/**
 * Active order status view shown instead of the generic welcome.
 */
export async function renderActiveOrderText(order: Order): Promise<string> {
  const statusLabel = ORDER_STATUS_LABELS[order.status] || order.status;
  const srcAmt = MoneyService.formatAmount(order.sourceAmount, order.sourceCurrency);
  const tgtAmt = MoneyService.formatAmount(order.targetAmount, order.targetCurrency);

  let msg =
    `📦 <b>ĐƠN HÀNG CỦA BẠN ĐANG XỬ LÝ</b>\n\n` +
    `• Mã đơn: <code>${order.id}</code>\n` +
    `• Đổi: <b>${srcAmt} ${order.sourceCurrency}</b> ➔ <b>${tgtAmt} ${order.targetCurrency}</b>\n` +
    `• Trạng thái: <b>${statusLabel}</b>\n`;

  if (order.status === "WAITING_PAYMENT") {
    const recv = order.receivingAccountSnapshot as {
      bankName?: string;
      accountName?: string;
      accountNumber?: string;
    } | null;

    if (recv?.accountNumber) {
      msg +=
        `\n💳 <b>THÔNG TIN CHUYỂN KHOẢN:</b>\n` +
        `• Ngân hàng: <b>${recv.bankName || "N/A"}</b>\n` +
        `• Chủ tài khoản: <b>${recv.accountName || "N/A"}</b>\n` +
        `• Số tài khoản: <code>${recv.accountNumber}</code>\n` +
        `• Số tiền: <b>${srcAmt} ${order.sourceCurrency}</b>\n\n` +
        `Sau khi chuyển khoản, anh/chị chỉ cần <b>gửi ảnh biên lai</b> vào khung chat này.`;
    } else {
      msg += `\nVui lòng chờ nhân viên gửi thông tin chuyển khoản chính thức.`;
    }
  }

  return msg;
}

/**
 * Shared customer quote card (used by chat flow and /start resume).
 */
export function renderQuoteCard(quote: Quote, expiryMinutes: number): string {
  const rateDisplay = MoneyService.formatEffectiveRate(
    quote.sourceCurrency,
    quote.targetCurrency,
    quote.effectiveRate
  );
  const formattedSrc = MoneyService.formatAmount(quote.sourceAmount, quote.sourceCurrency);
  const formattedTgt = MoneyService.formatAmount(quote.targetAmount, quote.targetCurrency);

  return (
    `📊 <b>BÁO GIÁ ĐỔI TIỀN TỆ</b>\n\n` +
    `• Quý khách gửi: <b>${formattedSrc} ${quote.sourceCurrency}</b>\n` +
    `• Quý khách nhận: <b>${formattedTgt} ${quote.targetCurrency}</b>\n` +
    `• Tỷ giá áp dụng: <b>${rateDisplay}</b>\n` +
    `• Phí dịch vụ: <b>${quote.fee} ${quote.feeCurrency}</b>\n` +
    `• Hiệu lực: <i>${expiryMinutes} phút</i>\n\n` +
    `Bấm nút dưới đây để tạo đơn và nhận tài khoản chuyển tiền:`
  );
}
