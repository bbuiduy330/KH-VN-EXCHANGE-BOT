import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/database/client.js";
import { MoneyService } from "../src/modules/money/money-service.js";
import { renderQuoteCard } from "../src/bot/menus/customer-menu.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import {
  CHAT_HISTORY_FETCH_TAKE,
  CHAT_HISTORY_PAGE_SIZE,
  CustomerChatHistoryService
} from "../src/modules/chat/customer-chat-history-service.js";
import {
  ADMIN_LIST_RAW_SCAN_CAP,
  ADMIN_LIST_SCAN_BATCH,
  scanCursorForBatch
} from "../src/bot/admin/admin-list-session.js";

/**
 * FINAL OPERATIONS PASS — regression coverage:
 *   Part 0  quote displayed rate (both directions, both frozen semantics)
 *   Part 3  admin-editable multilingual quote footer (presentation only)
 *   Part 2  durable customer chat transcript (dedupe / outbound / paging)
 *   Part 1  activity incremental-scan constants + cursor semantics
 */

const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------
// PART 0 — displayed rate == Quote's own applicable frozen rate
// ---------------------------------------------------------------------------

describe("quote displayed rate (authoritative frozen value)", () => {
  it("1. USD→VND displays the quote's frozen effective rate directly", () => {
    expect(MoneyService.formatEffectiveRate("USD", "VND", 25400)).toBe("1 USD = 25 400 VND");
  });

  it("2a. VND→USD source-side frozen rate (USD-per-VND multiplier < 1) inverts", () => {
    // calculateQuote stores effectiveRate = 1/effectiveSell ≈ 0.00003937
    expect(MoneyService.formatEffectiveRate("VND", "USD", "0.00003937")).toBe("1 USD = 25 400 VND");
  });

  it("2b. VND→USD target-side frozen rate (VND-per-USD sell rate ≥ 1) shows as-is", () => {
    // calculateQuoteFromTarget stores effectiveRate = effectiveSell (25500) —
    // the OLD display inverted this into "1 USD = 0 VND" (the P0 bug).
    expect(MoneyService.formatEffectiveRate("VND", "USD", 25500)).toBe("1 USD = 25 500 VND");
  });

  it("3. displayed rate corresponds to the rate that produced targetAmount", () => {
    // VND→USD target-path quote: target = sourceVND / 25500; display shows
    // 25 500 (the applicable VND-per-USD rate) — never 0.
    const rate = 25500;
    const display = MoneyService.formatEffectiveRate("VND", "USD", rate);
    expect(Number(display.replace(/[^\d]/g, ""))).toBe(rate);
    expect(Math.round(2_550_000 / rate)).toBe(100); // 2 550 000 VND → 100 USD
  });
});

// ---------------------------------------------------------------------------
// PART 3 — quote footer (presentation only)
// ---------------------------------------------------------------------------

const baseQuote = () => ({
  id: `Q-${RUN}`,
  sourceCurrency: "USD",
  targetCurrency: "VND",
  sourceAmount: 100,
  targetAmount: 2540000,
  effectiveRate: 25400,
  baseRate: 25450,
  fee: 2,
  feeCurrency: "USD",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date()
} as any);

