import { prisma } from "../../database/client.js";
import { AiProvider } from "../ai/ai-provider.js";
import { AuditService } from "../audit/audit-service.js";

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

  static async setMode(customerId: string, mode: "AUTO" | "HUMAN", staffId?: string) {
    const conv = await this.getOrCreateConversation(customerId);
    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        mode,
        claimedById: mode === "HUMAN" ? staffId : null,
        claimedAt: mode === "HUMAN" ? new Date() : null
      }
    });

    await AuditService.log({
      actorId: staffId || "SYSTEM",
      actorRole: staffId ? "STAFF" : "SYSTEM",
      action: `CONVERSATION_MODE_${mode}`,
      targetType: "CONVERSATION",
      targetId: conv.id,
      details: { customerId, mode }
    });

    return updated;
  }

  static async claim(customerId: string, staffId: string) {
    return this.setMode(customerId, "HUMAN", staffId);
  }

  static async release(customerId: string, staffId: string) {
    return this.setMode(customerId, "AUTO");
  }

  static async addMessage(data: {
    customerId: string;
    senderType: "CUSTOMER" | "CSKH" | "SYSTEM" | "AI";
    senderId?: string;
    content: string;
    originalAudioFileId?: string;
    originalAudioSha256?: string;
    translatedContent?: string;
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
        translatedContent: data.translatedContent
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
