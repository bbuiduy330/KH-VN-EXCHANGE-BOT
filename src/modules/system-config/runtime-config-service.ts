import { prisma } from "../../database/client.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

/** Centralized quote validity duration (business rule: exactly 10 minutes). */
export const QUOTE_VALIDITY_MINUTES = 10;

export interface BusinessConfig {
  geminiTextModel: string;
  geminiTranscribeModel: string;
  adminNotificationChatId: string;
  backupEnabled: boolean;
  backupScheduleHours: number;
  defaultServiceFeeUsd: number;
  largeTransactionThresholdUsd: number;
  quoteExpiryMinutes: number;
  paymentWaitAlertMinutes: number;
  updatedAt: string;
  updatedBy: string;
}

export class RuntimeConfigService {
  private static cache: Map<string, any> = new Map();
  private static isInitialized = false;

  private static readonly DEFAULTS: Record<string, any> = {
    geminiTextModel: env.GEMINI_PRIMARY_MODEL || "gemini-3.8-flash",
    geminiTranscribeModel: env.GEMINI_PRIMARY_MODEL || "gemini-3.8-flash",
    adminNotificationChatId: env.ADMIN_NOTIFICATION_CHAT_ID || env.SUPER_ADMIN_TELEGRAM_ID || "",
    backupEnabled: env.BACKUP_ENABLED ?? false,
    backupScheduleHours: 6,
    defaultServiceFeeUsd: env.DEFAULT_SERVICE_FEE_USD || 2,
    largeTransactionThresholdUsd: env.LARGE_TRANSACTION_THRESHOLD_USD || 5000,
    quoteExpiryMinutes: env.QUOTE_EXPIRY_MINUTES || QUOTE_VALIDITY_MINUTES,
    paymentWaitAlertMinutes: env.PAYMENT_WAIT_ALERT_MINUTES || 30
  };

  /**
   * Initializes the in-memory cache from PostgreSQL system_settings table.
   */
  static async init(): Promise<void> {
    try {
      const records = await prisma.systemSetting.findMany();
      this.cache.clear();

      // Seed defaults first
      for (const [key, value] of Object.entries(this.DEFAULTS)) {
        this.cache.set(key, value);
      }

      // Override with DB values
      for (const r of records) {
        this.cache.set(r.key, r.value);
      }

      this.isInitialized = true;
      logger.info({ settingsCount: records.length }, "Initialized RuntimeConfigService from PostgreSQL database");
    } catch (err: any) {
      logger.warn({ error: err?.message }, "Failed to load SystemSetting from database, using application defaults");
      // Populate defaults in memory anyway
      for (const [key, value] of Object.entries(this.DEFAULTS)) {
        this.cache.set(key, value);
      }
      this.isInitialized = true;
    }
  }

  static get<T>(key: string, fallback?: T): T {
    if (!this.isInitialized) {
      // Return default synchronously if not yet initialized
      return this.DEFAULTS[key] ?? fallback;
    }
    const val = this.cache.get(key);
    if (val !== undefined && val !== null) {
      return val as T;
    }
    return (this.DEFAULTS[key] ?? fallback) as T;
  }

  static async set<T>(key: string, value: T, updatedBy: string = "ADMIN"): Promise<void> {
    // 1. Update cache immediately
    this.cache.set(key, value);

    // 2. Persist to PostgreSQL SystemSetting table
    try {
      await prisma.systemSetting.upsert({
        where: { key },
        update: {
          value: value as any,
          updatedBy,
          updatedAt: new Date()
        },
        create: {
          key,
          value: value as any,
          updatedBy
        }
      });
      logger.info({ key, updatedBy }, "Updated system runtime setting in database");
    } catch (err: any) {
      logger.error({ error: err?.message, key }, "Failed to persist SystemSetting to database");
    }
  }

  // Domain accessors:
  static getGeminiTextModel(): string {
    return this.get<string>("geminiTextModel", env.GEMINI_PRIMARY_MODEL || "gemini-3.8-flash");
  }

  static setGeminiTextModel(model: string, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<string>("geminiTextModel", model, updatedBy);
  }

  static getGeminiTranscribeModel(): string {
    return this.get<string>("geminiTranscribeModel", env.GEMINI_PRIMARY_MODEL || "gemini-3.8-flash");
  }

  static getAdminNotificationChatId(): string {
    return this.get<string>("adminNotificationChatId", env.ADMIN_NOTIFICATION_CHAT_ID || env.SUPER_ADMIN_TELEGRAM_ID || "");
  }

  static setAdminNotificationChatId(chatId: string, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<string>("adminNotificationChatId", chatId, updatedBy);
  }

  static isBackupEnabled(): boolean {
    return this.get<boolean>("backupEnabled", false);
  }

  static setBackupEnabled(enabled: boolean, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<boolean>("backupEnabled", enabled, updatedBy);
  }

  static getBackupScheduleHours(): number {
    return this.get<number>("backupScheduleHours", 6);
  }

  static setBackupScheduleHours(hours: number, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<number>("backupScheduleHours", hours, updatedBy);
  }

  static getDefaultServiceFeeUsd(): number {
    return this.get<number>("defaultServiceFeeUsd", 2);
  }

  static setDefaultServiceFeeUsd(fee: number, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<number>("defaultServiceFeeUsd", fee, updatedBy);
  }

  static getLargeTransactionThresholdUsd(): number {
    return this.get<number>("largeTransactionThresholdUsd", 5000);
  }

  static setLargeTransactionThresholdUsd(threshold: number, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<number>("largeTransactionThresholdUsd", threshold, updatedBy);
  }

  static getQuoteExpiryMinutes(): number {
    // Business rule: customer quotes are ALWAYS exactly 10 minutes.
    // Not configurable via env or system_settings (prevents stale 15-minute
    // overrides from silently applying in production).
    return QUOTE_VALIDITY_MINUTES;
  }

  static setQuoteExpiryMinutes(minutes: number, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<number>("quoteExpiryMinutes", minutes, updatedBy);
  }

  static getPaymentWaitAlertMinutes(): number {
    return this.get<number>("paymentWaitAlertMinutes", 30);
  }

  static setPaymentWaitAlertMinutes(minutes: number, updatedBy: string = "ADMIN"): Promise<void> {
    return this.set<number>("paymentWaitAlertMinutes", minutes, updatedBy);
  }

  static getConfig(): BusinessConfig {
    return {
      geminiTextModel: this.getGeminiTextModel(),
      geminiTranscribeModel: this.getGeminiTranscribeModel(),
      adminNotificationChatId: this.getAdminNotificationChatId(),
      backupEnabled: this.isBackupEnabled(),
      backupScheduleHours: this.getBackupScheduleHours(),
      defaultServiceFeeUsd: this.getDefaultServiceFeeUsd(),
      largeTransactionThresholdUsd: this.getLargeTransactionThresholdUsd(),
      quoteExpiryMinutes: this.getQuoteExpiryMinutes(),
      paymentWaitAlertMinutes: this.getPaymentWaitAlertMinutes(),
      updatedAt: new Date().toISOString(),
      updatedBy: "SYSTEM"
    };
  }

  static async updateConfig(partial: Partial<BusinessConfig>, updatedBy: string = "ADMIN"): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [k, v] of Object.entries(partial)) {
      if (v !== undefined && k !== "updatedAt" && k !== "updatedBy") {
        promises.push(this.set(k, v, updatedBy));
      }
    }
    await Promise.all(promises);
  }
}
