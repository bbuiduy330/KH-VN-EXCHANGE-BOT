import { prisma } from "../../database/client.js";
import { env } from "../../config/env.js";
import { EncryptionService } from "../security/encryption-service.js";
import { logger } from "../../shared/logger.js";
import { AuditService } from "../audit/audit-service.js";

export class SystemSecretService {
  private static cachedSecrets = new Map<string, string>();
  private static cachedResolution: { key: string | null; source: "ENCRYPTED_DB" | "ENV" | "NONE" } | null = null;

  static invalidateCache(): void {
    this.cachedSecrets.clear();
    this.cachedResolution = null;
    logger.info("SystemSecretService cache invalidated");
  }

  static async getSecret(secretKey: string): Promise<string | null> {
    if (this.cachedSecrets.has(secretKey)) {
      return this.cachedSecrets.get(secretKey) || null;
    }

    try {
      const record = await prisma.systemSecret.findUnique({
        where: { key: secretKey }
      });

      if (!record) return null;

      const decrypted = EncryptionService.decrypt({
        encryptedValue: record.encryptedValue,
        iv: record.iv,
        authTag: record.authTag
      });

      this.cachedSecrets.set(secretKey, decrypted);
      return decrypted;
    } catch (err: any) {
      logger.error({ err: err.message, secretKey }, "Failed to retrieve/decrypt system secret");
      return null;
    }
  }

  static async setSecret(secretKey: string, plaintext: string, updatedBy: string = "ADMIN"): Promise<void> {
    if (!plaintext || !plaintext.trim()) {
      throw new Error("Secret value cannot be empty");
    }

    const encrypted = EncryptionService.encrypt(plaintext.trim());

    await prisma.systemSecret.upsert({
      where: { key: secretKey },
      update: {
        encryptedValue: encrypted.encryptedValue,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        updatedBy,
        updatedAt: new Date()
      },
      create: {
        key: secretKey,
        encryptedValue: encrypted.encryptedValue,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        updatedBy
      }
    });

    this.invalidateCache();

    // Audit rotation safely without exposing plaintext key (Requirement 8)
    if (secretKey === "GEMINI_API_KEY") {
      await AuditService.log({
        actorId: updatedBy,
        actorRole: "SUPER_ADMIN",
        action: "gemini.key.updated",
        targetType: "SYSTEM_SECRET",
        targetId: secretKey,
        details: {
          event: "gemini.key.updated",
          timestamp: new Date().toISOString()
        }
      });
    }

    logger.info({ secretKey, updatedBy }, "System secret securely encrypted and updated in storage");
  }

  static async deleteSecret(secretKey: string): Promise<boolean> {
    try {
      await prisma.systemSecret.delete({
        where: { key: secretKey }
      });
      this.invalidateCache();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolves Gemini API key with priority:
   * 1. Encrypted runtime Admin-configured API key
   * 2. GEMINI_API_KEY environment variable
   * 3. None configured
   */
  static async resolveGeminiApiKey(): Promise<{ key: string | null; source: "ENCRYPTED_DB" | "ENV" | "NONE" }> {
    if (this.cachedResolution) {
      return this.cachedResolution;
    }

    // 1. Check encrypted runtime DB key
    const dbKey = await this.getSecret("GEMINI_API_KEY");
    if (dbKey && dbKey.trim().length > 0) {
      this.cachedResolution = { key: dbKey.trim(), source: "ENCRYPTED_DB" };
      return this.cachedResolution;
    }

    // 2. Check environment variable
    const envKey = env.GEMINI_API_KEY?.trim();
    if (envKey && envKey.length > 0) {
      this.cachedResolution = { key: envKey, source: "ENV" };
      return this.cachedResolution;
    }

    // 3. None configured
    this.cachedResolution = { key: null, source: "NONE" };
    return this.cachedResolution;
  }
}
