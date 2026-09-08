import { RuntimeConfigService, BusinessConfig } from "./runtime-config-service.js";

export type SystemConfigData = BusinessConfig;

/**
 * SystemConfigService forwards directly to RuntimeConfigService (PostgreSQL SystemSetting table).
 * File-based system_config.json persistence has been completely removed.
 */
export class SystemConfigService {
  static async init(): Promise<void> {
    await RuntimeConfigService.init();
  }

  static getConfig(): BusinessConfig {
    return RuntimeConfigService.getConfig();
  }

  static async updateConfig(partial: Partial<BusinessConfig>, updatedBy: string = "ADMIN"): Promise<void> {
    await RuntimeConfigService.updateConfig(partial, updatedBy);
  }

  static getGeminiTextModel(): string {
    return RuntimeConfigService.getGeminiTextModel();
  }

  static getGeminiTranscribeModel(): string {
    return RuntimeConfigService.getGeminiTranscribeModel();
  }

  static getAdminNotificationChatId(): string {
    return RuntimeConfigService.getAdminNotificationChatId();
  }

  static isBackupEnabled(): boolean {
    return RuntimeConfigService.isBackupEnabled();
  }

  static getBackupScheduleHours(): number {
    return RuntimeConfigService.getBackupScheduleHours();
  }

  static getDefaultServiceFeeUsd(): number {
    return RuntimeConfigService.getDefaultServiceFeeUsd();
  }

  static getLargeTransactionThresholdUsd(): number {
    return RuntimeConfigService.getLargeTransactionThresholdUsd();
  }

  static getQuoteExpiryMinutes(): number {
    return RuntimeConfigService.getQuoteExpiryMinutes();
  }

  static getPaymentWaitAlertMinutes(): number {
    return RuntimeConfigService.getPaymentWaitAlertMinutes();
  }
}
