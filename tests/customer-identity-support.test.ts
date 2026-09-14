import { describe, it, expect } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { resolveCustomer } from "../src/modules/customer/customer-resolver.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import {
  setBotInstance,
  notifySupportRequest,
  renderSupportRequestText,
  supportRequestKeyboard
} from "../src/bot/notifications.js";
import {
  CUSTOMER_SUPPORT_ROUTE,
  CUSTOMER_SUPPORT_CLAIM_ROUTE,
  CUSTOMER_SUPPORT_RELEASE_ROUTE
} from "../src/bot/admin/admin-customers.js";

/**
 * Customer identity / support lookup / duplicate-notification fixes.
 *
 * Identity semantics (authoritative):
 *   - Telegram numeric ID : Telegram identity
 *   - Customer.id         : internal DB primary key (callbacks only, never UI)
 *   - Customer Ref        : public short reference (#last6 of Customer.id)
 *   - username            : display only, NEVER identity
 */

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function makeCustomer(): Promise<{ id: string; telegramId: string }> {
  const telegramId = unique();
  const customer = await CustomerService.getOrCreateCustomer({ telegramId });
  return { telegramId, customer };
}

describe("Canonical customer resolver (id / Telegram ID / Ref)", () => {
  it("resolves by internal Customer.id", async () => {
    const { customer } = await makeCustomer();
    const r = await resolveCustomer(customer.id);
    expect(r.matchedBy).toBe("id");
    expect(r.customer?.id).toBe(customer.id);
  });

  it("resolves by Telegram numeric ID (exact, never misinterpreted)", async () => {
    const { telegramId, customer } = await makeCustomer();
    const r = await resolveCustomer(telegramId);
    expect(r.matchedBy).toBe("telegramId");
    expect(r.customer?.id).toBe(customer.id);
  });

  it("resolves by public Customer Ref (#last6, uppercase presentation)", async () => {
    const { customer } = await makeCustomer();
    const r = await resolveCustomer(`#${customer.id.slice(-6).toUpperCase()}`);
    expect(r.matchedBy).toBe("ref");
    expect(r.customer?.id).toBe(customer.id);
  });

  it("legacy lowercase refs still resolve", async () => {
    const { customer } = await makeCustomer();
    const r = await resolveCustomer(customer.id.slice(-6).toLowerCase());
    expect(r.matchedBy).toBe("ref");
    expect(r.customer?.id).toBe(customer.id);
  });

  it("11. username is display-only: changing it never breaks identity lookup", async () => {
    const { telegramId, customer } = await makeCustomer();
    await prisma.customer.update({ where: { id: customer.id }, data: { username: `old_${unique()}` } });
    // Authoritative lookups work before, between and after username changes:
    expect((await resolveCustomer(telegramId)).customer?.id).toBe(customer.id);
    await prisma.customer.update({ where: { id: customer.id }, data: { username: `new_${unique()}` } });
    expect((await resolveCustomer(customer.id)).customer?.id).toBe(customer.id);
    // Username is NEVER an identity lookup key.
    const current: any = await prisma.customer.findUnique({ where: { id: customer.id } });
    expect((await resolveCustomer(`@${current.username}`)).customer).toBeNull();
  });

  it("returns null for unknown identifiers (no guessing)", async () => {
    const r = await resolveCustomer("zzzzzz");
    expect(r.customer).toBeNull();
    expect(r.matchedBy).toBeNull();
  });
});

describe("Admin Customer → Support callback routing (root cause: greedy route)", () => {
  it("1/2. generic support route matches the canonical Customer.id payload…", () => {
    const custId = "cmtyme0vh000108tcigh4q4wq";
    // Generic support route matches the plain id payload…
    expect(CUSTOMER_SUPPORT_ROUTE.exec(`ops:customer:support:${custId}`)?.[1]).toBe(custId);
  });

  it("…and no longer swallows claim/release payloads (was 'Không tìm thấy khách hàng')", () => {
    const custId = "cmtyme0vh000108tcigh4q4wq";
    expect(CUSTOMER_SUPPORT_ROUTE.test(`ops:customer:support:claim:${custId}`)).toBe(false);
    expect(CUSTOMER_SUPPORT_ROUTE.test(`ops:customer:support:release:${custId}`)).toBe(false);
    expect(CUSTOMER_SUPPORT_CLAIM_ROUTE.exec(`ops:customer:support:claim:${custId}`)?.[1]).toBe(custId);
    expect(CUSTOMER_SUPPORT_RELEASE_ROUTE.exec(`ops:customer:support:release:${custId}`)?.[1]).toBe(custId);
  });
});

