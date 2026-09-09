import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().optional(),
  DATA_DIR: z.string().default("./data"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  SUPER_ADMIN_TELEGRAM_ID: z.string().optional().default(""),
  ADMIN_NOTIFICATION_CHAT_ID: z.string().optional().default(""),
  // Master encryption key for SystemSecret encryption.
  // Required in production — the EncryptionService enforces this at runtime
  // (env var or Docker secret /run/secrets/config-master.key, min 16 chars).
  CONFIG_ENCRYPTION_KEY: z.string().optional().default(""),
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_PRIMARY_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_FALLBACK_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_LITE_MODEL: z.string().default("gemini-3.5-flash-lite"),
  GEMINI_TEXT_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_TRANSCRIBE_MODEL: z.string().default("gemini-3.8-flash"),
  ENABLE_GEMINI_DIAGNOSTIC_ENDPOINT: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
  DIAGNOSTIC_TOKEN: z.string().optional().default(""),
  STORAGE_ROOT: z.string().default(process.env.STORAGE_ROOT || process.env.DATA_DIR || "./data/KH-VN-EXCHANGE"),
  BACKUP_ENABLED: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
  RESTIC_REPOSITORY: z.string().optional().default(""),
  RESTIC_PASSWORD_FILE: z.string().optional().default(""),
  BACKUP_SCHEDULE: z.string().default("0 */6 * * *"),
  DEFAULT_SERVICE_FEE_USD: z.coerce.number().default(2),
  LARGE_TRANSACTION_THRESHOLD_USD: z.coerce.number().default(5000),
  QUOTE_EXPIRY_MINUTES: z.coerce.number().default(15),
  PAYMENT_WAIT_ALERT_MINUTES: z.coerce.number().default(30),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  LOG_LEVEL: z.string().default("info"),
  TIMEZONE: z.string().default("Asia/Ho_Chi_Minh")
});

export const env = envSchema.parse(process.env);
