/**
 * CUSTOMER CLEAR CHAT — TELEGRAM MESSAGE CLEANUP ONLY.
 *
 * Purpose: give the customer a clean Telegram chat window WITHOUT touching any
 * authoritative business data.
 *
 * HARD GUARANTEES (must never be violated by this module):
 *  - NO Customer/Order/Quote/FileEvidence/AuditLog/commission/Message row is
 *    deleted or modified — the ONLY backend operation is a READ of recorded
 *    telegramMessageId values for the customer's own conversation.
 *  - Only Telegram Bot API deletions are performed, on message ids the bot
 *    itself captured (`Message.telegramMessageId`).
 *  - Telegram limits apply: Bot API can only delete recent messages (≤48h)
 *    and messages the bot sent (or received in private chats). Failures for
 *    old/unavailable messages are counted — never thrown at the customer.
 *  - Batching: deleteMessages accepts max 100 ids per call; the service
 *    chunks accordingly and falls back to per-message deletions when a batch
 *    fails so a single unavailable message never blocks the rest.
 *
 * This is NOT GDPR erasure / account deletion / DB purge of any kind.
 */
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";
import { getBotInstance } from "../../bot/notifications.js";
import { ConversationService } from "../conversation/conversation-service.js";

const TELEGRAM_BATCH_LIMIT = 100;
const MAX_TRACKED_MESSAGES = 500;

export interface ClearChatResult {
  /** Telegram message ids the bot had recorded for this private chat. */
  requested: number;
  /** Messages successfully deleted via the Telegram API. */
  deleted: number;
  /** Messages Telegram refused to delete (too old / not found / no rights). */
  failed: number;
}

function chunkIds(ids: number[], size = TELEGRAM_BATCH_LIMIT): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/**
 * Collect the KNOWN Telegram message ids for this customer's conversation and
 * delete them from the customer's private chat in ≤100-id batches.
 * READ-ONLY on the backend: a single SELECT on Message.telegramMessageId.
 */
export async function clearCustomerTelegramChat(customerId: string): Promise<ClearChatResult> {
  const result: ClearChatResult = { requested: 0, deleted: 0, failed: 0 };

  const bot = getBotInstance();
  if (!bot) {
    logger.warn("Clear chat: bot instance not initialized — nothing deleted");
    return result;
  }

  // READ-ONLY backend access: only recorded telegram ids are read.
  const conv = await ConversationService.getOrCreateConversation(customerId);
  const rows = await prisma.message.findMany({
    where: { conversationId: conv.id, telegramMessageId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: MAX_TRACKED_MESSAGES,
    select: { telegramMessageId: true }
  });
  // Type-safe collection: Prisma Message.telegramMessageId is Int? (number |
  // null) and the Bot API expects numeric ids — only well-formed integers may
  // enter the deletion list (null/undefined/invalid are excluded).
  const messageIds: number[] = rows
    .map((row) => row.telegramMessageId)
    .filter(
      (id): id is number =>
        typeof id === "number" &&
        Number.isInteger(id)
    );
  const ids = [...new Set<number>(messageIds)];
  result.requested = ids.length;
  if (ids.length === 0) return result;

  const chatId = String(customerId);
  for (const chunk of chunkIds(ids)) {
    try {
      // Batch delete (≤100 ids per request, per Bot API limits).
      await bot.api.deleteMessages(chatId, chunk);
      result.deleted += chunk.length;
    } catch {
      // Batch refused (some ids too old / not found) — fall back to
      // per-message deletions so one unavailable id never blocks the rest.
      for (const id of chunk) {
        try {
          await bot.api.deleteMessage(chatId, id);
          result.deleted++;
        } catch {
          // Old (>48h) / already-gone messages: counted, never propagated.
          result.failed++;
        }
      }
    }
  }
  logger.info({ requested: result.requested, deleted: result.deleted, failed: result.failed }, "Clear chat: Telegram cleanup finished");
  return result;
}
