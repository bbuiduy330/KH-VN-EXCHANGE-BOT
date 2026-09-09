import { describe, it, expect, beforeEach } from "vitest";
import { GeminiModelStrategy } from "../src/modules/ai/gemini-models.js";
import { EncryptionService } from "../src/modules/security/encryption-service.js";
import { SystemSecretService } from "../src/modules/system-config/system-secret-service.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { env } from "../src/config/env.js";

describe("Requirement 18: AI Model Strategy & Fallback Engine", () => {
  it("Model chain ordering: gemini-3.8-flash -> gemini-3.6-flash -> gemini-3.5-flash-lite", () => {
    const chain = GeminiModelStrategy.getTextModelChain();
    expect(chain).toEqual(["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]);
  });

  it("Custom primary model keeps configured model first, followed by fallbacks without duplicates", () => {
    const customChain = GeminiModelStrategy.getTextModelChain("gemini-3.6-flash");
    expect(customChain[0]).toBe("gemini-3.6-flash");
    expect(customChain).toContain("gemini-3.8-flash");
    expect(customChain).toContain("gemini-3.5-flash-lite");
    // Ensure no duplicates
    const unique = new Set(customChain);
    expect(unique.size).toBe(customChain.length);
  });

  it("Fallback occurs on 404 (Model Not Found)", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

    const result = await GeminiModelStrategy.executeWithFallback(
      models,
      async (model) => {
        executedModels.push(model);
        if (model === "gemini-3.8-flash") {
          const err: any = new Error("models/gemini-3.8-flash is not found for API version");
          err.status = 404;
          throw err;
        }
        return `SUCCESS_FROM_${model}`;
      }
    );

    expect(executedModels).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(result.actualModel).toBe("gemini-3.6-flash");
    expect(result.result).toBe("SUCCESS_FROM_gemini-3.6-flash");
  });

  it("Fallback occurs on 429 (Rate Limit / Quota Exceeded)", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];

    const result = await GeminiModelStrategy.executeWithFallback(
      models,
      async (model) => {
        executedModels.push(model);
        if (model === "gemini-3.8-flash") {
          const err: any = new Error("RESOURCE_EXHAUSTED: Quota exceeded for quota metric");
          err.status = 429;
          throw err;
        }
        return "SUCCESS_FALLBACK";
      }
    );

    expect(executedModels).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(result.result).toBe("SUCCESS_FALLBACK");
  });

  it("Fallback occurs on 503 (Server Unavailable / Overloaded)", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];

    const result = await GeminiModelStrategy.executeWithFallback(
      models,
      async (model) => {
        executedModels.push(model);
        if (model === "gemini-3.8-flash") {
          const err: any = new Error("The model is overloaded. Please try again later.");
          err.status = 503;
          throw err;
        }
        return "SUCCESS_503_FALLBACK";
      }
    );

    expect(executedModels).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(result.result).toBe("SUCCESS_503_FALLBACK");
  });

  it("NO fallback on 401 / 403 (Invalid API Key / Permission Denied)", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];

    let capturedClassification: any = null;

    await expect(
      GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          executedModels.push(model);
          const err: any = new Error("API_KEY_INVALID: API key not valid. Please pass a valid API key.");
          err.status = 401;
          throw err;
        },
        {
          onAuthError: (c) => {
            capturedClassification = c;
          }
        }
      )
    ).rejects.toThrow(/AUTHENTICATION/);

    // Only attempted primary model, stopped immediately without burning calls on fallback models
    expect(executedModels).toEqual(["gemini-3.8-flash"]);
    expect(capturedClassification).not.toBeNull();
    expect(capturedClassification.isAuthError).toBe(true);
  });

  it("NO fallback on SAFETY violation", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];

    await expect(
      GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          executedModels.push(model);
          const err: any = new Error("Response was blocked due to SAFETY policy violation");
          throw err;
        }
      )
    ).rejects.toThrow(/SAFETY/);

    // Stops immediately without falling back
    expect(executedModels).toEqual(["gemini-3.8-flash"]);
  });

  it("NO fallback on 400 / Invalid Argument (Schema Violation)", async () => {
    const executedModels: string[] = [];
    const models = ["gemini-3.8-flash", "gemini-3.6-flash"];

    await expect(
      GeminiModelStrategy.executeWithFallback(
        models,
        async (model) => {
          executedModels.push(model);
          const err: any = new Error("INVALID_ARGUMENT: Schema constraint failure");
          err.status = 400;
          throw err;
        }
      )
    ).rejects.toThrow(/INVALID_REQUEST/);

    expect(executedModels).toEqual(["gemini-3.8-flash"]);
  });
});

