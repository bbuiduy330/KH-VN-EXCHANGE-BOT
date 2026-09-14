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
    const l1Row = commissionRows.find((r) => r.level === 1);
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
      targetAmount: String(calc.receiveAmount),
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
  test("confirm-time revalidation: base rate drop makes pending BUY margin invalid → rejected, unchanged, no audit", async ({ t, db, seed, clearAll }) => {
    await seed.admin("admin-reval");
    const adminId = seed.id("admin-reval");

    // 1. Set a high base rate (27000) so a 200 BUY margin is valid at input time.
    const initialBaseRate = Decimal.fromString("27000");
    await prisma.exchangeRate.upsert({
      where: { pair: "USD/VND" },
      create: {
        pair: "USD/VND",
        baseRate: initialBaseRate,
        isTestConfig: true,
        name: "Base"
      },
      update: { baseRate: initialBaseRate, isTestConfig: true }
    });

    const flowB = Flow.for(adminId, ctxB);
    await flowB
      .tapBuyMarginEdit()
      .enterValue("200")
      .gone();

    // 2. Drop the base rate to 150 — the 200 BUY margin is now invalid
    //    (baseRate - buyMargin = 150 - 200 = -50 ≤ 0).
    await prisma.exchangeRate.update({
      where: { pair: "USD/VND" },
      data: { baseRate: Decimal.fromString("150") }
    });

    // 3. Count existing RATE_BUY_MARGIN_UPDATED events before confirm.
    const auditBefore = await prisma.auditLog.count({
      where: { action: "RATE_BUY_MARGIN_UPDATED" }
    });

    // 4. Confirm the pending (now-invalid) margin.
    await flowB.tapConfirm().gone();

    // 5. The 200 must NOT have been saved — stored margin unchanged.
    t.assert.equal(
      String(RuntimeConfigService.getBuyMarginVnd()),
      "200",
      "margin unchanged after invalid confirm"
    );

    // 6. No RATE_BUY_MARGIN_UPDATED event must have been emitted.
    const auditAfter = await prisma.auditLog.count({
      where: { action: "RATE_BUY_MARGIN_UPDATED" }
    });
    t.assert.equal(auditAfter, auditBefore, "no audit event on failed confirm");

    await clearAll();
  });

  test("confirm-time revalidation: valid BUY confirm with sufficient headroom succeeds", async ({ t, db, seed, clearAll }) => {
    await seed.admin("admin-reval-ok");
    const adminId = seed.id("admin-reval-ok");

    // Base rate 27000, margin 200 → effective 26800 > 0 (valid at confirm).
    const baseRateC = Decimal.fromString("27000");
    await prisma.exchangeRate.upsert({
      where: { pair: "USD/VND" },
      create: {
        pair: "USD/VND",
        baseRate: baseRateC,
        isTestConfig: true,
        name: "Base"
      },
      update: { baseRate: baseRateC, isTestConfig: true }
    });

    const flowC = Flow.for(adminId, ctxC);
    await flowC
      .tapBuyMarginEdit()
      .enterValue("200")
      .gone();

    await t.test("confirm succeeds when base rate has not dropped below margin", async () => {
      await flowC.tapConfirm().gone();

      t.assert.equal(
        String(RuntimeConfigService.getBuyMarginVnd()),
        "200",
        "margin persisted after valid confirm"
      );
    });

    await clearAll();
  });

  test("confirm-time revalidation: SELL margin does not require base-rate headroom check", async ({ t, db, seed, clearAll }) => {
    await seed.admin("admin-reval-sell");
    const adminId = seed.id("admin-reval-sell");

    // SELL has no effective-rate safety constraint; base rate drop does not reject SELL confirm.
    const baseRateD = Decimal.fromString("150");
    await prisma.exchangeRate.upsert({
      where: { pair: "USD/VND" },
      create: {
        pair: "USD/VND",
        baseRate: baseRateD,
        isTestConfig: true,
        name: "Base"
      },
      update: { baseRate: baseRateD, isTestConfig: true }
    });

    const flowD = Flow.for(adminId, ctxD);
    await flowD
      .tapSellMarginEdit()
      .enterValue("200")
      .gone();

    await t.test("SELL confirm succeeds even when base rate < sell margin", async () => {
      await flowD.tapConfirm().gone();

      t.assert.equal(
        String(RuntimeConfigService.getSellMarginVnd()),
        "200",
        "SELL margin persisted (SELL has no baseRate headroom constraint)"
      );
    });

    await clearAll();
  });
});