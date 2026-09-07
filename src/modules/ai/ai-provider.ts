import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

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

  private static getClient(): GoogleGenAI | null {
    if (!this.aiClient && env.GEMINI_API_KEY) {
      try {
        this.aiClient = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
      } catch (err) {
        logger.warn({ err }, "Failed to initialize GoogleGenAI");
        return null;
      }
    }
    return this.aiClient;
  }

  static isAvailable(): boolean {
    return Boolean(env.GEMINI_API_KEY);
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
        model: env.GEMINI_TEXT_MODEL,
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
    } catch (err) {
      logger.warn({ err }, "Gemini parsing error, falling back to regex");
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
        model: env.GEMINI_TEXT_MODEL,
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
    } catch (err) {
      logger.warn({ err }, "Gemini image analysis failed");
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
