import { prisma } from "../../database/client.js";
import { AiProvider } from "../ai/ai-provider.js";
import { AuditService } from "../audit/audit-service.js";
import { logger } from "../../shared/logger.js";

export class ConversationService {
  static async getOrCreateConversation(customerId: string) {
    let conv = await prisma.conversation.findUnique({
      where: { customerId }
    });
    if (!conv) {
      conv = await prisma.conversation.create({
        data: { customerId, mode: "AUTO" }
      });
    }
    return conv;
  }

  /**
   * Atomic CSKH Claim:
   * Only succeeds if claimedById IS NULL.
   * Prevents race condition where two staff press claim at the same time.
   */
  static async claim(customerId: string, staffId: string, staffRole: string = "CSKH") {
    const conv = await this.getOrCreateConversation(customerId);

    return prisma.$transaction(async (tx: any) => {
      const result = await tx.conversation.updateMany({
        where: {
          id: conv.id,
          claimedById: null
        },
        data: {
          mode: "HUMAN",
          claimedById: staffId,
          claimedAt: new Date()
        }
      });

      if (result.count !== 1) {
        throw new Error("Cuộc trò chuyện đã được nhân viên khác tiếp nhận hoặc không khả dụng.");
      }

      await AuditService.log(
        {
          actorId: staffId,
          actorRole: staffRole,
          action: "CONVERSATION_CLAIMED",
          targetType: "CONVERSATION",
          targetId: conv.id,
          details: { customerId, staffId }
        },
        tx
      );

      return tx.conversation.findUnique({ where: { id: conv.id } });
    });
  }

  /**
   * Safe CSKH Release:
   * Normal CSKH can ONLY release a conversation that they currently own.
   * SUPER_ADMIN / ADMIN or staff with conversation.takeover can force release.
   */
  static async release(
    customerId: string,
    staffId: string,
    staffRole: string = "CSKH",
    permissions: string[] = []
  ) {
    const conv = await this.getOrCreateConversation(customerId);

    const isPrivileged =
      staffRole === "SUPER_ADMIN" ||
      staffRole === "ADMIN" ||
      permissions.includes("conversation.takeover");

    if (conv.claimedById && conv.claimedById !== staffId && !isPrivileged) {
      throw new Error("Bạn chỉ có thể kết thúc hoặc bàn giao cuộc trò chuyện do chính bạn tiếp nhận.");
    }

    return prisma.$transaction(async (tx: any) => {
      const updated = await tx.conversation.update({
        where: { id: conv.id },
        data: {
          mode: "AUTO",
          claimedById: null,
          claimedAt: null
        }
      });

      await AuditService.log(
        {
          actorId: staffId,
          actorRole: staffRole,
          action: "CONVERSATION_RELEASED",
          targetType: "CONVERSATION",
          targetId: conv.id,
          details: { customerId, previousOwner: conv.claimedById }
        },
        tx
      );

      return updated;
    });
  }

  /**
   * Customer-side exit from HUMAN support ("Quay lại đổi tiền" button).
   * Performs the SAME lifecycle transition as staff release() —
   * mode "AUTO" + claimedById null — no new database status.
   * Customers are always allowed to leave a support session themselves.
   * Idempotent: guarded by mode:"HUMAN" so stale/double buttons are no-ops.
   */
  static async releaseByCustomer(customerId: string) {
    const conv = await this.getOrCreateConversation(customerId);

    return prisma.$transaction(async (tx: any) => {
      const result = await tx.conversation.updateMany({
        where: {
          id: conv.id,
          mode: "HUMAN"
        },
        data: {
          mode: "AUTO",
          claimedById: null,
          claimedAt: null
        }
      });

      if (result.count !== 1) {
        // Already AUTO (staff released first, or button pressed twice).
        return tx.conversation.findUnique({ where: { id: conv.id } });
      }

      await AuditService.log(
        {
          actorId: customerId,
          actorRole: "CUSTOMER",
          action: "CONVERSATION_RELEASED",
          targetType: "CONVERSATION",
          targetId: conv.id,
          details: { customerId, previousOwner: conv.claimedById, releasedBy: "CUSTOMER" }
        },
        tx
      );

      return tx.conversation.findUnique({ where: { id: conv.id } });
    });
  }

