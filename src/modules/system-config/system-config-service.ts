import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

export interface SystemConfigData {
  geminiApiKey: string;
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

export class SystemConfigService {
  private static configFilePath: string = "";
  private static currentConfig: SystemConfigData = {
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiTextModel: env.GEMINI_TEXT_MODEL || "gemini-3.6-flash",
    geminiTranscribeModel: env.GEMINI_TRANSCRIBE_MODEL || "gemini-3.6-flash",
    adminNotificationChatId: env.ADMIN_NOTIFICATION_CHAT_ID || env.SUPER_ADMIN_TELEGRAM_ID || "",
    backupEnabled: env.BACKUP_ENABLED ?? true,
    backupScheduleHours: 6,
    defaultServiceFeeUsd: env.DEFAULT_SERVICE_FEE_USD || 2,
    largeTransactionThresholdUsd: env.LARGE_TRANSACTION_THRESHOLD_USD || 5000,
    quoteExpiryMinutes: env.QUOTE_EXPIRY_MINUTES || 15,
    paymentWaitAlertMinutes: env.PAYMENT_WAIT_ALERT_MINUTES || 30,
    updatedAt: new Date().toISOString(),
    updatedBy: "SYSTEM_INIT"
  };

  private static isInitialized = false;

  static init(storageRoot?: string): SystemConfigData {
    const root = storageRoot || env.STORAGE_ROOT || "./data/KH-VN-EXCHANGE";
    this.configFilePath = path.join(root, "system_config.json");

    try {
      if (!fs.existsSync(root)) {
        fs.mkdirSync(root, { recursive: true });
      }

      if (fs.existsSync(this.configFilePath)) {
        const fileContent = fs.readFileSync(this.configFilePath, "utf8");
        const parsed = JSON.parse(fileContent);
        this.currentConfig = {
          ...this.currentConfig,
          ...parsed
        };
        logger.info({ configFilePath: this.configFilePath }, "Loaded dynamic system configuration from storage");
      } else {
        // Save initial config
        this.saveToFile();
        logger.info({ configFilePath: this.configFilePath }, "Created initial dynamic system configuration file");
      }
    } catch (err) {
      logger.warn({ err }, "Could not load system_config.json, using environment defaults");
    }

    // Default admin notification to super admin if empty
    if (!this.currentConfig.adminNotificationChatId && env.SUPER_ADMIN_TELEGRAM_ID) {
      this.currentConfig.adminNotificationChatId = env.SUPER_ADMIN_TELEGRAM_ID;
    }

    this.isInitialized = true;
    return this.currentConfig;
  }

  private static saveToFile() {
    try {
      const dir = path.dirname(this.configFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configFilePath, JSON.stringify(this.currentConfig, null, 2), "utf8");
    } catch (err) {
      logger.error({ err }, "Failed to write system_config.json");
    }
  }

  static getConfig(): SystemConfigData {
    if (!this.isInitialized) {
      this.init();
    }
    return { ...this.currentConfig };
  }

  static updateConfig(partial: Partial<SystemConfigData>, updatedBy: string = "ADMIN"): SystemConfigData {
    if (!this.isInitialized) {
      this.init();
    }

    this.currentConfig = {
      ...this.currentConfig,
      ...partial,
      updatedAt: new Date().toISOString(),
      updatedBy
    };

    this.saveToFile();
    logger.info({ updatedBy, partialKeys: Object.keys(partial) }, "Dynamic system configuration updated");
    return { ...this.currentConfig };
  }

  // Convenience getters
  static getGeminiApiKey(): string {
    return this.getConfig().geminiApiKey || env.GEMINI_API_KEY || "";
  }

  static getGeminiTextModel(): string {
    return this.getConfig().geminiTextModel || env.GEMINI_TEXT_MODEL || "gemini-3.6-flash";
  }

  static getAdminNotificationChatId(): string {
    return (
      this.getConfig().adminNotificationChatId ||
      env.ADMIN_NOTIFICATION_CHAT_ID ||
      env.SUPER_ADMIN_TELEGRAM_ID ||
      ""
    );
  }

  static isBackupEnabled(): boolean {
    return this.getConfig().backupEnabled;
  }

  static getBackupScheduleHours(): number {
    return this.getConfig().backupScheduleHours;
  }

  static getDefaultFee(): number {
    return this.getConfig().defaultServiceFeeUsd;
  }

  static getLargeThreshold(): number {
    return this.getConfig().largeTransactionThresholdUsd;
  }

  static getQuoteExpiry(): number {
    return this.getConfig().quoteExpiryMinutes;
  }
}
