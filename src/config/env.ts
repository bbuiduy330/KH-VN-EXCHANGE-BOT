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
  GEMINI_API_KEY: z.string().optional().default(""),
  GEMINI_TEXT_MODEL: z.string().default("gemini-2.5-flash"),
  GEMINI_TRANSCRIBE_MODEL: z.string().default("gemini-2.5-flash"),
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional().default(""),
  GOOGLE_DRIVE_REFRESH_TOKEN: z.string().optional().default(""),
  GOOGLE_DRIVE_ROOT_FOLDER_ID: z.string().optional().default(""),
  GOOGLE_DRIVE_MOCK: z
    .preprocess((val) => val === "true" || val === true, z.boolean())
    .default(false),
  DEFAULT_SERVICE_FEE_USD: z.coerce.number().default(2),
  LARGE_TRANSACTION_THRESHOLD_USD: z.coerce.number().default(5000),
  QUOTE_EXPIRY_MINUTES: z.coerce.number().default(15),
  PAYMENT_WAIT_ALERT_MINUTES: z.coerce.number().default(30),
  MAX_UPLOAD_MB: z.coerce.number().default(20),
  LOG_LEVEL: z.string().default("info"),
  TIMEZONE: z.string().default("Asia/Ho_Chi_Minh")
});

export const env = envSchema.parse(process.env);
