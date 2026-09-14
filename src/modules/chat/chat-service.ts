/**
 * Chat persistence facade.
 *
 * Customer-facing chat handlers use this stable entry point. The current
 * implementation delegates to the legacy transcript service while retaining
 * its dedupe, delivery gating, and best-effort behavior.
 */
import {
  CustomerChatHistoryService,
  type ChatRecordInput
} from "./customer-chat-history-service.js";

export type ChatRecordInputWithoutRouting = Omit<ChatRecordInput, "direction" | "senderType">;
export type ChatRecordInputWithStaff = ChatRecordInputWithoutRouting & { staffTelegramId: string };

export class ChatService {
  static async recordInbound(input: ChatRecordInputWithoutRouting): Promise<void> {
    return CustomerChatHistoryService.recordInbound(input);
  }

  static async recordBotOutbound(input: ChatRecordInputWithoutRouting): Promise<void> {
    return CustomerChatHistoryService.recordBotOutbound(input);
  }

  static async recordStaffOutbound(input: ChatRecordInputWithStaff): Promise<void> {
    return CustomerChatHistoryService.recordStaffOutbound(input);
  }
}
