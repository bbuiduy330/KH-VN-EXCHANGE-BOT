/**
 * Customer ACTIVE-ONLY orders + order-linked quick support tests.
 *
 * Product decision regression: customers have NO transaction-history browser.
 * - "My Orders" lists ACTIVE (non-terminal) orders only.
 * - COMPLETED/CANCELLED orders disappear from the customer list; the Telegram
 *   terminal messages (with canonical public Order Ref + quick-support button
 *   binding the internal Order.id) are the customer's receipt.
 * - Full history is STAFF-ONLY (Admin/CSKH CRM + generic-support context).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { requireCallbackButton } from "./helpers/callback-button.js";
import { inMemoryStore, prisma } from "../src/database/client.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { formatPublicOrderRef, orderPublicRef } from "../src/modules/orders/order-ref.js";
import { renderSupportRecentOrders, supportRequestKeyboard } from "../src/bot/notifications.js";
import { getCustomerMenuKeyboard, getCustomerReplyKeyboard } from "../src/bot/menus/customer-menu.js";
import { resolveLocale, t } from "../src/modules/i18n/locales.js";

const uniqueId = () => `acttest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(async () => {
  inMemoryStore.exchangeRates.clear();
  inMemoryStore.quotes.clear();
  inMemoryStore.orders.clear();
  inMemoryStore.systemSettings.clear();
  await RuntimeConfigService.init();
});

async function seedRate() {
  await RuntimeConfigService.setBuyMarginVnd(0, "TEST");
  await RuntimeConfigService.setSellMarginVnd(0, "TEST");
  await QuoteService.setRateAndInvalidate("USD/VND", 25600, 0, 0, 3, "USD", "admin-1", "SUPER_ADMIN");
}

async function makeOrder(customerId: string) {
  const calc = await QuoteService.calculateQuote("USD", "VND", 100);
  return OrderService.createOrderFromQuote(customerId, calc);
}

describe("Active Orders is ACTIVE-ONLY", () => {
  it("includes active orders and EXCLUDES COMPLETED and CANCELLED", async () => {
    await seedRate();
    const { customer } = { customer: await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() }) };

    const active = await makeOrder(customer.id);
    const completed = await makeOrder(customer.id);
    const cancelled = await makeOrder(customer.id);
    await prisma.order.update({ where: { id: completed.id }, data: { status: "COMPLETED" } });
    await prisma.order.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });

    const rows: any[] = await OrderService.getActiveOrdersForCustomer(customer.id, 10);
    expect(rows.map((o) => o.id)).toContain(active.id);
    expect(rows.map((o) => o.id)).not.toContain(completed.id);
    expect(rows.map((o) => o.id)).not.toContain(cancelled.id);
    // Every listed status is non-terminal.
    for (const o of rows) expect(["COMPLETED", "CANCELLED"]).not.toContain(o.status);
  });

  it("customer menus have NO transaction-history item (any locale)", () => {
    for (const loc of ["vi", "en", "km", "zh"] as const) {
      const inline = getCustomerMenuKeyboard(loc);
      const reply = getCustomerReplyKeyboard(loc);
      const inlineTexts = inline.inline_keyboard.flat().map((b) => b.text).join(" | ");
      expect(inlineTexts).not.toMatch(/Lịch sử|History|历史|ប្រវត្តិ/i);
      for (const row of reply.keyboard) {
        for (const b of row) expect(b.text).not.toMatch(/Lịch sử|History|历史|ប្រវត្តិ/i);
      }
      // No callback route into a customer history browser.
      const allCallbacks = inline.inline_keyboard.flat() .map((b) => requireCallbackButton(b).callback_data).join(" ");
      expect(allCallbacks).not.toContain("customer:history");
    }
  });
});

describe("Staff recent-order context (generic support) — public refs only", () => {
  it("includes latest transactions with canonical refs, NEVER raw Order.id", async () => {
    await seedRate();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const o1 = await makeOrder(customer.id);
    const o2 = await makeOrder(customer.id);
    await prisma.order.update({ where: { id: o2.id }, data: { status: "CANCELLED" } });

    const ctx = await renderSupportRecentOrders(customer.id);
    expect(ctx).toContain("Giao dịch gần nhất");
    expect(ctx).toContain(formatPublicOrderRef(o1));
    expect(ctx).toContain(formatPublicOrderRef(o2));
    expect(ctx).toContain("CANCELLED");
    // Raw internal Order.id must not leak through the recent-order section.
    expect(ctx).not.toContain(o1.id);
    expect(ctx).not.toContain(o2.id);
  });

  it("returns an empty string for a customer with no orders", async () => {
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    expect(await renderSupportRecentOrders(customer.id)).toBe("");
  });

  it("supportRequestKeyboard keeps staff history + claim buttons, id hidden from labels", async () => {
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const kb = await supportRequestKeyboard(customer.id);
    const labels = kb.inline_keyboard.flat().map((b: any) => String(b.text));
    expect(labels).toContain("📋 Giao dịch khách"); // STAFF-ONLY browser
    expect(labels).toContain("👤 Hồ sơ khách");
    expect(labels.join(" ")).not.toContain(customer.id);
  });
});

describe("Terminal messages + order-linked support identity", () => {
  it("cancel/completion message composition shows the canonical ref, never raw Order.id", async () => {
    await seedRate();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const order = await makeOrder(customer.id);
    const pub = formatPublicOrderRef(order);

    for (const loc of ["vi", "en", "km", "zh"] as const) {
      // Mirrors the production cancel-message call site.
      const cancelText = t(resolveLocale(loc), "order.cancel_success", { id: pub });
      expect(cancelText).toContain(pub);
      expect(cancelText).not.toContain(order.id);
      // Mirrors the production completion-receipt call site.
      const doneText = t(resolveLocale(loc), "order.completed_title", { id: orderPublicRef(order) });
      expect(doneText).toContain(`#${orderPublicRef(order)}`);
      expect(doneText).not.toContain(order.id);
      // Localized order-linked support confirmation (4 locales).
      const confirm = t(resolveLocale(loc), "support.requested_order", { id: pub });
      expect(confirm).toContain(pub);
      expect(confirm).not.toContain(order.id);
    }
  });

  it("transferMemo is NOT the Order Ref (bank memo only)", async () => {
    await seedRate();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const order: any = await makeOrder(customer.id);
    const pub = orderPublicRef(order);
    const memo = String(order.transferMemo || "");
    expect(memo).not.toBe(pub);
    expect(memo).not.toBe(formatPublicOrderRef(order));
  });

  it("support button label is fully localized (not universal English)", () => {
    const vi = t(resolveLocale("vi"), "payout.support_btn");
    const en = t(resolveLocale("en"), "payout.support_btn");
    const km = t(resolveLocale("km"), "payout.support_btn");
    const zh = t(resolveLocale("zh"), "payout.support_btn");
    for (const v of [vi, en, km, zh]) {
      expect(v).not.toBe("payout.support_btn"); // key resolved in every locale
      expect(v.length).toBeGreaterThan(0);
    }
    expect(vi).not.toBe(en);
  });

  it("repeated order-linked support clicks are idempotent (no duplicate session)", async () => {
    await seedRate();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const first = await ConversationService.requestHumanSupport(customer.id);
    const second = await ConversationService.requestHumanSupport(customer.id);
    expect(first.newRequest).toBe(true);
    expect(second.newRequest).toBe(false);
    // After release back to AUTO a NEW request is possible again.
    await ConversationService.releaseByCustomer(customer.id);
    const third = await ConversationService.requestHumanSupport(customer.id);
    expect(third.newRequest).toBe(true);
  });
});