describe("Requirement 18: Security & Key Management", () => {
  it("Key masking function masks secret appropriately", () => {
    const sampleKey = "AIzaSyD1234567890abcdefghijklmnopqrstuvw";
    const masked = EncryptionService.maskApiKey(sampleKey);
    expect(masked).toBe("AIza••••••••••tuvw");
    expect(masked).not.toContain("1234567890");
    expect(EncryptionService.maskApiKey(null)).toBe("Chưa cấu hình");
    expect(EncryptionService.maskApiKey("short")).toBe("••••••••");
  });

  it("EncryptionService encrypts with AES-256-GCM and decrypts accurately", () => {
    const rawSecret = "AIzaSyTestKey_SecretValue_12345";
    const encrypted = EncryptionService.encrypt(rawSecret);

    expect(encrypted.encryptedValue).not.toBe(rawSecret);
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();

    const decrypted = EncryptionService.decrypt(encrypted);
    expect(decrypted).toBe(rawSecret);
  });

  it("Encrypted key resolution prioritizes DB over ENV", async () => {
    SystemSecretService.invalidateCache();

    // 1. If DB secret is stored, it resolves from ENCRYPTED_DB
    const testKey = "AIzaSyDBTestKey999999999999999999999";
    await SystemSecretService.setSecret("GEMINI_API_KEY", testKey, "TEST_ADMIN");

    const resolved = await SystemSecretService.resolveGeminiApiKey();
    expect(resolved.source).toBe("ENCRYPTED_DB");
    expect(resolved.key).toBe(testKey);

    // 2. Deleting DB secret falls back to ENV or NONE
    await SystemSecretService.deleteSecret("GEMINI_API_KEY");
    SystemSecretService.invalidateCache();

    const resolvedAfterDelete = await SystemSecretService.resolveGeminiApiKey();
    if (env.GEMINI_API_KEY) {
      expect(resolvedAfterDelete.source).toBe("ENV");
      expect(resolvedAfterDelete.key).toBe(env.GEMINI_API_KEY);
    } else {
      expect(resolvedAfterDelete.source).toBe("NONE");
    }
  });

  it("Sanitized error messages do not leak full API keys", () => {
    const secretKey = "AIzaSySecretLeak12345";
    const rawError = new Error(`Request to https://generativelanguage.googleapis.com failed with key=${secretKey}`);
    const classification = GeminiModelStrategy.classifyError(rawError);

    // Ensure classification message does not echo raw API key
    expect(classification.message).not.toContain(secretKey);
  });
});

describe("Requirement 18: HUMAN Conversation Mode Disables Automatic AI Reply", () => {
  it("Conversations in HUMAN mode are identified and flag mode correctly", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `test_tg_${Date.now()}`,
      username: "test_customer"
    });

    const conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("AUTO");

    // Switch to HUMAN mode via the controlled claim() API (ownership + audit)
    await ConversationService.claim(customer.id, "test_cskh_admin");
    const updatedConv = await ConversationService.getOrCreateConversation(customer.id);
    expect(updatedConv.mode).toBe("HUMAN");

    // When mode is HUMAN, customer-handler pauses AI reply and leaves interaction to CSKH staff
  });
});