describe("Support notification privacy + dedupe/idempotency", () => {
  it("6. notification text shows name/TG/Ref and NEVER the raw internal Customer.id", async () => {
    const { customer } = await makeCustomer();
    await prisma.customer.update({ where: { id: customer.id }, data: { fullName: "Ziconat Identity" } });
    const fresh: any = await prisma.customer.findUnique({ where: { id: customer.id } });
    const text = renderSupportRequestText(fresh);
    expect(text).toContain("Ziconat Identity");
    expect(text).toContain(fresh.telegramId);
    expect(text).toContain(`#${fresh.id.slice(-6).toUpperCase()}`);
    expect(text).not.toContain(fresh.id); // full internal id must NOT leak
    const kb = await supportRequestKeyboard(fresh.id);
    const labels = kb.inline_keyboard.flat().map((b: any) => String(b.text));
    // Existing screens, human labels — internal id only inside callback payloads.
    expect(labels).toContain("💬 Hỗ trợ khách");
    expect(labels).toContain("👤 Hồ sơ khách");
    expect(labels.join(" ")).not.toContain(fresh.id);
  });
});

function envSuper(): string {
  return process.env.SUPER_ADMIN_TELEGRAM_ID || "super-admin";
}

async function setFakeBotCapture(sends: string[]): Promise<void> {
  setBotInstance({
    api: {
      sendMessage: async (chatId: string) => {
        sends.push(String(chatId));
        return { message_id: 1 };
      }
    }
  } as any);
}

describe("Support notification recipient dedupe (Set<telegramId>)", () => {
  it("7. same Telegram ID in Admin staff + notification chat receives exactly ONE notification", async () => {
    const tgA = unique();
    const { customer } = await makeCustomer();
    const prior = RuntimeConfigService.getAdminNotificationChatId();
    const sends: string[] = [];
    try {
      await PermissionService.inviteStaff({ telegramId: tgA, name: "Dedupe Admin", role: "ADMIN" });
      await RuntimeConfigService.setAdminNotificationChatId(tgA, "TEST");
      await setFakeBotCapture(sends);
      await notifySupportRequest(renderSupportRequestText(customer), {
        parse_mode: "HTML",
        reply_markup: await supportRequestKeyboard(customer.id)
      });
      // TG A is BOTH the admin-notification chat AND an eligible ADMIN staff
      // row — must receive exactly ONE notification, never two.
      expect(sends.filter((c) => c === tgA).length).toBe(1);
    } finally {
      await RuntimeConfigService.setAdminNotificationChatId(prior, "TEST");
      await PermissionService.toggleStaffStatus(envSuper(), tgA).catch(() => {});
    }
  });

  it("8. two distinct staff Telegram IDs each receive exactly one notification", async () => {
    const tgA = unique();
    const tgB = unique();
    const prior = RuntimeConfigService.getAdminNotificationChatId();
    const sends: string[] = [];
    try {
      await PermissionService.inviteStaff({ telegramId: tgA, name: "Staff A", role: "CSKH" });
      await PermissionService.inviteStaff({ telegramId: tgB, name: "Staff B", role: "CSKH" });
      await RuntimeConfigService.setAdminNotificationChatId(tgA, "TEST");
      await setFakeBotCapture(sends);
      await notifySupportRequest("test-notification");
      expect(sends.filter((c) => c === tgA).length).toBe(1);
      expect(sends.filter((c) => c === tgB).length).toBe(1);
    } finally {
      await RuntimeConfigService.setAdminNotificationChatId(prior, "TEST");
      await PermissionService.toggleStaffStatus(envSuper(), tgA).catch(() => {});
      await PermissionService.toggleStaffStatus(envSuper(), tgB).catch(() => {});
    }
  });

  it("9/10. rapid duplicate support requests deduplicate; release allows a NEW request", async () => {
    const { customer } = await makeCustomer();
    const first = await ConversationService.requestHumanSupport(customer.id);
    expect(first.newRequest).toBe(true);
    // Rapid duplicate press — session REUSED, no new notification trigger:
    const second = await ConversationService.requestHumanSupport(customer.id);
    expect(second.newRequest).toBe(false);
    // Staff release closes the session…
    await ConversationService.release(customer.id, "staff-cleanup", "ADMIN");
    // …so a LATER support request is legitimate and notifies again.
    const third = await ConversationService.requestHumanSupport(customer.id);
    expect(third.newRequest).toBe(true);
    await ConversationService.release(customer.id, "staff-cleanup", "SUPER_ADMIN");
  });
});

