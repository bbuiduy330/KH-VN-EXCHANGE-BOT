import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { SystemConfigService } from "../system-config/system-config-service.js";

export interface ParsedExchangeIntent {
  sourceCurrency: string;
  targetCurrency: string;
  amount: number;
  confidence: number;
}

export interface ExtractedBillData {
  transactionId?: string;
  senderName?: string;
  receiverAccount?: string;
  amount?: number;
  currency?: string;
  timestamp?: string;
  notes?: string;
}

export class AiProvider {
  private static aiClient: GoogleGenAI | null = null;
  private static activeKey: string = "";

  private static getClient(): GoogleGenAI | null {
    const key = SystemConfigService.getGeminiApiKey();
    if (!key) return null;

    if (!this.aiClient || this.activeKey !== key) {
      try {
        this.aiClient = new GoogleGenAI({ apiKey: key });
        this.activeKey = key;
        logger.info("Initialized GoogleGenAI client with active dynamic API key");
      } catch (err) {
        logger.warn({ err }, "Failed to initialize GoogleGenAI");
        return null;
      }
    }
    return this.aiClient;
  }

  static isAvailable(): boolean {
    return Boolean(SystemConfigService.getGeminiApiKey());
  }

  // Models list in order of priority
  private static getModelCandidates(primaryModel?: string): string[] {
    const primary = primaryModel || SystemConfigService.getGeminiTextModel();
    const candidates = [primary, "gemini-3.6-flash", "gemini-3.5-flash-lite"];
    return Array.from(new Set(candidates));
  }

  // Diagnostic test to verify Gemini API key & model connectivity
  static async testGeminiConnection(overrideKey?: string): Promise<{
    ok: boolean;
    model: string;
    latencyMs: number;
    reply?: string;
    error?: string;
  }> {
    const key = overrideKey || SystemConfigService.getGeminiApiKey();
    const primaryModel = SystemConfigService.getGeminiTextModel();

    if (!key) {
      return {
        ok: false,
        model: primaryModel,
        latencyMs: 0,
        error: "GEMINI_API_KEY chưa được cấu hình. Dùng lệnh /setkey <key> trên Telegram để kích hoạt."
      };
    }

    const testClient = overrideKey ? new GoogleGenAI({ apiKey: overrideKey }) : this.getClient();
    if (!testClient) {
      return {
        ok: false,
        model: primaryModel,
        latencyMs: 0,
        error: "Không thể khởi tạo Gemini Client với key này."
      };
    }

    const startTime = Date.now();
    const models = this.getModelCandidates(primaryModel);

    let lastError: any = null;
    for (const model of models) {
      try {
        const response = await testClient.models.generateContent({
          model,
          contents: "Xin chào! Hãy phản hồi ngắn gọn: 'Gemini AI đang hoạt động tốt trên hệ thống KH-VN Exchange.'"
        });
        const latencyMs = Date.now() - startTime;
        return {
          ok: true,
          model,
          latencyMs,
          reply: response.text?.trim()
        };
      } catch (err: any) {
        lastError = err;
        logger.warn({ model, err: err?.message || err }, "Gemini test failed for model, trying next");
      }
    }

    return {
      ok: false,
      model: primaryModel,
      latencyMs: Date.now() - startTime,
      error: lastError?.message || "All Gemini models failed"
    };
  }

