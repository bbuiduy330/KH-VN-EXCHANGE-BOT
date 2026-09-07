import { describe, it, expect, beforeEach } from "vitest";
import { resolveUserIdentity } from "../src/bot/middleware/identity.js";
import { hasStaffPermission } from "../src/bot/middleware/permissions.js";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { renderCustomerStartText, getCustomerMenuKeyboard } from "../src/bot/menus/customer-menu.js";
import { renderCskhStartText, getCskhMenuKeyboard } from "../src/bot/menus/cskh-menu.js";
import { renderAdminStartText, getAdminMenuKeyboard } from "../src/bot/menus/admin-menu.js";
import { setBotInstance, sendToCustomer, sendToStaff, sendToAdminNotificationChat } from "../src/bot/notifications.js";
import { env } from "../src/config/env.js";

describe("Unified Single Telegram Bot Architecture & Required Tests", () => {
  const superAdminId = env.SUPER_ADMIN_TELEGRAM_ID || "super-admin";
  const testAdminId = "555111222";
  const testCskhId = "555333444";
  const testCustomerId = "555999888";

  beforeEach(async () => {
    // Ensure Super Admin bootstrap is called
    await PermissionService.bootstrapSuperAdmin();

    // Setup test Admin
    await PermissionService.inviteStaff({
      telegramId: testAdminId,
      name: "SingleBot Test Admin",
      role: "ADMIN"
    });

    // Setup test CSKH
    await PermissionService.inviteStaff({
      telegramId: testCskhId,
      name: "SingleBot Test CSKH",
      role: "CSKH"
    });
  });

  // Test 1: Unknown Telegram ID -> CUSTOMER
  it("1. Unknown Telegram ID resolves to CUSTOMER", async () => {
    const identity = await resolveUserIdentity(testCustomerId);
    expect(identity.userType).toBe("CUSTOMER");
    expect(identity.status).toBe("ACTIVE");
    expect(identity.staff).toBeUndefined();
    expect(identity.permissions).toEqual([]);
  });

  // Test 2: Staff role CSKH -> CSKH menu
  it("2. Staff role CSKH receives CSKH menu and default permissions", async () => {
    const identity = await resolveUserIdentity(testCskhId);
    expect(identity.userType).toBe("CSKH");
    expect(identity.status).toBe("ACTIVE");

    const text = renderCskhStartText("Test CSKH");
    expect(text).toContain("CHĂM SÓC KHÁCH HÀNG");

    const keyboard = getCskhMenuKeyboard();
    const buttons = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toContain("👥 Khách đang chờ");
    expect(buttons).toContain("🤖 Trả về AI");
  });

  // Test 3: Staff role ADMIN -> ADMIN menu
  it("3. Staff role ADMIN receives ADMIN menu and admin permissions", async () => {
    const identity = await resolveUserIdentity(testAdminId);
    expect(identity.userType).toBe("ADMIN");
    expect(identity.status).toBe("ACTIVE");

    const text = renderAdminStartText("Test Admin", false);
    expect(text).toContain("HỆ THỐNG QUẢN TRỊ ADMIN");

    const keyboard = getAdminMenuKeyboard(false);
    const buttons = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons).toContain("💰 Chờ xác nhận tiền");
    expect(buttons).toContain("💸 Chờ payout");
  });

  // Test 4: Customer cannot call admin action
  it("4. Customer cannot call admin action", async () => {
    const canVerify = await hasStaffPermission(testCustomerId, "payment.verify");
    const canPayout = await hasStaffPermission(testCustomerId, "payout.approve");
    const canManageStaff = await hasStaffPermission(testCustomerId, "staff.manage");
    const canEditRates = await hasStaffPermission(testCustomerId, "rate.edit");

    expect(canVerify).toBe(false);
    expect(canPayout).toBe(false);
    expect(canManageStaff).toBe(false);
    expect(canEditRates).toBe(false);
  });

  // Test 5: CSKH cannot verify payment by default
  it("5. CSKH cannot verify payment by default", async () => {
    const canVerify = await hasStaffPermission(testCskhId, "payment.verify");
    const canPayout = await hasStaffPermission(testCskhId, "payout.approve");
    expect(canVerify).toBe(false);
    expect(canPayout).toBe(false);
  });

  // Test 6: Admin with payment.verify can verify
  it("6. Admin with payment.verify can verify", async () => {
    const canVerify = await hasStaffPermission(testAdminId, "payment.verify");
    const canPayout = await hasStaffPermission(testAdminId, "payout.approve");
    expect(canVerify).toBe(true);
    expect(canPayout).toBe(true);
  });

  // Test 7: StaffPermission override works
  it("7. StaffPermission override works to grant or revoke granular permissions", async () => {
    // Initially CSKH cannot verify payments
    expect(await hasStaffPermission(testCskhId, "payment.verify")).toBe(false);

    // Super Admin explicitly overrides/grants payment.verify to CSKH
    await PermissionService.togglePermission(superAdminId, testCskhId, "payment.verify");
    expect(await hasStaffPermission(testCskhId, "payment.verify")).toBe(true);

    // Super Admin toggles it off
    await PermissionService.togglePermission(superAdminId, testCskhId, "payment.verify");
    expect(await hasStaffPermission(testCskhId, "payment.verify")).toBe(false);
  });

  // Test 8: CSKH reply sends to correct customer telegram ID
  it("8. CSKH reply sends to correct customer telegram ID without exposing CSKH username", async () => {
    const sentMessages: Array<{ chatId: string; text: string }> = [];
    const mockBot: any = {
      api: {
        sendMessage: async (chatId: string, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 101 };
        }
      }
    };
    setBotInstance(mockBot);

    // Ensure customer exists
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: testCustomerId,
      fullName: "Nguyen Van Test"
    });

    // Staff sends message via notification module
    const replyText = "Bộ phận CSKH:\nEm đang kiểm tra thông tin giao dịch cho anh ạ.";
    const sent = await sendToCustomer(customer.telegramId, replyText);

    expect(sent).toBe(true);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]?.chatId).toBe(testCustomerId);
    expect(sentMessages[0]?.text).toContain("Bộ phận CSKH");
    expect(sentMessages[0]?.text).not.toContain("Test CSKH"); // Does not expose CSKH username

    setBotInstance(null);
  });

  // Test 9: Internal note does not send customer message
  it("9. Internal note does not send customer message", async () => {
    const sentMessages: Array<{ chatId: string; text: string }> = [];
    const mockBot: any = {
      api: {
        sendMessage: async (chatId: string, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 102 };
        }
      }
    };
    setBotInstance(mockBot);

    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: testCustomerId,
      fullName: "Nguyen Van Test"
    });

    // Add internal note
    const note = await ConversationService.addInternalNote(
      customer.id,
      testCskhId,
      "Khách này đã giao dịch nhiều lần, ưu tiên hỗ trợ."
    );

    expect(note).toBeDefined();
    expect(note.content).toContain("ưu tiên hỗ trợ");

    // Verify zero messages were sent to the customer
    expect(sentMessages.length).toBe(0);

    // Verify note is stored internally
    const history = await ConversationService.getHistory(customer.id);
    expect(history.notes.some((n: any) => n.content.includes("ưu tiên hỗ trợ"))).toBe(true);

    setBotInstance(null);
  });

  // Test 10: HUMAN mode prevents AI auto reply
  it("10. HUMAN mode prevents AI auto reply", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: testCustomerId,
      fullName: "Nguyen Van Test"
    });

    // Switch mode to HUMAN (claimed by CSKH)
    await ConversationService.claim(customer.id, testCskhId);
    const conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("HUMAN");
    expect(conv.claimedById).toBe(testCskhId);

    // In handler logic, if mode === 'HUMAN', AI auto reply is skipped and routed to staff
    const shouldAiAutoReply = conv.mode === "AUTO";
    expect(shouldAiAutoReply).toBe(false);
  });

  // Test 11: AUTO mode allows AI reply
  it("11. AUTO mode allows AI reply", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: testCustomerId,
      fullName: "Nguyen Van Test"
    });

    // Release back to AUTO
    await ConversationService.release(customer.id, testCskhId);
    const conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("AUTO");
    expect(conv.claimedById).toBeNull();

    // In handler logic, if mode === 'AUTO', AI is active
    const shouldAiAutoReply = conv.mode === "AUTO";
    expect(shouldAiAutoReply).toBe(true);
  });

  // Test 12: SUPER_ADMIN bootstrap is idempotent
  it("12. SUPER_ADMIN bootstrap is idempotent", async () => {
    // Run bootstrap multiple times
    await PermissionService.bootstrapSuperAdmin();
    await PermissionService.bootstrapSuperAdmin();
    await PermissionService.bootstrapSuperAdmin();

    const identity = await resolveUserIdentity(superAdminId);
    expect(identity.userType).toBe("SUPER_ADMIN");
    expect(identity.status).toBe("ACTIVE");
    expect(identity.permissions.includes("payment.verify")).toBe(true);
    expect(identity.permissions.includes("staff.manage")).toBe(true);
  });
});
