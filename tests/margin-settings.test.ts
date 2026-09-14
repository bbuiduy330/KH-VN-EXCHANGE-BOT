/**
 * Admin-configurable USD/VND buy/sell margins (SystemSetting) tests.
 *
 * The margins live in RuntimeConfigService (SystemSetting KV) and are the
 * SOURCE OF TRUTH for the USD/VND pair:
 *   - Quote/order calculations read the configured margins AT CREATION TIME
 *     (snapshot frozen — later changes never rewrite history, and PENDING
 *     quotes are NOT invalidated — that only happens on a rate change).
 *   - Non-USD/VND pairs fall back to their own ExchangeRate-row margins.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { inMemoryStore, prisma } from "../src/database/client.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { computeCommissionableSpread } from "../src/modules/partner/partner-hierarchy.js";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import {
  startBuyMarginEdit,
  startSellMarginEdit,
  handleMarginWizardInput,
  confirmMarginChange
} from "../src/bot/admin/admin-rates.js";
import { getAdminSession, clearWizard } from "../src/bot/admin/admin-session.js";

const uniqueId = () => `margintest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(async () => {
  inMemoryStore.exchangeRates.clear();
  inMemoryStore.quotes.clear();
  inMemoryStore.orders.clear();
  inMemoryStore.systemSettings.clear();
  // Reload the runtime cache from the (now empty) SystemSetting store so
  // every test starts from the documented 200/200 defaults.
  await RuntimeConfigService.init();
});

describe("RuntimeConfigService margin getters/setters", () => {
  it("defaults to 200/200 when unconfigured", () => {
    expect(RuntimeConfigService.getBuyMarginVnd().toString()).toBe("200");
    expect(RuntimeConfigService.getSellMarginVnd().toString()).toBe("200");
  });

  it("persists values to SystemSetting and returns Decimal", async () => {
    await RuntimeConfigService.setBuyMarginVnd(350, "TEST");
    await RuntimeConfigService.setSellMarginVnd(420, "TEST");

    expect(RuntimeConfigService.getBuyMarginVnd().toString()).toBe("350");
    expect(RuntimeConfigService.getSellMarginVnd().toString()).toBe("420");

    const buyRow = await prisma.systemSetting.findUnique({ where: { key: "buyMarginVnd" } });
    const sellRow = await prisma.systemSetting.findUnique({ where: { key: "sellMarginVnd" } });
    expect(buyRow?.value).toBe("350");
    expect(sellRow?.value).toBe("420");
    expect(buyRow?.updatedBy).toBe("TEST");
  });

  it("accepts string values too", async () => {
    await RuntimeConfigService.setBuyMarginVnd("180", "TEST");
    await RuntimeConfigService.setSellMarginVnd("220", "TEST");
    expect(RuntimeConfigService.getBuyMarginVnd().toNumber()).toBe(180);
    expect(RuntimeConfigService.getSellMarginVnd().toNumber()).toBe(220);
  });
});

describe("Quote calculation uses the configured margins for USD/VND", () => {
  it("USD → VND applies the SystemSetting buyMargin (row margin ignored)", async () => {
    await RuntimeConfigService.setBuyMarginVnd(50, "TEST");
    await RuntimeConfigService.setSellMarginVnd(150, "TEST");
    // Row margins are deliberately 0 — the system settings must win.
    await QuoteService.setRateAndInvalidate("USD/VND", 25450, 0, 0, 2, "USD", "admin-1", "SUPER_ADMIN");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    // effectiveBuy = base 25450 − buy 50 = 25400
    expect(Number(quote.effectiveRate)).toBe(25400);
  });

  it("VND → USD applies the SystemSetting sellMargin", async () => {
    await RuntimeConfigService.setBuyMarginVnd(50, "TEST");
    await RuntimeConfigService.setSellMarginVnd(150, "TEST");
    await QuoteService.setRateAndInvalidate("USD/VND", 25450, 0, 0, 2, "USD", "admin-1", "SUPER_ADMIN");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuoteFromTarget(customer.id, "VND", "USD", 100);
    // effectiveSell = 25450 + 150 = 25600 → rate = 1/25600
    expect(Number(quote.effectiveRate)).toBeCloseTo(1 / 25600, 12);
  });

  it("non-USD/VND pairs keep their ExchangeRate-row margins", async () => {
    // System settings should be irrelevant for non-USD/VND pairs.
    await RuntimeConfigService.setBuyMarginVnd(999, "TEST");
    await RuntimeConfigService.setSellMarginVnd(999, "TEST");
    inMemoryStore.exchangeRates.set("VND/KHR", {
      id: uniqueId(),
      pair: "VND/KHR",
      baseRate: 0.16,
      buyMargin: 0.002,
      sellMargin: 0.002,
      fee: 50000,
      feeCurrency: "VND",
      updatedBy: "test",
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const calc = await QuoteService.calculateQuote("VND", "KHR", 1_000_000);
    // effectiveBuy = 0.16 − 0.002 = 0.158 (row margin, NOT the 999 setting)
    expect(calc.effectiveRate.toNumber()).toBeCloseTo(0.158, 10);
  });
});

describe("Snapshot safety — existing quotes/orders are frozen", () => {
  it("changing margins does not rewrite existing quotes nor invalidate PENDING", async () => {
    await RuntimeConfigService.setBuyMarginVnd(50, "TEST");
    await RuntimeConfigService.setSellMarginVnd(100, "TEST");
    await QuoteService.setRateAndInvalidate("USD/VND", 25450, 0, 0, 2, "USD", "admin-1", "SUPER_ADMIN");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    expect(Number(quote.effectiveRate)).toBe(25400);

    // Margin change — PENDING quotes stay valid, amounts/snapshots unchanged.
    await RuntimeConfigService.setBuyMarginVnd(500, "TEST");
    const stored = await QuoteService.getQuoteById(quote.id);
    expect(new Date(stored!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(Number(stored!.effectiveRate)).toBe(25400);

    // New quotes use the new margin.
    const quote2 = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    expect(Number(quote2.effectiveRate)).toBe(25450 - 500);
  });

  it("freezes the configured margins into the Order rateMarginSnapshot", async () => {
    await RuntimeConfigService.setBuyMarginVnd(50, "TEST");
    await RuntimeConfigService.setSellMarginVnd(100, "TEST");
    await QuoteService.setRateAndInvalidate("USD/VND", 25450, 10, 20, 2, "USD", "admin-1", "SUPER_ADMIN");

    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const calc = await QuoteService.calculateQuote("USD", "VND", 100);
    const order = await OrderService.createOrderFromQuote(customer.id, calc);

    expect(order.rateMarginSnapshot.buyMargin).toBe("50");
    expect(order.rateMarginSnapshot.sellMargin).toBe("100");
    expect(order.rateMarginSnapshot.baseRate).toBe(String(25450));

    // A later margin change must NOT rewrite the frozen order snapshot.
    await RuntimeConfigService.setBuyMarginVnd(999, "TEST");
    await RuntimeConfigService.setSellMarginVnd(999, "TEST");
    const stored = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stored!.rateMarginSnapshot.buyMargin).toBe("50");
    expect(stored!.rateMarginSnapshot.sellMargin).toBe("100");
  });

  it("freezes buyMargin=300 into Order snapshot and drives CTV L1 spread commission", async () => {
    // Configure buyMarginVnd = 300 (well above default 200)
    await RuntimeConfigService.setBuyMarginVnd(300, "TEST");
    await RuntimeConfigService.setSellMarginVnd(200, "TEST");
    await QuoteService.setRateAndInvalidate("USD/VND", 25450, 0, 0, 2, "USD", "admin-1", "SUPER_ADMIN");

    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const calc = await QuoteService.calculateQuote("USD", "VND", 100);
    const order = await OrderService.createOrderFromQuote(customer.id, calc);

    // --- Set up L1 partner and materialize commission via onOrderCompleted ---
    const l1Partner = await PartnerService.createPartner("admin-ctv", uniqueId().slice(-6));
    await prisma.order.update({ where: { id: order.id }, data: { partnerId: l1Partner.id } });

    await PartnerService.onOrderCompleted(order.id);

    const commissionRows = await prisma.commission.findMany({
      where: { orderId: order.id },
      orderBy: { level: "asc" }
    });
    const l1Row = commissionRows.find((r: any) => r.level === 1);
    expect(l1Row).toBeTruthy();
    void l1Row;

    // Order.rateMarginSnapshot.buyMargin must be frozen at "300"
    expect(order.rateMarginSnapshot.buyMargin).toBe("300");
    expect(order.rateMarginSnapshot.sellMargin).toBe("200");
    expect(order.rateMarginSnapshot.baseRate).toBe(String(25450));

    // ComputeCommissionableSpread must use the frozen 300 basis, NOT the current config.
    // With buyMargin=300: spreadVnd = 100 × 300 = 30000; commissionable = 30000 / 25450.
    // L1 spread share (20%) = 0.2 × 30000 / 25450.
    const { shareUsd, basis } = await computeCommissionableSpread({
      sourceCurrency: "USD",
      sourceAmount: "100",
      targetCurrency: "VND",
      targetAmount: String(calc.targetAmount),
      rateMarginSnapshot: order.rateMarginSnapshot
    });

    expect(basis!.direction).toBe("USD_TO_VND");
    // 0.2 × 30000 / 25450 = 6000 / 25450 ≈ 0.235756
    expect(Number(shareUsd).toFixed(6)).toBe("0.235756");

    // The L1 commission row's spreadBonusUsd must match the frozen calculation.
    // This proves the ACTUAL commission materialized from the frozen 300 basis.
    const l1Commission = await prisma.commission.findFirst({
      where: { orderId: order.id, level: 1 }
    });
    expect(l1Commission).toBeTruthy();
    const expectedSpreadBonus = Number(shareUsd);
    expect(Number(l1Commission!.spreadBonusUsd)).toBeCloseTo(expectedSpreadBonus, 6);

    // Change current buyMarginVnd AFTER the Order/Commission were created.
    await RuntimeConfigService.setBuyMarginVnd(50, "TEST");

    // The existing Order snapshot must NOT change — still frozen at 300.
    const stored = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stored!.rateMarginSnapshot.buyMargin).toBe("300");

    // The Order must still be COMPLETED (status unchanged).
    expect(stored!.status).toBe("COMPLETED");

    // The existing L1 Commission row MUST NOT be recomputed.
    // spreadBonusUsd remains at the frozen value derived from buyMargin=300.
    const l1CommissionAfter = await prisma.commission.findFirst({
      where: { orderId: order.id, level: 1 }
    });
    expect(l1CommissionAfter).toBeTruthy();
    expect(Number(l1CommissionAfter!.spreadBonusUsd)).toBeCloseTo(expectedSpreadBonus, 6);
    expect(Number(l1CommissionAfter!.baseCommissionUsd)).toBe(1);
  });

  it("rejects invalid margins at the setter level (negative, decimal, >10000)", async () => {
    // Negative
    await expect(RuntimeConfigService.setBuyMarginVnd(-5, "TEST")).rejects.toThrow(/Không được âm/);
    // Decimal
    await expect(RuntimeConfigService.setBuyMarginVnd(200.5, "TEST")).rejects.toThrow(/số nguyên/);
    // > 10,000
    await expect(RuntimeConfigService.setBuyMarginVnd(10001, "TEST")).rejects.toThrow(/tối đa 10.000/);
    // Text/NaN
    await expect(RuntimeConfigService.setBuyMarginVnd("abc", "TEST")).rejects.toThrow(/Không phải số hợp lệ/);
    // Range boundaries: 0 and 10000 should be accepted
    await RuntimeConfigService.setBuyMarginVnd(0, "TEST");
    expect(RuntimeConfigService.getBuyMarginVnd().toNumber()).toBe(0);
    await RuntimeConfigService.setBuyMarginVnd(10000, "TEST");
    expect(RuntimeConfigService.getBuyMarginVnd().toNumber()).toBe(10000);
  });

  it("rejects BUY margin when baseRate - buyMargin <= 0", async () => {
    // Set a low baseRate so that baseRate - buyMargin <= 0 can be tested
    await QuoteService.setRateAndInvalidate("USD/VND", 250, 0, 0, 2, "USD", "admin-1", "SUPER_ADMIN");
    await expect(RuntimeConfigService.setBuyMarginVnd(300, "TEST")).rejects.toThrow(/Effective buy rate phải > 0/);
  });

  it("BUY edit only changes BUY, not SELL", async () => {
    await RuntimeConfigService.setBuyMarginVnd(100, "TEST");
    await RuntimeConfigService.setSellMarginVnd(200, "TEST");

    // Simulate BUY-only edit using setter (same validation as UI flow)
    await RuntimeConfigService.setBuyMarginVnd(350, "TEST");

    expect(RuntimeConfigService.getBuyMarginVnd().toNumber()).toBe(350);
    // SELL should remain unchanged
    expect(RuntimeConfigService.getSellMarginVnd().toNumber()).toBe(200);
  });

  it("SELL edit only changes SELL, not BUY", async () => {
    await RuntimeConfigService.setBuyMarginVnd(100, "TEST");
    await RuntimeConfigService.setSellMarginVnd(200, "TEST");

    await RuntimeConfigService.setSellMarginVnd(400, "TEST");

    expect(RuntimeConfigService.getSellMarginVnd().toNumber()).toBe(400);
    expect(RuntimeConfigService.getBuyMarginVnd().toNumber()).toBe(100);
  });
});

describe("Confirm-time revalidation", () => {
  // ── Financial safety #2: Confirm-time revalidation
  //
  // If the current base rate changes between Admin input/preview and Confirm,
  // the previously-valid BUY margin may become invalid (effective rate ≤ 0).
  // Confirm must be rejected and the stored margin must be UNCHANGED.
  // A failed Confirm must NOT emit a RATE_BUY_MARGIN_UPDATED audit event.
  //
  // These tests drive the REAL wizard functions end-to-end
  // (start*MarginEdit → handleMarginWizardInput → confirmMarginChange) with a
  // fake Admin ctx, exactly like the other runtime-level tests.

  /** Fake Admin ctx — same shape as the other router-level runtime tests. */
  function fakeAdminCtx(adminTg: string): { ctx: any; replies: any[] } {
    const replies: any[] = [];
    return {
      ctx: {
        from: { id: Number(adminTg), is_bot: false, first_name: "Admin" },
        chat: { id: Number(adminTg), type: "private" },
        reply: async (text: string, opts?: any) => {
          replies.push({ text, opts });
          return { message_id: replies.length };
        },
        answerCallbackQuery: async () => true
      },
      replies
    };
  }

  /** Real grant: an ACTIVE ADMIN holding exactly `rate.edit`. */
  async function armAdmin(adminTg: string): Promise<void> {
    await PermissionService.inviteStaff({
      telegramId: adminTg,
      name: "Margin Admin",
      role: "ADMIN",
      permissions: ["rate.edit"]
    });
  }

  /** The authoritative USD/VND base rate the Confirm path re-reads. */
  async function setUsdVndBaseRate(baseRate: number): Promise<void> {
    await prisma.exchangeRate.upsert({
      where: { pair: "USD/VND" },
      update: { baseRate },
      create: { pair: "USD/VND", baseRate, buyMargin: 0, sellMargin: 0, fee: 2, feeCurrency: "USD" }
    });
  }

  /** Audit rows for one action (findMany — the test store has no COUNT). */
  async function auditCount(action: string): Promise<number> {
    const rows = await prisma.auditLog.findMany({ where: { action } });
    return rows.length;
  }

  it("base rate drop invalidates a pending BUY margin at Confirm → rejected, unchanged, no audit", async () => {
    const adminTg = "887700101";
    await armAdmin(adminTg);

    // 1. High base rate (27000) so a 200 BUY margin is valid at input time.
    await setUsdVndBaseRate(27000);
    // Stored BUY margin = 100 → "unchanged by the failed Confirm" is observable.
    await RuntimeConfigService.setBuyMarginVnd(100, "TEST");

    const { ctx, replies } = fakeAdminCtx(adminTg);
    await startBuyMarginEdit(ctx);
    await handleMarginWizardInput(ctx, "200");
    expect(getAdminSession(adminTg).wizard?.step).toBe(2);

    // 2. Drop the base rate to 150 — the 200 BUY margin is now invalid
    //    (baseRate − buyMargin = 150 − 200 = −50 ≤ 0).
    await setUsdVndBaseRate(150);

    // 3. Count RATE_BUY_MARGIN_UPDATED events before Confirm.
    const auditBefore = await auditCount("RATE_BUY_MARGIN_UPDATED");

    // 4. Confirm the pending (now-invalid) margin.
    await confirmMarginChange(ctx);

    // 5. The 200 must NOT have been saved — stored margin unchanged.
    expect(RuntimeConfigService.getBuyMarginVnd().toString()).toBe("100");

    // 6. No RATE_BUY_MARGIN_UPDATED event may have been emitted.
    expect(await auditCount("RATE_BUY_MARGIN_UPDATED")).toBe(auditBefore);

    // 7. The Admin was told WHY — never a silent rejection.
    expect(replies.some((r) => String(r.text).includes("không còn hợp lệ"))).toBe(true);

    clearWizard(adminTg);
  });

  it("valid BUY confirm with sufficient headroom persists the margin and audits it", async () => {
    const adminTg = "887700102";
    await armAdmin(adminTg);

    // Base rate stays at 27000: 27000 − 200 = 26800 > 0 → valid at Confirm.
    await setUsdVndBaseRate(27000);
    const auditBefore = await auditCount("RATE_BUY_MARGIN_UPDATED");

    const { ctx } = fakeAdminCtx(adminTg);
    await startBuyMarginEdit(ctx);
    await handleMarginWizardInput(ctx, "200");
    await confirmMarginChange(ctx);

    expect(RuntimeConfigService.getBuyMarginVnd().toString()).toBe("200");
    expect(await auditCount("RATE_BUY_MARGIN_UPDATED")).toBe(auditBefore + 1);

    clearWizard(adminTg);
  });

  it("SELL confirm needs no base-rate headroom and still audits its own action", async () => {
    const adminTg = "887700103";
    await armAdmin(adminTg);

    // 1. Healthy base rate so the preview renders (effectiveBuy must be > 0).
    await setUsdVndBaseRate(27000);
    const auditBefore = await auditCount("RATE_SELL_MARGIN_UPDATED");

    const { ctx } = fakeAdminCtx(adminTg);
    await startSellMarginEdit(ctx);
    await handleMarginWizardInput(ctx, "200");
    expect(getAdminSession(adminTg).wizard?.step).toBe(2);

    // 2. Drop the base rate BELOW the sell margin (150 < 200). SELL has no
    //    effective-rate headroom constraint, so Confirm must still pass.
    await setUsdVndBaseRate(150);

    await confirmMarginChange(ctx);

    expect(RuntimeConfigService.getSellMarginVnd().toString()).toBe("200");
    expect(await auditCount("RATE_SELL_MARGIN_UPDATED")).toBe(auditBefore + 1);

    clearWizard(adminTg);
  });
});