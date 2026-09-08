import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { SystemConfigService } from "../modules/system-config/system-config-service.js";

let botInstance: Bot<any> | null = null;

export function setBotInstance(bot: Bot<any> | null) {
  botInstance = bot;
}

export function getBotInstance(): Bot<any> | null {
  return botInstance;
}

export async function sendToCustomer(
  customerTelegramId: string,
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<boolean> {
  if (!botInstance) {
    logger.warn({ customerTelegramId }, "Cannot send message to customer: bot instance is not initialized");
    return false;
  }
  const tid = String(customerTelegramId).trim();
  if (!tid) return false;

  try {
    await botInstance.api.sendMessage(tid, text, options);
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, customerTelegramId: tid }, "Failed to send message to customer");
    return false;
  }
}

export async function sendToStaff(
  staffTelegramId: string,
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<boolean> {
  if (!botInstance) {
    logger.warn({ staffTelegramId }, "Cannot send message to staff: bot instance is not initialized");
    return false;
  }
  const tid = String(staffTelegramId).trim();
  if (!tid) return false;

  try {
    await botInstance.api.sendMessage(tid, text, options);
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, staffTelegramId: tid }, "Failed to send message to staff");
    return false;
  }
}

export async function sendToAdminNotificationChat(
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<boolean> {
  const chatId = SystemConfigService.getAdminNotificationChatId()?.trim();
  if (!chatId || !botInstance) {
    return false;
  }

  try {
    await botInstance.api.sendMessage(chatId, text, options);
    return true;
  } catch (err: any) {
    logger.warn({ err: err?.message, chatId }, "Failed to send to admin notification chat");
    return false;
  }
}