  // Intelligent Customer Support / Chat consultation with Gemini
  static async generateCustomerConsultation(
    customerMessage: string,
    context?: {
      ratesSummary?: string;
      customerName?: string;
    }
  ): Promise<string | null> {
    const client = this.getClient();
    if (!client) return null;

    const ratesInfo = context?.ratesSummary || "USD, VND, KHR (hỗ trợ chuyển hai chiều)";
    const prompt = `Bạn là Trợ lý Ảo chăm sóc khách hàng của dịch vụ đổi tiền "KH-VN Exchange" (chuyên chuyển tiền và đổi tiền hai chiều Việt Nam - Campuchia).

THÔNG TIN HỆ THỐNG:
- Tỷ giá hiện hành:
${ratesInfo}
- Phương thức nhận & chuyển:
  + Việt Nam: Chuyển khoản mọi ngân hàng nội địa (Vietcombank, MB, Techcombank, VPBank...) và ví điện tử.
  + Campuchia: ABA Bank, Wing, TrueMoney, Acleda, tiền mặt USD/KHR.
- Quy trình: Khách gửi yêu cầu -> Nhận báo giá & mã QR -> Khách chuyển khoản & gửi ảnh biên lai -> Nhân viên đối soát tài khoản và giải ngân trong 5-10 phút.

YÊU CẦU TRẢ LỜI:
- Khách hàng [${context?.customerName || "Khách"}]: "${customerMessage}"
- Hãy trả lời lịch sự, thân thiện, súc tích (khoảng 2-4 câu).
- Hướng dẫn khách cụ thể: Nếu muốn đổi tiền, khách có thể gửi tin nhắn theo cú pháp ví dụ: "đổi 500 USD sang VND" hoặc nhấn nút "💱 Đổi tiền".
- Nếu khách cần hỗ trợ đặc biệt hoặc gặp vấn đề, hướng dẫn khách nhấn nút "💬 Hỗ trợ" để gặp nhân viên trực tiếp.
- QUY TẮC AN TOÀN: Tuyệt đối không tự ý bịa số tài khoản ngân hàng hoặc xác nhận đã nhận tiền (chỉ hệ thống tạo đơn và nhân viên đối soát).
- Định dạng: Văn bản thuần túy, có thể dùng emoji phù hợp, KHÔNG dùng Markdown phức tạp (tránh lỗi ký tự đặc biệt).`;

    const models = this.getModelCandidates();
    for (const model of models) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: prompt
        });
        const reply = response.text?.trim();
        if (reply) return reply;
      } catch (err: any) {
        logger.warn({ model, err: err?.message || err }, "Gemini consultation failed, trying fallback model");
      }
    }

    return null;
  }

  // Regex fallback parser when Gemini is not configured
  static parseWithRegex(text: string): ParsedExchangeIntent | null {
    const clean = text.toLowerCase().trim();
    // Pattern: đổi 1000 USD sang VND, 1000 usd to vnd, 1000usd -> vnd
    const regex = /(?:đổi|chuyển|exchange)?\s*([\d.,]+)\s*([a-zA-Z]{3})\s*(?:sang|to|->|-)\s*([a-zA-Z]{3})/i;
    const match = clean.match(regex);

    if (match && match[1] && match[2] && match[3]) {
      const rawAmount = match[1].replace(/,/g, "");
      const amount = parseFloat(rawAmount);
      if (!isNaN(amount) && amount > 0) {
        return {
          amount,
          sourceCurrency: match[2].toUpperCase(),
          targetCurrency: match[3].toUpperCase(),
          confidence: 0.9
        };
      }
    }
    return null;
  }

  static async parseExchangeIntent(text: string): Promise<ParsedExchangeIntent | null> {
    const client = this.getClient();
    if (!client) {
      return this.parseWithRegex(text);
    }

    const models = this.getModelCandidates();
    for (const model of models) {
      try {
        const prompt = `Bạn là trợ lý trích xuất yêu cầu đổi tiền tệ.
Văn bản của khách: "${text}"
Hãy trích xuất:
- sourceCurrency (USD, VND, hoặc KHR)
- targetCurrency (USD, VND, hoặc KHR)
- amount (số tiền dạng số)
Nếu không xác định được, trả về {"valid": false}.
Trả về JSON định dạng duy nhất:
{"valid": true, "sourceCurrency": "USD", "targetCurrency": "VND", "amount": 1000}`;

        const response = await client.models.generateContent({
          model,
          contents: prompt
        });

        const raw = response.text || "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.valid && parsed.sourceCurrency && parsed.targetCurrency && parsed.amount) {
            return {
              sourceCurrency: parsed.sourceCurrency.toUpperCase(),
              targetCurrency: parsed.targetCurrency.toUpperCase(),
              amount: Number(parsed.amount),
              confidence: 0.95
            };
          }
        }
        // If parsed as { valid: false }
        break;
      } catch (err: any) {
        logger.warn({ model, err: err?.message || err }, "Gemini parsing error, trying next model candidate");
      }
    }

    return this.parseWithRegex(text);
  }

  static async analyzeBillImage(
    imageBuffer: Buffer,
    mimeType: string = "image/jpeg"
  ): Promise<ExtractedBillData | null> {
    const client = this.getClient();
    if (!client) {
      return { notes: "AI unconfigured. Manual admin check required." };
    }

    const models = this.getModelCandidates();
    for (const model of models) {
      try {
        const prompt = `Phân tích biên lai chuyển khoản này và trích xuất thông tin để tham khảo (LƯU Ý: Đây chỉ là metadata hỗ trợ, admin sẽ kiểm tra tài khoản thực tế).
Trả về JSON duy nhất với các trường:
{
  "transactionId": "mã giao dịch nếu có",
  "senderName": "tên người chuyển",
  "receiverAccount": "tài khoản nhận",
  "amount": 1000,
  "currency": "USD",
  "timestamp": "thời gian trên biên lai",
  "notes": "ghi chú thêm"
}`;

        const response = await client.models.generateContent({
          model,
          contents: [
            prompt,
            {
              inlineData: {
                mimeType,
                data: imageBuffer.toString("base64")
              }
            }
          ]
        });

        const raw = response.text || "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
      } catch (err: any) {
        logger.warn({ model, err: err?.message || err }, "Gemini image analysis failed, trying next candidate");
      }
    }

    return null;
  }

  static async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string = "audio/ogg"
  ): Promise<string | null> {
    const client = this.getClient();
    if (!client) return null;

    try {
      const response = await client.models.generateContent({
        model: env.GEMINI_TRANSCRIBE_MODEL,
        contents: [
          "Hãy chuyển đổi đoạn âm thanh tin nhắn thoại này thành văn bản chính xác.",
          {
            inlineData: {
              mimeType,
              data: audioBuffer.toString("base64")
            }
          }
        ]
      });
      return response.text || null;
    } catch (err) {
      logger.warn({ err }, "Gemini voice transcription failed");
      return null;
    }
  }

  static async translateText(text: string, targetLanguage: string): Promise<string> {
    const client = this.getClient();
    if (!client) return text;

    try {
      const prompt = `Dịch văn bản sau sang ngôn ngữ ${targetLanguage}. Chỉ trả về câu dịch hoàn chỉnh, không thêm lời giải thích:
"${text}"`;
      const response = await client.models.generateContent({
        model: env.GEMINI_TEXT_MODEL,
        contents: prompt
      });
      return response.text?.trim() || text;
    } catch (err) {
      logger.warn({ err }, "Translation error");
      return text;
    }
  }
}
