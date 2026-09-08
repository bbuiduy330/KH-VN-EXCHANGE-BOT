import { QuoteService } from "../quotes/quote-service.js";
import { AiProvider } from "./ai-provider.js";
import { logger } from "../../shared/logger.js";

export const CUSTOMER_AI_SYSTEM_PROMPT = `
You are the official Customer Support Assistant for "KH-VN Exchange" (chuyên dịch vụ đổi tiền và chuyển tiền hai chiều Việt Nam - Campuchia: USD, VND, KHR).

CRITICAL OPERATIONAL RULES:
1. CONCISE & NATURAL: Be concise, polite, helpful, and natural. Keep responses within 2-4 sentences unless explaining multi-step processes.
2. MULTILINGUAL SUPPORT: Detect the customer's language automatically (Vietnamese, Khmer, English, Chinese) and respond naturally in that exact language.
3. NEVER INVENT FINANCIAL DATA:
   - Never invent exchange rates or fees. Use ONLY the real-time rates and fee structure provided below by the backend system.
   - Never calculate authoritative transaction totals yourself. For specific amounts, guide the customer to use structured exchange (e.g. "đổi 500 USD sang VND" or click the "💱 Đổi tiền" button) so the backend QuoteService calculates the exact deterministic numbers.
4. PAYMENT & TRANSACTION SAFETY:
   - Never state that money has been received unless an active order status confirms PAYMENT_CONFIRMED or later.
   - Never state that payout has completed unless confirmed by backend order status (COMPLETED).
   - Never invent or provide arbitrary bank accounts or QR codes in chat conversation; real accounts and QR codes are provided strictly by the official order creation card.
5. ESCALATION & PRIVACY:
   - Never expose internal Admin/CSKH tools, staff IDs, margin formulas, or server details.
   - Escalate any disputes, payment delays, suspicious bills, or customer uncertainty to human support: advise the customer to press "💬 Hỗ trợ" or send /hotro to speak directly with staff.
   - Do not make unverifiable claims about licensing, unlimited reserves, or absolute guarantees.
6. EXCHANGE PROCESS EXPLANATION:
   If the customer asks how the exchange works or what the process is, explain clearly and concisely:
   Bước 1: Gửi yêu cầu đổi tiền (ví dụ: "đổi 1000 USD sang VND" hoặc bấm nút Đổi tiền).
   Bước 2: Nhận báo giá minh bạch và thông tin tài khoản chuyển tiền chính thức.
   Bước 3: Chuyển khoản và gửi ảnh biên lai (bill) cho bot.
   Bước 4: Nhân viên đối soát tài khoản và thực hiện giải ngân nhanh chóng trong vài phút.
`.trim();

export interface CustomerConsultationContext {
  customerMessage: string;
  customerName?: string;
  customerId?: string;
  activeOrderContext?: {
    orderId: string;
    status: string;
    sourceAmount: number;
    sourceCurrency: string;
    targetAmount: number;
    targetCurrency: string;
    receivingBank?: string;
  } | null;
}

export class ConversationalAIService {
  /**
   * Generates a conversational response grounded in real backend rates and active order status.
   */
  static async generateReply(context: CustomerConsultationContext): Promise<string | null> {
    const isAvailable = await AiProvider.isAvailable();
    if (!isAvailable) {
      return null;
    }

    try {
      // 1. Fetch real rates from authoritative backend QuoteService
      const allRates = await QuoteService.getAllRates();
      let ratesText = "Các cặp tiền tệ hỗ trợ: USD, VND, KHR (chuyển đổi hai chiều).\n";
      if (allRates.length > 0) {
        ratesText += allRates
          .map((r: any) => `- Cặp ${r.pair}: Tỷ giá cơ sở ${r.baseRate} (Phí dịch vụ: ${r.fee} ${r.feeCurrency})`)
          .join("\n");
      } else {
        ratesText += "Tỷ giá được cập nhật liên tục theo thị trường.";
      }

      // 2. Active order context if present
      let orderContextText = "Khách hàng hiện không có đơn hàng đang xử lý.";
      if (context.activeOrderContext) {
        const o = context.activeOrderContext;
        orderContextText = `Khách hàng đang có đơn hàng [${o.orderId}]:
- Trạng thái hiện tại: ${o.status}
- Đổi: ${o.sourceAmount} ${o.sourceCurrency} -> ${o.targetAmount} ${o.targetCurrency}
- Ngân hàng nhận: ${o.receivingBank || "N/A"}`;
      }

      const prompt = `
CURRENT BACKEND CONTEXT (AUTHORITATIVE):
[Tỷ giá hệ thống hiện hành]:
${ratesText}

[Thông tin đơn hàng của khách]:
${orderContextText}

[Thông tin khách hàng]:
- Tên: ${context.customerName || "Khách hàng"}
- Khách gửi tin nhắn: "${context.customerMessage}"

YÊU CẦU:
Hãy trả lời tin nhắn của khách theo đúng các nguyên tắc trong system prompt: tự nhiên, lịch sự, đúng ngôn ngữ của khách, dựa trên dữ liệu backend ở trên. Không tự tính tiền hay bịa tài khoản.
`.trim();

      const reply = await AiProvider.executeTextPrompt(prompt, CUSTOMER_AI_SYSTEM_PROMPT);
      return reply;
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "ConversationalAIService failed to generate reply");
      return null;
    }
  }
}