  /**
   * Privileged takeover of conversation
   */
  static async takeover(
    customerId: string,
    newStaffId: string,
    staffRole: string,
    permissions: string[] = []
  ) {
    const isPrivileged =
      staffRole === "SUPER_ADMIN" ||
      staffRole === "ADMIN" ||
      permissions.includes("conversation.takeover");

    if (!isPrivileged) {
      throw new Error("Bạn không có quyền chuyển quyền tiếp nhận cuộc trò chuyện này.");
    }

    const conv = await this.getOrCreateConversation(customerId);

    return prisma.$transaction(async (tx: any) => {
      const previousOwner = conv.claimedById;
      const updated = await tx.conversation.update({
        where: { id: conv.id },
        data: {
          mode: "HUMAN",
          claimedById: newStaffId,
          claimedAt: new Date()
        }
      });

      await AuditService.log(
        {
          actorId: newStaffId,
          actorRole: staffRole,
          action: "CONVERSATION_TAKEOVER",
          targetType: "CONVERSATION",
          targetId: conv.id,
          details: { customerId, previousOwner, newOwner: newStaffId }
        },
        tx
      );

      return updated;
    });
  }

  /**
   * Checks if staff member has permission to send message in this conversation
   */
  static async canStaffMessage(
    customerId: string,
    staffId: string,
    staffRole: string,
    permissions: string[] = []
  ): Promise<boolean> {
    if (staffRole === "SUPER_ADMIN" || staffRole === "ADMIN" || permissions.includes("conversation.takeover")) {
      return true;
    }
    const conv = await this.getOrCreateConversation(customerId);
    return conv.claimedById === staffId;
  }

  /**
   * Creates an outbound CSKH message in PENDING delivery status
   */
  static async createOutboundMessage(data: {
    customerId: string;
    senderId: string;
    content: string;
    senderType?: "CSKH" | "ADMIN";
  }) {
    const conv = await this.getOrCreateConversation(data.customerId);
    return prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: data.senderType || "CSKH",
        senderId: data.senderId,
        content: data.content,
        deliveryStatus: "PENDING"
      }
    });
  }

  /**
   * Marks message as successfully sent to Telegram
   */
  static async markMessageSent(messageId: string, telegramMessageId: number) {
    return prisma.message.update({
      where: { id: messageId },
      data: {
        deliveryStatus: "SENT",
        telegramMessageId
      }
    });
  }

  /**
   * Marks message delivery as failed
   */
  static async markMessageFailed(messageId: string, error: string) {
    const sanitizedError = (error || "Unknown delivery error").slice(0, 500);
    logger.error({ messageId, error: sanitizedError }, "CSKH message delivery failed");
    return prisma.message.update({
      where: { id: messageId },
      data: {
        deliveryStatus: "FAILED",
        deliveryError: sanitizedError
      }
    });
  }

  static async addMessage(data: {
    customerId: string;
    senderType: "CUSTOMER" | "CSKH" | "SYSTEM" | "AI" | "BOT";
    senderId?: string;
    content: string;
    originalAudioFileId?: string;
    originalAudioSha256?: string;
    translatedContent?: string;
    deliveryStatus?: string;
    telegramMessageId?: number;
  }) {
    const conv = await this.getOrCreateConversation(data.customerId);
    return prisma.message.create({
      data: {
        conversationId: conv.id,
        senderType: data.senderType,
        senderId: data.senderId,
        content: data.content,
        originalAudioFileId: data.originalAudioFileId,
        originalAudioSha256: data.originalAudioSha256,
        translatedContent: data.translatedContent,
        deliveryStatus: data.deliveryStatus || "SENT",
        telegramMessageId: data.telegramMessageId
      }
    });
  }

  static async addInternalNote(customerId: string, authorId: string, content: string) {
    const conv = await this.getOrCreateConversation(customerId);
    return prisma.internalNote.create({
      data: {
        conversationId: conv.id,
        authorId,
        content
      }
    });
  }

  static async getHistory(customerId: string, limit: number = 30) {
    const conv = await this.getOrCreateConversation(customerId);
    const messages = await prisma.message.findMany({
      where: { conversationId: conv.id },
      take: limit,
      orderBy: { createdAt: "asc" }
    });
    const notes = await prisma.internalNote.findMany({
      where: { conversationId: conv.id },
      take: limit,
      orderBy: { createdAt: "asc" }
    });
    return { messages, notes, mode: conv.mode, claimedById: conv.claimedById };
  }

  static async getActiveTickets() {
    return prisma.conversation.findMany({
      where: { mode: "HUMAN" }
    });
  }

  static async previewTranslation(text: string, targetLanguage: string) {
    return AiProvider.translateText(text, targetLanguage);
  }
}
