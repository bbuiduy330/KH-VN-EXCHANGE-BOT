import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { SystemConfigService } from "../modules/system-config/system-config-service.js";
import { prisma } from "../database/client.js";
import { PermissionService } from "../modules/permissions/permission-service.js";


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
): Promise<{ message_id: number } | null> {
  if (!botInstance) {
    logger.warn({ customerTelegramId }, "Cannot send message to customer: bot instance is not initialized");
    return null;
  }
  const tid = String(customerTelegramId).trim();
  if (!tid) return null;

  try {
    const sent = await botInstance.api.sendMessage(tid, text, options);
    return sent;
  } catch (err: any) {
    logger.warn({ err: err?.message, customerTelegramId: tid }, "Failed to send message to customer");
    return null;
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

/**
 * Telegram-native media copy (no download/re-upload).
 * Used for HUMAN support media relay in both directions.
 * Preserves captions when the original message had one.
 */
export async function copyMessageToChat(
  fromChatId: string | number,
  messageId: number,
  toChatId: string | number
): Promise<number | null> {
  if (!botInstance) {
    logger.warn({ fromChatId, toChatId, messageId }, "copyMessageToChat: bot instance not initialized");
    return null;
  }
  const from = String(fromChatId).trim();
  const to = String(toChatId).trim();
  if (!from || !to || !messageId) return null;

  try {
    const copied = await botInstance.api.copyMessage(to, from, messageId);
    return copied.message_id;
  } catch (err: any) {
    logger.warn(
      { err: err?.message, fromChatId: from, toChatId: to, messageId },
      "copyMessageToChat failed"
    );
    return null;
  }
}

export async function copyMessageToStaff(
  staffTelegramId: string,
  fromChatId: string | number,
  messageId: number
): Promise<number | null> {
  return copyMessageToChat(fromChatId, messageId, staffTelegramId);
}

export async function copyMessageToCustomer(
  customerTelegramId: string,
  fromChatId: string | number,
  messageId: number
): Promise<number | null> {
  return copyMessageToChat(fromChatId, messageId, customerTelegramId);
}

/**
 * C3 — direct DM to eligible active staff (conversation.claim permission).
 * Used for HUMAN support requests. Forbidden/403 (staff never started the bot)
 * is caught silently so it never breaks the customer's support request.
 * Never exposes token/error internals.
 */
export async function notifyEligibleStaff(
  text: string,
  options: { parse_mode?: "HTML" | "MarkdownV2"; reply_markup?: any } = { parse_mode: "HTML" }
): Promise<void> {
  if (!botInstance) return;

  let staff: any[] = [];
  try {
    staff = await prisma.staffUser.findMany({ where: { status: "ACTIVE" } });
  } catch (err: any) {
    logger.warn({ err: err?.message }, "notifyEligibleStaff: failed to list staff");
    return;
  }

  for (const s of staff) {
    try {
      const eligible = await PermissionService.hasPermission(s.telegramId, "conversation.claim");
      if (!eligible) continue;
      await botInstance.api.sendMessage(s.telegramId, text, options);
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("403") || msg.includes("Forbidden")) {
        logger.info({ staffTelegramId: s.telegramId }, "notifyEligibleStaff: skip (403/forbidden)");
      } else {
        logger.warn({ err: msg, staffTelegramId: s.telegramId }, "notifyEligibleStaff: send failed");
      }
    }
  }
}

