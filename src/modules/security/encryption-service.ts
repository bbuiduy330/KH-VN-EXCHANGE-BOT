import crypto from "node:crypto";
import { env } from "../../config/env.js";

export interface EncryptedPayload {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

export class EncryptionService {
  private static getDerivedKey(): Buffer {
    const rawKey = env.CONFIG_ENCRYPTION_KEY || "kh-vn-exchange-master-secret-key-32b!";
    return crypto.createHash("sha256").update(rawKey).digest();
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