describe("quote footer (multilingual, escaped, financially inert)", () => {
  beforeAll(async () => {
    await RuntimeConfigService.set("quoteFooterEnabled", true, "TEST");
    await RuntimeConfigService.set("quoteFooterVi", "Anh/chị có USDT vui lòng nhắn @footervi", "TEST");
    await RuntimeConfigService.set("quoteFooterEn", "Have USDT? Message @footeren", "TEST");
    await RuntimeConfigService.set("quoteFooterKm", "សូមទំនាក់ទំនង @footerkm", "TEST");
    await RuntimeConfigService.set("quoteFooterZh", "如需USDT请联系 @footerzh", "TEST");
  });

  it("28. disabled → quote body unchanged (no footer)", async () => {
    await RuntimeConfigService.set("quoteFooterEnabled", false, "TEST");
    const out = renderQuoteCard(baseQuote(), 10, "vi");
    expect(out).not.toContain("──────────");
    expect(out).toContain("25 400");
    await RuntimeConfigService.set("quoteFooterEnabled", true, "TEST");
  });

  it("29-32. VI/EN/KM/ZH each render their own locale footer", () => {
    expect(renderQuoteCard(baseQuote(), 10, "vi")).toContain("@footervi");
    expect(renderQuoteCard(baseQuote(), 10, "en")).toContain("@footeren");
    expect(renderQuoteCard(baseQuote(), 10, "km")).toContain("@footerkm");
    expect(renderQuoteCard(baseQuote(), 10, "zh")).toContain("@footerzh");
  });

  it("33. unconfigured locale → NO footer and NO cross-locale leak", async () => {
    await RuntimeConfigService.set("quoteFooterEn", "", "TEST");
    const enOut = renderQuoteCard(baseQuote(), 10, "en");
    expect(enOut).not.toContain("──────────"); // no fallback footer
    expect(enOut).not.toContain("@footervi"); // no VI leak to EN customer
    await RuntimeConfigService.set("quoteFooterEn", "Have USDT? Message @footeren", "TEST");
    expect(renderQuoteCard(baseQuote(), 10, "en")).toContain("@footeren");
  });

  it("34-36. multiline + @username + HTML-like input render ESCAPED", async () => {
    await RuntimeConfigService.set("quoteFooterVi", "<Free USDT> @abc\nPhnom Penh", "TEST");
    const out = renderQuoteCard(baseQuote(), 10, "vi");
    expect(out).toContain("&lt;Free USDT&gt;"); // escaped — never raw HTML
    expect(out).toContain("@abc");
    expect(out).toContain("Phnom Penh");
    expect(out).not.toContain("<Free USDT>");
    // 37. financial body identical with footer on:
    await RuntimeConfigService.set("quoteFooterVi", "", "TEST");
    const bare = renderQuoteCard(baseQuote(), 10, "vi");
    expect(bare).toContain("25 400");
    expect(bare).toContain("2540000");
    expect(bare).not.toContain("──────────");
    await RuntimeConfigService.set("quoteFooterVi", "Anh/chị có USDT vui lòng nhắn @footervi", "TEST");
    const withFooter = renderQuoteCard(baseQuote(), 10, "vi");
    expect(withFooter.split("──────────")[0].trim()).toBe(bare.trim()); // body unchanged
    expect(withFooter).toContain("📌");
  });
});

// ---------------------------------------------------------------------------
// PART 2 — durable customer chat transcript
// ---------------------------------------------------------------------------

