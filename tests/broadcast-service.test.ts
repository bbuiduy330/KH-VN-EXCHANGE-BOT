import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import {
  BROADCAST_CTA_BUTTONS,
  BroadcastTransport,
  cancelCampaign,
  confirmCampaign,
  countEligible,
  createCampaign,
  isBroadcastEligible,
  matchesAudienceFilter,
  processPendingCampaigns,
  sendTestToAdmin,
  setBroadcastTransport
} from "../src/modules/broadcast/broadcast-service.js";

/**
 * Part C — Broadcast service (deterministic, injected transport, mock DB).
 */

let sent: { chatId: string; kind: "message" | "photo"; text: string; buttons?: any }[] = [];

function failingTransport(err: unknown): BroadcastTransport {
  return {
    sendMessage: async () => { throw err; },
    sendPhoto: async () => { throw err; }
  };
}

beforeEach(() => {
  sent = [];
  setBroadcastTransport({
    sendMessage: async (chatId, html, buttons) => {
      sent.push({ chatId, kind: "message", text: html, buttons });
    },
    sendPhoto: async (chatId, _fileId, caption, buttons) => {
      sent.push({ chatId, kind: "photo", text: caption, buttons });
    }
  });
});

afterAll(() => {
  setBroadcastTransport(null);
});

async function mkCustomer(opts: { marketing?: boolean; reachable?: boolean; language?: string } = {}): Promise<any> {
  const digits = uniqueId().replace(/\D/g, "").slice(0, 9) || "1";
  const c = await CustomerService.getOrCreateCustomer({ telegramId: digits });
  await prisma.customer.update({
    where: { id: c.id },
    data: {
      marketingEnabled: opts.marketing !== false,
      telegramReachable: opts.reachable !== false,
      language: opts.language || "vi"
    }
  });
  return prisma.customer.findUnique({ where: { id: c.id } });
}

describe("Part C — eligibility (C2) + audience filters (C3)", () => {
  it("excludes opt-out and blocked customers; requires a numeric Telegram ID", () => {
    expect(isBroadcastEligible({ telegramId: "123456789", marketingEnabled: true, telegramReachable: true })).toBe(true);
    expect(isBroadcastEligible({ telegramId: "123456789", marketingEnabled: false, telegramReachable: true })).toBe(false);
    expect(isBroadcastEligible({ telegramId: "123456789", marketingEnabled: true, telegramReachable: false })).toBe(false);
    expect(isBroadcastEligible({ telegramId: "", marketingEnabled: true, telegramReachable: true })).toBe(false);
    expect(isBroadcastEligible({ telegramId: "not-a-number", marketingEnabled: true, telegramReachable: true })).toBe(false);
  });

  it("matchesAudienceFilter applies combined deterministic filters", () => {
    const now = new Date("2026-09-12T00:00:00Z");
    const c = { language: "vi" };
    const orders = [
      { status: "COMPLETED", sourceCurrency: "USD", createdAt: new Date("2026-09-10T00:00:00Z") },
      { status: "SUSPICIOUS", sourceCurrency: "USD", createdAt: new Date("2026-08-01T00:00:00Z") }
    ];
    expect(matchesAudienceFilter(c, orders, { locale: "vi", directionUsdToVnd: true }, now)).toBe(true);
    expect(matchesAudienceFilter(c, orders, { excludeRisk: true }, now)).toBe(false);
    expect(matchesAudienceFilter(c, orders, { activity: "LAST_7D" }, now)).toBe(true);
    expect(
      matchesAudienceFilter(
        c,
        [{ status: "COMPLETED", sourceCurrency: "VND", createdAt: new Date("2026-01-01T00:00:00Z") }],
        { activity: "INACTIVE_30D" },
        now
      )
    ).toBe(true);
    expect(
      matchesAudienceFilter(
        c,
        [{ status: "COMPLETED", sourceCurrency: "VND", createdAt: new Date("2026-09-11T00:00:00Z") }],
        { activity: "INACTIVE_30D" },
        now
      )
    ).toBe(false);
    expect(matchesAudienceFilter({ language: "en" }, [], { locale: "vi" }, now)).toBe(false);
  });

  it("countEligible reflects filters before any send", async () => {
    await mkCustomer({ language: "vi" });
    await mkCustomer({ language: "en" });
    const n = await countEligible("FILTER", { locale: "vi" });
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("Part C — campaign snapshot, confirm, composer safety", () => {
  it("snapshots the audience BEFORE sending; opt-out/blocked excluded; no duplicates", async () => {
    await mkCustomer();
    await mkCustomer({ marketing: false });
    await mkCustomer({ reachable: false });

    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ALL",
      content: { text: "Chào khách! Ưu đãi hôm nay." }
    });
    const { campaign: confirmed, totalRecipients } = await confirmCampaign("admin-bc", campaign.id);
    expect(totalRecipients).toBeGreaterThanOrEqual(1);

    const recipients: any[] = await prisma.broadcastRecipient.findMany({ where: { campaignId: confirmed.id } });
    expect(recipients.every((r) => r.telegramId && r.status === "PENDING")).toBe(true);
    const ids = recipients.map((r) => r.customerId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it("preview/test-send NEVER mass-sends and only reaches the requesting Admin", async () => {
    const before = sent.length;
    await sendTestToAdmin("admin-777", { text: "Nội dung thử", cta: true });
    const testMessages = sent.slice(before);
    expect(testMessages.length).toBe(1);
    expect(testMessages[0].chatId).toBe("admin-777");
    expect(testMessages[0].text).toContain("GỬI THỬ");
    expect(testMessages[0].buttons).toEqual(BROADCAST_CTA_BUTTONS);
    const campaigns: any[] = await prisma.broadcastCampaign.findMany({});
    expect(campaigns.filter((c) => c.status === "READY" || c.status === "SENDING").length).toBe(0);
  });

  it("explicit confirm is required — nothing sends while DRAFT, no early snapshot", async () => {
    const a = await mkCustomer();
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [a.id],
      content: { text: "draft only" }
    });
    await processPendingCampaigns(10); // worker must ignore DRAFT
    expect(sent.length).toBe(0);
    const c: any = await prisma.broadcastCampaign.findUnique({ where: { id: campaign.id } });
    expect(c.status).toBe("DRAFT");
    const recipients = await prisma.broadcastRecipient.findMany({ where: { campaignId: campaign.id } });
    expect(recipients.length).toBe(0); // snapshot happens ONLY at confirm
  });

  it("confirmCampaign refuses customers who opted out (ONE_CUSTOMER)", async () => {
    const off = await mkCustomer({ marketing: false });
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [off.id],
      content: { text: "nope" }
    });
    await expect(confirmCampaign("admin-bc", campaign.id)).rejects.toThrow();
  });

  it("cancelCampaign only cancels DRAFT/READY; cancelled cannot be confirmed", async () => {
    const a = await mkCustomer();
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [a.id],
      content: { text: "to cancel" }
    });
    const cancelled = await cancelCampaign("admin-bc", campaign.id);
    expect(cancelled.status).toBe("CANCELLED");
    await expect(confirmCampaign("admin-bc", campaign.id)).rejects.toThrow();
  });
});


