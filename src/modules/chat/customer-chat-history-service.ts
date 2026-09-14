/**
 * DURABLE CUSTOMER CHAT TRANSCRIPT — ONE central service (Part 2).
 *
 * Operational transcript of CUSTOMER-FACING content only:
 *   INBOUND : customer text / photo / document / voice / video / sticker.
 *   OUTBOUND: bot replies and Admin/CSKH replies actually DELIVERED.
 * Callback presses, typing indicators, internal Admin notifications, scheduler
 * diagnostics and menu navigation are NEVER recorded (Audit ≠ Transcript).
 *
 * IDENTITY: internal Customer.id internally; Telegram numeric ID is the
 * authoritative Telegram identity; username NEVER used.
 * DEDUPE: authoritative Telegram identifiers (telegramChatId, telegramMessageId,
 * direction) — two later messages with identical text are DIFFERENT messages.
 * Storage failure NEVER blocks a critical customer-facing send (fire-safe).
 */
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export type ChatDirection = "INBOUND" | "OUTBOUND";
export type ChatSenderType = "CUSTOMER" | "BOT" | "STAFF" | "SYSTEM";
export type ChatContentType = "TEXT" | "PHOTO" | "DOCUMENT" | "VOICE" | "VIDEO" | "STICKER" | "OTHER";

export const CHAT_HISTORY_PAGE_SIZE = 25;
export const CHAT_HISTORY_FETCH_TAKE = CHAT_HISTORY_PAGE_SIZE + 1;

export interface ChatRecordInput {
  customerId: string;
  telegramChatId: string;
  telegramMessageId?: string | number | null;
  conversationId?: string | null;
  direction: ChatDirection;
  senderType: ChatSenderType;
  staffTelegramId?: string | null;
  contentType?: ChatContentType;
  text?: string | null;
  caption?: string | null;
  telegramFileId?: string | null;
}

function encodeChatCursor(row: { createdAt: Date | string; id: string }): string {
  const iso = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
  return Buffer.from(`${iso}|${row.id}`, "utf8").toString("base64url");
}

function decodeChatCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const sep = decoded.indexOf("|");
    if (sep <= 0) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export class CustomerChatHistoryService {
  /**
   * Record ONE transcript row. Inbound Telegram retries are deduplicated by
   * the (telegramChatId, telegramMessageId, direction) unique key — identical
   * text sent later has a DIFFERENT telegramMessageId and is a NEW message.
   * Never throws to the caller (transcript failure must not break chat).
   */
  static async record(input: ChatRecordInput): Promise<void> {
    try {
      const messageId = input.telegramMessageId == null ? null : String(input.telegramMessageId);
      await prisma.customerChatMessage.create({
        data: {
          customerId: input.customerId,
          telegramChatId: String(input.telegramChatId || "").trim(),
          telegramMessageId: messageId,
          conversationId: input.conversationId ?? null,
          direction: input.direction,
          senderType: input.senderType,
          staffTelegramId: input.staffTelegramId ?? null,
          contentType: input.contentType || "TEXT",
          text: input.text ?? null,
          caption: input.caption ?? null,
          telegramFileId: input.telegramFileId ?? null
        }
      });
      // Inbound customer content = TRUE customer activity (never Admin views).
      if (input.direction === "INBOUND") {
        await this.touchCustomerActivity(input.customerId);
      }
    } catch (err: any) {
      // Telegram retry of the same inbound message → unique hit → safe skip.
      if (String(err?.message || "").includes("Unique constraint")) return;
      logger.warn({ err: err?.message, customerId: input.customerId }, "Chat transcript record failed (non-fatal)");
    }
  }

  /** TRUE last customer activity — NEVER called for Admin views/audits/jobs. */
  static async touchCustomerActivity(customerId: string): Promise<void> {
    try {
      await prisma.customer.update({ where: { id: customerId }, data: { lastActivityAt: new Date() } });
    } catch (err: any) {
      logger.warn({ err: err?.message, customerId }, "lastActivityAt update failed (non-fatal)");
    }
  }

  /** Inbound customer message (text or media) — idempotent on Telegram ids. */
  static async recordInbound(input: Omit<ChatRecordInput, "direction" | "senderType">): Promise<void> {
    await this.record({ ...input, direction: "INBOUND", senderType: "CUSTOMER" });
  }

  /** Bot/system outbound — record ONLY after successful Telegram delivery. */
  static async recordBotOutbound(input: Omit<ChatRecordInput, "direction" | "senderType">): Promise<void> {
    await this.record({ ...input, direction: "OUTBOUND", senderType: "BOT" });
  }

  /** Staff (Admin/CSKH) outbound — record ONLY after delivery succeeds. */
  static async recordStaffOutbound(input: Omit<ChatRecordInput, "direction" | "senderType"> & { staffTelegramId: string }): Promise<void> {
    await this.record({ ...input, direction: "OUTBOUND", senderType: "STAFF" });
  }

  /**
   * Keyset page (createdAt DESC, id DESC), 25 + 1 sentinel — the extra row
   * only decides "has older". No OFFSET, no COUNT.
   */
  static async listPage(customerId: string, cursorRaw: string | null): Promise<{
    messages: any[];
    hasOlder: boolean;
    nextCursor: string | null;
  }> {
    const where: any = { customerId };
    if (cursorRaw) {
      const c = decodeChatCursor(cursorRaw);
      if (c) {
        where.AND = [
          {
            OR: [
              { createdAt: { lt: c.createdAt } },
              { createdAt: c.createdAt, id: { lt: c.id } }
            ]
          }
        ];
      }
    }
    const rows: any[] = await prisma.customerChatMessage.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CHAT_HISTORY_FETCH_TAKE
    });
    const hasOlder = rows.length > CHAT_HISTORY_PAGE_SIZE;
    const page = rows.slice(0, CHAT_HISTORY_PAGE_SIZE);
    return {
      messages: page,
      hasOlder,
      nextCursor: hasOlder && page.length > 0 ? encodeChatCursor(page[page.length - 1]) : null
    };
  }
}