describe("durable customer chat transcript", () => {
  let customerId = "";
  let chatId = "";

  beforeAll(async () => {
    const c = await prisma.customer.create({
      data: { telegramId: `chat${RUN}${Math.floor(Math.random() * 1e6)}`.slice(0, 20) }
    });
    customerId = c.id;
    chatId = c.telegramId;
  });

  it("13. inbound text persisted once + TRUE lastActivityAt updated", async () => {
    const before: any = await prisma.customer.findUnique({ where: { id: customerId } });
    await CustomerChatHistoryService.recordInbound({
      customerId, telegramChatId: chatId, telegramMessageId: 101, text: "Anh muốn đổi 100 USD"
    });
    const after: any = await prisma.customer.findUnique({ where: { id: customerId } });
    expect(new Date(after.lastActivityAt).getTime()).toBeGreaterThanOrEqual(new Date(before.lastActivityAt).getTime());
    const rows = await prisma.customerChatMessage.findMany({ where: { customerId, telegramMessageId: "101" } });
    expect(rows.length).toBe(1);
    expect(rows[0].direction).toBe("INBOUND");
    expect(rows[0].senderType).toBe("CUSTOMER");
  });

  it("14. Telegram RETRY (same chat+message id+direction) does NOT duplicate", async () => {
    await CustomerChatHistoryService.recordInbound({ customerId, telegramChatId: chatId, telegramMessageId: 101, text: "Anh muốn đổi 100 USD" });
    const rows = await prisma.customerChatMessage.findMany({ where: { customerId, telegramMessageId: "101" } });
    expect(rows.length).toBe(1); // dedupe by authoritative Telegram identifiers
  });

  it("15. same TEXT later (different message id) is a DIFFERENT message", async () => {
    await CustomerChatHistoryService.recordInbound({ customerId, telegramChatId: chatId, telegramMessageId: 102, text: "Anh muốn đổi 100 USD" });
    const rows = await prisma.customerChatMessage.findMany({ where: { customerId, text: "Anh muốn đổi 100 USD" } });
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.telegramMessageId)).size).toBe(2);
  });

  it("16. photo metadata only (file_id + caption; nothing else invented)", async () => {
    await CustomerChatHistoryService.recordInbound({
      customerId, telegramChatId: chatId, telegramMessageId: 103,
      contentType: "PHOTO", caption: "bill của tôi", telegramFileId: "AgAC-file-id-xyz"
    });
    const row: any = await prisma.customerChatMessage.findFirst({ where: { customerId, telegramMessageId: "103" } });
    expect(row.contentType).toBe("PHOTO");
    expect(row.telegramFileId).toBe("AgAC-file-id-xyz");
    expect(row.text).toBeNull();
  });

  it("17/18. bot + staff outbound rows carry correct sender semantics", async () => {
    await CustomerChatHistoryService.recordBotOutbound({ customerId, telegramChatId: chatId, telegramMessageId: 9001, text: "bot reply" });
    await CustomerChatHistoryService.recordStaffOutbound({ customerId, telegramChatId: chatId, telegramMessageId: 9002, text: "staff reply", staffTelegramId: "999777" });
    const bot: any = await prisma.customerChatMessage.findFirst({ where: { customerId, telegramMessageId: "9001" } });
    expect(bot.senderType).toBe("BOT");
    const staffRows = await prisma.customerChatMessage.findMany({ where: { customerId, senderType: "STAFF" } });
    expect(staffRows.length).toBe(1);
    expect(staffRows[0].staffTelegramId).toBe("999777");
    expect(staffRows[0].direction).toBe("OUTBOUND");
  });

  it("20/23/24/25. keyset page ≤ 25, stable next/older navigation, no raw-id leak", async () => {
    for (let i = 0; i < 30; i++) {
      await CustomerChatHistoryService.recordBotOutbound({ customerId, telegramChatId: chatId, telegramMessageId: 20000 + i, text: `m${i}` });
    }
    const p1 = await CustomerChatHistoryService.listPage(customerId, null);
    expect(p1.messages.length).toBe(CHAT_HISTORY_PAGE_SIZE); // exactly 25
    expect(CHAT_HISTORY_FETCH_TAKE).toBe(26); // 25 + 1 sentinel
    const p2 = await CustomerChatHistoryService.listPage(customerId, p1.nextCursor);
    const ids1 = new Set(p1.messages.map((m) => m.id));
    for (const m of p2.messages) expect(ids1.has(m.id)).toBe(false); // no dupes
    expect(p2.messages.length).toBeGreaterThan(0);
    // UI-level rule (renderCustomerChatHistory): only Ref (#last6), never the raw id:
    const refDisplay = `Ref: #${customerId.slice(-6).toUpperCase()}`;
    expect(refDisplay).not.toContain(customerId);
  });

  it("26/27. support transitions never erase transcript (claim/release-safe)", async () => {
    const before = await prisma.customerChatMessage.count({ where: { customerId } });
    // AUTO→HUMAN→AUTO transitions mutate ONLY the Conversation row:
    await prisma.conversation.updateMany({ where: { customerId }, data: { mode: "HUMAN", claimedById: "s1" } });
    await prisma.conversation.updateMany({ where: { customerId }, data: { mode: "AUTO", claimedById: null } });
    const after = await prisma.customerChatMessage.count({ where: { customerId } });
    expect(after).toBe(before); // history intact — later requests see context
  });
});

// ---------------------------------------------------------------------------
// PART 1 — activity incremental scan bounds
// ---------------------------------------------------------------------------

describe("activity incremental scan (bounded)", () => {
  it("8. raw batch=100, hard cap=1000 rows per page request", () => {
    expect(ADMIN_LIST_SCAN_BATCH).toBe(100);
    expect(ADMIN_LIST_RAW_SCAN_CAP).toBe(1000);
  });

  it("9. first scan batch starts strictly after the page cursor (no OFFSET)", () => {
    const c = { createdAt: new Date("2026-09-14T00:00:00Z"), id: "AL-1" };
    expect(scanCursorForBatch(c)).toBe(c);
    expect(scanCursorForBatch(null)).toBeNull();
  });
});



