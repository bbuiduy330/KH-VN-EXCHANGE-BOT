import crypto from "node:crypto";
import fs from "node:fs";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

export interface EncryptedPayload {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

export class EncryptionService {
  private static cachedKey: Buffer | null = null;

  /**
   * Resolves the master encryption key from:
   * 1. Docker secret: /run/secrets/config-master.key
   * 2. Host secret: /opt/khvn/secrets/config-master.key
   * 3. Environment variable: CONFIG_ENCRYPTION_KEY (development only)
   *
   * In production (NODE_ENV=production):
   * NEVER accept a built-in fallback.
   * If no valid key exists, log a sanitized fatal configuration error and throw.
   */
  private static getDerivedKey(): Buffer {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    let rawKey: string | null = null;
    let source: string = "NONE";

    // 1. Check Docker secret file
    const dockerSecretPath = "/run/secrets/config-master.key";
    if (fs.existsSync(dockerSecretPath)) {
      try {
        rawKey = fs.readFileSync(dockerSecretPath, "utf8").trim();
        source = "DOCKER_SECRET";
      } catch (err: any) {
        logger.warn({ error: err?.message }, "Failed to read Docker master key secret file");
      }
    }

    // 2. Check Host secret file if not found yet
    if (!rawKey) {
      const hostSecretPath = "/opt/khvn/secrets/config-master.key";
      if (fs.existsSync(hostSecretPath)) {
        try {
          rawKey = fs.readFileSync(hostSecretPath, "utf8").trim();
          source = "HOST_SECRET";
        } catch (err: any) {
          logger.warn({ error: err?.message }, "Failed to read Host master key secret file");
        }
      }
    }

    // 3. Check environment variable
    if (!rawKey && (env.CONFIG_ENCRYPTION_KEY || process.env.CONFIG_ENCRYPTION_KEY)) {
      rawKey = (env.CONFIG_ENCRYPTION_KEY || process.env.CONFIG_ENCRYPTION_KEY || "").trim();
      source = "ENV";
    }

    const isProduction = (env.NODE_ENV || process.env.NODE_ENV || "development").toLowerCase() === "production";

    // Production security constraint:
    if (isProduction) {
      if (!rawKey || rawKey.length < 16) {
        logger.fatal(
          { source, keyLength: rawKey?.length || 0 },
          "[SECURITY FATAL] Master encryption key is missing or invalid in production! In production, /run/secrets/config-master.key or CONFIG_ENCRYPTION_KEY must be provided. SystemSecret encryption refused."
        );
        throw new Error(
          "FATAL CONFIGURATION ERROR: Master encryption key not found in production. Application cannot start with an insecure fallback key."
        );
      }
    } else {
      // Local development or unit test fallback check
      if (!rawKey) {
        // In local development, if no key was passed at all, raise clear error unless in test mode
        if (process.env.NODE_ENV === "test") {
          rawKey = "test-only-development-encryption-key-32b";
          source = "TEST_DEV";
        } else {
          logger.warn(
            "[SECURITY] No CONFIG_ENCRYPTION_KEY provided in development. Using temporary dev session key."
          );
          rawKey = "local-dev-transient-key-not-for-prod-32b";
          source = "DEV_TRANSIENT";
        }
      }
    }

    this.cachedKey = crypto.createHash("sha256").update(rawKey).digest();
    return this.cachedKey;
  }

  static isConfigured(): boolean {
    try {
      this.getDerivedKey();
      return true;
    } catch {
      return false;
    }
  }

  static clearKeyCache(): void {
    this.cachedKey = null;
  }

  static encrypt(plaintext: string): EncryptedPayload {
    if (!plaintext) {
      throw new Error("Cannot encrypt empty plaintext");
    }
    const key = this.getDerivedKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
      encryptedValue: encrypted.toString("hex"),
      iv: iv.toString("hex"),
      authTag: authTag.toString("hex")
    };
  }

  static decrypt(payload: EncryptedPayload): string {
    if (!payload.encryptedValue || !payload.iv || !payload.authTag) {
      throw new Error("Invalid encrypted payload components");
    }
    const key = this.getDerivedKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedValue, "hex")),
      decipher.final()
    ]);

    return decrypted.toString("utf8");
  }

  static maskApiKey(key?: string | null): string {
    if (!key) return "Chưa cấu hình";
    const trimmed = key.trim();
    if (trimmed.length < 8) return "••••••••";
    const prefix = trimmed.slice(0, 4);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••••••••${suffix}`;
  }
}
