import { GoogleGenAI } from "@google/genai";
import { logger } from "../../shared/logger.js";
import { SystemSecretService } from "../system-config/system-secret-service.js";
import { SystemConfigService } from "../system-config/system-config-service.js";
import { GeminiModelStrategy, GeminiErrorClassification } from "./gemini-models.js";

export interface ParsedExchangeIntent {
  sourceCurrency: string;
  targetCurrency: string;
  amount: number;
  confidence: number;
}

export interface ExtractedBillData {
  bank?: string;
  amount?: number;
  currency?: string;
  sender?: string;
  receiver?: string;
  transactionId?: string;
  transactionTime?: string;
  reference?: string;
  confidence?: number;
  notes?: string;
}

export interface TranscribeResult {
  transcript: string;
  detectedLanguage?: string;
}

export interface DiagnosticResult {
  ok: boolean;
  configured: boolean;
  source: "ENCRYPTED_DB" | "ENV" | "NONE";
  primaryModel: string;
  actualModel?: string;
  fallbackUsed?: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
  errorCategory?: string;
  attempts?: Array<{
    model: string;
    latencyMs: number;
    error?: GeminiErrorClassification;
  }>;
}

export class AiProvider {
  private static cachedClient: GoogleGenAI | null = null;
  private static cachedClientKey: string = "";

  static invalidateClient(): void {
    this.cachedClient = null;
    this.cachedClientKey = "";
    SystemSecretService.invalidateCache();
    logger.info("AiProvider client cache invalidated");
  }

  private static async getClient(overrideKey?: string): Promise<{
    client: GoogleGenAI | null;
    key: string | null;
    source: "ENCRYPTED_DB" | "ENV" | "NONE";
  }> {
    if (overrideKey) {
      return {
        client: new GoogleGenAI({ apiKey: overrideKey }),
        key: overrideKey,
        source: "ENCRYPTED_DB"
      };
    }

    const resolved = await SystemSecretService.resolveGeminiApiKey();
    if (!resolved.key) {
      return { client: null, key: null, source: "NONE" };
    }

    if (!this.cachedClient || this.cachedClientKey !== resolved.key) {
      this.cachedClient = new GoogleGenAI({ apiKey: resolved.key });
      this.cachedClientKey = resolved.key;
      logger.info({ source: resolved.source }, "Initialized GoogleGenAI client");
    }

    return {
      client: this.cachedClient,
      key: resolved.key,
      source: resolved.source
    };
  }

  static async isAvailable(): Promise<boolean> {
    const resolved = await SystemSecretService.resolveGeminiApiKey();
    return Boolean(resolved.key && resolved.key.length > 0);
  }

  /**
   * Executes a text prompt through the safe fallback model chain.
   */
  static async executeTextPrompt(prompt: string, systemInstruction?: string): Promise<string | null> {
    const { client } = await this.getClient();
    if (!client) return null;

    const configuredModel = SystemConfigService.getGeminiTextModel();
    const models = GeminiModelStrategy.getTextModelChain(configuredModel);

    try {
      const execution = await GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          const config: Record<string, any> = {};
          if (systemInstruction) {
            config.systemInstruction = systemInstruction;
          }

          const response = await client.models.generateContent({
            model,
            contents: prompt,
            config: Object.keys(config).length > 0 ? config : undefined
          });

          return response.text?.trim() || "";
        },
        { contextName: "executeTextPrompt" }
      );

