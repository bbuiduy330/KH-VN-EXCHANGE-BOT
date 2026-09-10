import { GoogleGenAI } from "@google/genai";
import { logger } from "../../shared/logger.js";
import { SystemSecretService } from "../system-config/system-secret-service.js";
import { SystemConfigService } from "../system-config/system-config-service.js";
import { GeminiModelStrategy, GeminiErrorClassification } from "./gemini-models.js";
import { MoneyService } from "../money/money-service.js";

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

// Supported business currencies (USD <-> VND only in current scope).
// Centralized so future currencies (e.g. CNY) can be added in one place.
const SUPPORTED_CURRENCIES = ["USD", "VND"] as const;
type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

// Ordered alias list: longer/more specific aliases must come first
// to avoid substring collisions (e.g. "dong" before "do").
const CURRENCY_ALIASES: Array<[string, string]> = [
  ["do la", "USD"],
  ["usd", "USD"],
  ["$", "USD"],
  ["dong", "VND"],
  ["tien viet", "VND"],
  ["tien viet nam", "VND"],
  ["vnd", "VND"],
  ["do", "USD"],
];

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
   * Normalizes Vietnamese text: lowercase, strips diacritics, replaces đ -> d.
   * "đổi 100 đô" -> "doi 100 do"
   */
  static normalizeText(text: string): string {
    return text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .trim();
  }

  /**
   * Extracts the first amount token from normalized text and delegates
   * to the centralized MoneyService.parseHumanAmount for safe parsing.
   * "100" -> 100, "100k" -> 100000, "1 trieu" -> 1000000, "2m" -> 2000000
   */
  static parseAmount(normalized: string): number | null {
    const match = normalized.match(/(-?\d[\d\s.,]*?)\s*(trieu|nghin|ngan|tr|m|k)?(?=\s|$)/);
    if (!match || !match[1]) return null;
    const token = (match[1] + (match[2] ? ` ${match[2]}` : "")).trim();
    return MoneyService.parseHumanAmount(token);
  }

  /**
   * Detects a supported currency alias in normalized text.
   * Returns ISO code ("USD" | "VND") or null.
   */
  static detectCurrency(normalized: string): string | null {
    for (const [alias, code] of CURRENCY_ALIASES) {
      if (alias === "$") {
        if (normalized.includes("$")) return code;
      } else {
        const regex = new RegExp(`\\b${this.escapeRegex(alias)}\\b`, "i");
        if (regex.test(normalized)) return code;
      }
    }
    return null;
  }

  /**
   * Finds the first supported currency token with its position in normalized text.
   */
  private static findCurrencyToken(normalized: string): { code: string; index: number } | null {
    let best: { code: string; index: number } | null = null;
    for (const [alias, code] of CURRENCY_ALIASES) {
      if (alias === "$") {
        const idx = normalized.indexOf("$");
        if (idx !== -1 && (!best || idx < best.index)) best = { code, index: idx };
      } else {
        const regex = new RegExp(`\\b${this.escapeRegex(alias)}\\b`, "i");
        const match = regex.exec(normalized);
        if (match && match.index !== undefined && (!best || match.index < best.index)) {
          best = { code, index: match.index };
        }
      }
    }
    return best;
  }

  /**
   * True when the amount in the text is VND-scale (Vietnamese magnitude suffix
   * or numeric value >= 1000), enabling safe VND-side inference.
   * "10 trieu", "500k", "2 000 000" -> true; "100" -> false.
   */
  private static isVndScaleAmount(normalized: string): boolean {
    if (/\b(?:trieu|tr|m|nghin|ngan|k)\b/.test(normalized)) return true;
    const amount = this.parseAmount(normalized);
    return amount !== null && amount >= 1000;
  }

  /**
   * Infers the target currency from the source currency.
   * USD -> VND, VND -> USD. Returns null for unsupported sources.
   */
  static inferTargetCurrency(sourceCurrency: string): string | null {
    if (sourceCurrency === "USD") return "VND";
    if (sourceCurrency === "VND") return "USD";
    return null;
  }

  /**
   * Checks if the normalized text contains an exchange signal:
   * exchange verbs (doi, chuyen, exchange), direction separators (sang, to, ->, duoc, nhan),
   * or the $ symbol.
   */
  private static hasExchangeSignal(normalized: string): boolean {
    if (/\b(?:doi|chuyen|exchange)\b/.test(normalized)) return true;
    if (/\b(?:sang|to|duoc|nhan|lay|ra|qua)\b/.test(normalized)) return true;
    if (normalized.includes("->")) return true;
    if (normalized.includes("$")) return true;
    return false;
  }

  /**
   * Checks if the normalized text is a compact amount+currency message
   * (e.g. "100 usd", "500k vnd", "100$", "100 do").
   * After removing the amount token and currency aliases, only whitespace should remain.
   */
  private static isCompactAmountCurrency(normalized: string): boolean {
    let stripped = normalized;
    // Remove amount token (number + optional multiplier)
    stripped = stripped.replace(/(-?\d[\d\s.,]*)\s*(trieu|nghin|ngan|tr|m|k)?/, "");
    // Remove currency aliases (word-bounded)
    for (const [alias] of CURRENCY_ALIASES) {
      if (alias === "$") {
        stripped = stripped.replace(/\$/g, "");
      } else {
        const regex = new RegExp(`\\b${this.escapeRegex(alias)}\\b`, "gi");
        stripped = stripped.replace(regex, "");
      }
    }
    return stripped.trim() === "";
  }

  /**
   * Escapes regex special characters in a string.
   */
  private static escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Deterministic local exchange-intent parser.
   * Recognizes: "doi 100 do", "100$", "100k vnd", "1 trieu vnd sang usd", etc.
   * Returns null when the text is not a recognizable exchange request.
   */
  static parseLocalExchangeIntent(text: string): ParsedExchangeIntent | null {
    const normalized = this.normalizeText(text);
    if (!normalized) return null;

    const amount = this.parseAmount(normalized);
    if (!amount) return null;

    // Require an exchange signal (verb, separator, $) OR a compact amount+currency message.
    // This prevents false positives like "gia 100 usd" or "doanh thu 100 usd".
    if (!this.hasExchangeSignal(normalized) && !this.isCompactAmountCurrency(normalized)) {
      return null;
    }

    // Split on direction separator: sang | to | -> | duoc | nhan | lay | ra | qua
    const separatorMatch = normalized.match(/\b(?:sang|to|duoc|nhan|lay|ra|qua)\b|\s*->\s*/);

    let sourceCurrency: string | null = null;
    let targetCurrency: string | null = null;

    if (separatorMatch && separatorMatch.index !== undefined) {
      const before = normalized.slice(0, separatorMatch.index);
      const after = normalized.slice(separatorMatch.index + separatorMatch[0].length);
      sourceCurrency = this.detectCurrency(before);
      targetCurrency = this.detectCurrency(after);

      // Direction words carry the side information: when the amount side has no
      // explicit currency, infer it from the other side using VND magnitude.
      // Examples: "10 trieu lay $" / "20 trieu sang do" / "10 tr lay do" -> VND -> USD.
      if (!sourceCurrency && targetCurrency) {
        if (this.isVndScaleAmount(normalized)) {
          sourceCurrency = targetCurrency === "USD" ? "VND" : "USD";
        } else {
          // Genuinely uncertain ("100 lay do") -> ask / Gemini fallback.
          return null;
        }
      }
    } else {
      // No separator: a currency stated AFTER a change verb is the TARGET
      // ("10m doi usd" = 10 million VND -> USD), otherwise it is the SOURCE
      // ("100 do" = 100 USD -> VND).
      const currencyToken = this.findCurrencyToken(normalized);
      const amountMatch = normalized.match(/(-?\d[\d\s.,]*?)\s*(trieu|nghin|ngan|tr|m|k)?(?=\s|$)/);
      const amountEnd =
        amountMatch && amountMatch.index !== undefined ? amountMatch.index + amountMatch[0].length : 0;
      const hasChangeVerbAfterAmount = /\b(?:doi|chuyen|exchange)\b/.test(normalized.slice(amountEnd));

      if (currencyToken && hasChangeVerbAfterAmount && currencyToken.index >= amountEnd) {
        targetCurrency = currencyToken.code;
        sourceCurrency = targetCurrency === "USD" ? "VND" : "USD";
        if (!this.isVndScaleAmount(normalized)) return null;
      } else {
        sourceCurrency = currencyToken ? currencyToken.code : null;
      }
    }

    if (!sourceCurrency) return null;
    if (!SUPPORTED_CURRENCIES.includes(sourceCurrency as SupportedCurrency)) return null;

    if (separatorMatch && separatorMatch.index !== undefined) {
      // User explicitly stated a target: it must be recognized and supported.
      // Do NOT infer a different target (e.g. "100 usd sang khr" must be rejected).
      if (!targetCurrency) return null;
      if (!SUPPORTED_CURRENCIES.includes(targetCurrency as SupportedCurrency)) return null;
    } else {
      // No target stated: infer from source (USD -> VND, VND -> USD).
      targetCurrency = this.inferTargetCurrency(sourceCurrency);
      if (!targetCurrency) return null;
    }

    if (sourceCurrency === targetCurrency) return null;

    return {
      amount,
      sourceCurrency,
      targetCurrency,
      confidence: 0.9
    };
  }

  /**
   * Backward-compatible alias for the deterministic local parser.
   */
  static parseWithRegex(text: string): ParsedExchangeIntent | null {
    return this.parseLocalExchangeIntent(text);
  }

  /**
   * Intent vs. Conversational Routing:
   * 1. Deterministic local parser first (no Gemini call for simple requests).
   * 2. Gemini fallback for complex sentences.
   * 3. Returns null -> existing conversation/help fallback.
   */
  static async parseExchangeIntent(text: string): Promise<ParsedExchangeIntent | null> {
    // 1. Local deterministic parser first
    const localIntent = this.parseLocalExchangeIntent(text);
    if (localIntent) return localIntent;

    // 2. Gemini fallback for complex sentences
    const { client } = await this.getClient();
    if (!client) return null;

    const configuredModel = SystemConfigService.getGeminiTextModel();
    const models = GeminiModelStrategy.getTextModelChain(configuredModel);
    const prompt = `Trích xuất thông tin đổi tiền từ tin nhắn khách hàng: "${text}"
Chỉ hỗ trợ 2 loại tiền tệ: USD và VND.
Nhận diện từ viết tắt: "đô", "$", "do" = USD; "đồng", "dong" = VND.
Số tiền có thể có hậu tố: "k" = x1000, "triệu"/"trieu" = x1000000.
Nếu khách chỉ nêu 1 loại tiền (ví dụ "100 đô"), tự suy ra loại tiền còn lại:
- Nguồn USD -> Đích VND
- Nguồn VND -> Đích USD
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
        const source = String(parsed.sourceCurrency || "").toUpperCase();
        const target = String(parsed.targetCurrency || "").toUpperCase();
        const amount = Number(parsed.amount);

        if (
          parsed.valid &&
          SUPPORTED_CURRENCIES.includes(source as SupportedCurrency) &&
          SUPPORTED_CURRENCIES.includes(target as SupportedCurrency) &&
          source !== target &&
          isFinite(amount) &&
          amount > 0
        ) {
          return {
            sourceCurrency: source,
            targetCurrency: target,
            amount,
            confidence: 0.95
          };
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message || err }, "Gemini intent parse failed");
    }

    return null;
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
- currency: Đơn vị tiền tệ (VND, USD)
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