describe("Part C — durable delivery queue (C7/C8)", () => {
  it("ONE_CUSTOMER campaign sends only to that customer; restart-safe recovery", async () => {
    const a = await mkCustomer();
    const other = await mkCustomer();
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [a.id],
      content: { text: "Tin nhắn riêng cho bạn." }
    });
    const { campaign: confirmed } = await confirmCampaign("admin-bc", campaign.id);
    expect(confirmed.totalRecipients).toBe(1);

    // Simulate a crash mid-campaign (stale SENDING) — worker must resume it.
    await prisma.broadcastCampaign.update({
      where: { id: confirmed.id },
      data: { status: "SENDING", startedAt: new Date(Date.now() - 10 * 60 * 1000) }
    });
    sent = [];
    await processPendingCampaigns(10);

    const chatIds = sent.filter((s) => s.kind === "message").map((s) => s.chatId);
    expect(chatIds).toContain(String(a.telegramId));
    expect(chatIds).not.toContain(String(other.telegramId));

    const rec: any = await prisma.broadcastRecipient.findFirst({ where: { campaignId: confirmed.id } });
    expect(rec.status).toBe("SENT");
    const done: any = await prisma.broadcastCampaign.findUnique({ where: { id: confirmed.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.sentCount).toBe(1);
    void prisma;
  });

  it("BLOCKED recipient flags telegramReachable=false", async () => {
    const blocked = await mkCustomer();
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [blocked.id],
      content: { text: "blocked path" }
    });
    const { campaign: confirmed } = await confirmCampaign("admin-bc", campaign.id);
    setBroadcastTransport(failingTransport(new Error("403 Forbidden: bot was blocked by the user")));
    await processPendingCampaigns(10);
    setBroadcastTransport(null);

    const rec: any = await prisma.broadcastRecipient.findFirst({ where: { campaignId: confirmed.id } });
    expect(rec.status).toBe("BLOCKED");
    const c: any = await prisma.customer.findUnique({ where: { id: blocked.id } });
    expect(c.telegramReachable).toBe(false);
  });

  it("retry_after keeps the recipient PENDING; permanent failure after retries → FAILED", async () => {
    const flaky = await mkCustomer();
    const campaign = await createCampaign({
      createdByTelegramId: "admin-bc",
      audienceType: "ONE_CUSTOMER",
      customerIds: [flaky.id],
      content: { text: "retry path" }
    });
    const { campaign: confirmed } = await confirmCampaign("admin-bc", campaign.id);

    setBroadcastTransport(failingTransport(new Error("Too Many Requests: retry after 1")));
    await processPendingCampaigns(10);
    let rec: any = await prisma.broadcastRecipient.findFirst({ where: { campaignId: confirmed.id } });
    expect(rec.status).toBe("PENDING"); // conservative retry, not failed
    expect(rec.attempts).toBeGreaterThanOrEqual(1);

    setBroadcastTransport(failingTransport(new Error("internal telegram error")));
    await prisma.broadcastCampaign.update({ where: { id: confirmed.id }, data: { status: "READY" } });
    await processPendingCampaigns(10);
    await prisma.broadcastCampaign.update({ where: { id: confirmed.id }, data: { status: "READY" } });
    await processPendingCampaigns(10);
    rec = await prisma.broadcastRecipient.findFirst({ where: { campaignId: confirmed.id } });
    expect(rec.status).toBe("FAILED");
    setBroadcastTransport(null);
  });
});