      return execution.result || null;
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "Failed to execute text prompt across fallback models");
      return null;
    }
  }

  /**
   * Diagnostic test with model fallback visibility (Requirement 11 & 12).
   * Uses minimal test prompt: "Return exactly: OK" (does not expose customer/payment data).
   */
  static async testGeminiConnection(overrideKey?: string): Promise<DiagnosticResult> {
    const { client, key, source } = await this.getClient(overrideKey);
    const primaryModel = SystemConfigService.getGeminiTextModel() || GeminiModelStrategy.getPrimaryModel();

    if (!client || !key) {
      return {
        ok: false,
        configured: false,
        source: "NONE",
        primaryModel,
        latencyMs: 0,
        error: "Gemini API key chưa được cấu hình. Dùng lệnh /setkey <key> để kích hoạt."
      };
    }

    const models = GeminiModelStrategy.getTextModelChain(primaryModel);
    const startTime = Date.now();

    try {
      const execution = await GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          const response = await client.models.generateContent({
            model,
            contents: "Return exactly: OK"
          });
          const text = response.text?.trim() || "";
          if (!text) {
            throw new Error("Empty response returned from model");
          }
          return text;
        },
        { contextName: "testGeminiConnection" }
      );

      const fallbackUsed = execution.actualModel !== primaryModel;

      return {
        ok: true,
        configured: true,
        source,
        primaryModel,
        actualModel: execution.actualModel,
        fallbackUsed,
        latencyMs: execution.latencyMs,
        reply: execution.result,
        attempts: execution.attempts
      };
    } catch (err: any) {
      const classification = GeminiModelStrategy.classifyError(err);
      return {
        ok: false,
        configured: true,
        source,
        primaryModel,
        latencyMs: Date.now() - startTime,
        error: classification.message,
        errorCategory: classification.category
      };
    }
  }

  /**
   * Fast regex parser for zero-cost immediate extraction.
   */
  static parseWithRegex(text: string): ParsedExchangeIntent | null {
    const clean = text.toLowerCase().trim();
    const regex = /(?:đổi|chuyển|exchange)?\s*([\d.,]+)\s*([a-zA-Z]{3})\s*(?:sang|to|->|-|được|nhận)\s*([a-zA-Z]{3})/i;
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

  /**
   * Intent vs. Conversational Routing:
   * Extracts structured exchange intent using Gemini, falling back to Regex.
   */
  static async parseExchangeIntent(text: string): Promise<ParsedExchangeIntent | null> {
    const { client } = await this.getClient();
    if (!client) {
      return this.parseWithRegex(text);
    }

    const models = GeminiModelStrategy.getTextModelChain();
    const prompt = `Trích xuất thông tin đổi tiền từ tin nhắn khách hàng: "${text}"
Nếu tin nhắn thể hiện ý định đổi tiền từ loại tiền A sang B (ví dụ USD sang VND, VND sang KHR...):
Trả về định dạng JSON duy nhất:
{"valid": true, "sourceCurrency": "USD", "targetCurrency": "VND", "amount": 1000}
Nếu tin nhắn chỉ là câu hỏi thông thường ("rate thế nào", "alo", "xin chào") không có số tiền và chiều đổi rõ ràng:
Trả về duy nhất:
{"valid": false}`;

    try {
      const execution = await GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          const response = await client.models.generateContent({
            model,
            contents: prompt
          });
          return response.text?.trim() || "";
        },
        { contextName: "parseExchangeIntent" }
      );

      const raw = execution.result;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.valid && parsed.sourceCurrency && parsed.targetCurrency && Number(parsed.amount) > 0) {
          return {
            sourceCurrency: String(parsed.sourceCurrency).toUpperCase(),
            targetCurrency: String(parsed.targetCurrency).toUpperCase(),
            amount: Number(parsed.amount),
            confidence: 0.95
          };
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "Gemini intent parse failed, using regex fallback");
    }

    return this.parseWithRegex(text);
  }

  /**
   * Multimodal Bill Analysis (Requirement 15):
   * Primary model: gemini-3.8-flash.
   * Structured output + validation for bank, amount, currency, sender, receiver, transactionId, etc.
   * NOTE: AI extraction is strictly secondary advisory metadata. AI NEVER confirms payment!
   */
  static async analyzeBillImage(
    imageBuffer: Buffer,
    mimeType: string = "image/jpeg"
  ): Promise<ExtractedBillData | null> {
    const { client } = await this.getClient();
    if (!client) {
      return { notes: "AI unconfigured. Manual check required." };
    }

    const models = GeminiModelStrategy.getMultimodalModelChain();
    const prompt = `Bạn là trợ lý phân tích hóa đơn chuyển khoản ngân hàng.
Trích xuất các thông tin từ biên lai để nhân viên kiểm tra đối soát:
- bank: Tên ngân hàng hoặc ví điện tử (VD: Vietcombank, MB Bank, ABA Bank, Wing, TrueMoney...)
- amount: Số tiền chuyển (dạng số nguyên hoặc số thực, ví dụ 1500000 hoặc 50)
- currency: Đơn vị tiền tệ (VND, USD, KHR)
- sender: Tên người gửi/tài khoản chuyển nếu hiển thị
- receiver: Số tài khoản hoặc tên người thụ hưởng
- transactionId: Mã giao dịch/Mã bút toán/FT number
- transactionTime: Thời gian giao dịch trên bill
- reference: Nội dung chuyển khoản/lời nhắn
- confidence: Độ rõ nét và tin cậy (từ 0.1 đến 1.0)
- notes: Bất kỳ dấu hiệu bất thường hoặc lưu ý nào

Trả về DUY NHẤT một JSON hợp lệ dạng:
{
  "bank": "Vietcombank",
  "amount": 26300000,
  "currency": "VND",
  "sender": "NGUYEN VAN A",
  "receiver": "KH-VN EXCHANGE",
  "transactionId": "FT240987123",
  "transactionTime": "2026-09-08 14:30:00",
  "reference": "ORD-123456",
  "confidence": 0.95,
  "notes": "Biên lai rõ nét"
}`;

    try {
      const execution = await GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
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
          return response.text?.trim() || "";
        },
        { contextName: "analyzeBillImage" }
      );

      const raw = execution.result;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Validate structured output
        return {
          bank: parsed.bank ? String(parsed.bank).trim() : undefined,
          amount: typeof parsed.amount === "number" ? parsed.amount : parseFloat(parsed.amount) || undefined,
          currency: parsed.currency ? String(parsed.currency).toUpperCase().trim() : undefined,
          sender: parsed.sender ? String(parsed.sender).trim() : undefined,
          receiver: parsed.receiver ? String(parsed.receiver).trim() : undefined,
          transactionId: parsed.transactionId ? String(parsed.transactionId).trim() : undefined,
          transactionTime: parsed.transactionTime ? String(parsed.transactionTime).trim() : undefined,
          reference: parsed.reference ? String(parsed.reference).trim() : undefined,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
          notes: parsed.notes ? String(parsed.notes).trim() : undefined
        };
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "Gemini bill analysis failed across models");
    }

    return null;
  }

  /**
   * Voice Transcription (Requirement 16):
   * Preserves original audio and transcribes accurately, detecting language.
   */
  static async transcribeAudio(
    audioBuffer: Buffer,
    mimeType: string = "audio/ogg"
  ): Promise<TranscribeResult | null> {
    const { client } = await this.getClient();
    if (!client) return null;

    const models = GeminiModelStrategy.getTranscribeModelChain();
    const prompt = `Hãy nghe đoạn âm thanh này và chuyển thành văn bản chính xác.
Đồng thời xác định ngôn ngữ (vi: Tiếng Việt, km: Tiếng Khmer, en: Tiếng Anh, zh: Tiếng Trung).
Trả về duy nhất định dạng JSON:
{"transcript": "nội dung đã chuyển thành văn bản", "detectedLanguage": "vi"}`;

    try {
      const execution = await GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          const response = await client.models.generateContent({
            model,
            contents: [
              prompt,
              {
                inlineData: {
                  mimeType,
                  data: audioBuffer.toString("base64")
                }
              }
            ]
          });
          return response.text?.trim() || "";
        },
        { contextName: "transcribeAudio" }
      );

      const raw = execution.result;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.transcript) {
          return {
            transcript: String(parsed.transcript).trim(),
            detectedLanguage: parsed.detectedLanguage ? String(parsed.detectedLanguage).trim() : "vi"
          };
        }
      }

      // If raw response was text directly without JSON formatting
      if (raw && raw.length > 0) {
        return {
          transcript: raw.trim(),
          detectedLanguage: "vi"
        };
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "Gemini voice transcription failed across models");
    }

    return null;
  }

  /**
   * Helper translation for staff previews
   */
  static async translateText(text: string, targetLanguage: string): Promise<string> {
    const prompt = `Translate the following text into ${targetLanguage}. Maintain tone, clarity, and business terminology. Output ONLY the translated text without commentary:\n\n${text}`;
    const result = await this.executeTextPrompt(prompt);
    return result || text;
  }
}
