/**
 * Transparent quote breakdown tests — financial matrix + all 4 locales.
 *
 * Covers the production rules:
 *   - The displayed rate is the Quote's OWN frozen effective rate, NEVER
 *     sourceAmount/targetAmount (fee + rounding make that ratio wrong).
 *   - SOURCE_FIXED: the customer's given amount is frozen exactly; the service
 *     fee is absorbed from the USD side (deducted BEFORE conversion when the
 *     source is USD, deducted from the converted amount when the target is USD).
 *   - TARGET_FIXED: the requested target is frozen EXACTLY and never recomputed
 *     from the rounded payer amount; the fee is added on top of the payer.
 *   - The fee is read from the authoritative rate row (fixture uses 3 USD) and
 *     frozen with the quote — never hard-coded.
 *   - Every locale renders the SAME underlying numbers; only labels differ.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { inMemoryStore } from "../src/database/client.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { renderQuoteCard } from "../src/bot/menus/customer-menu.js";
import { resolveLocale, t } from "../src/modules/i18n/locales.js";

const uniqueId = () => `qttest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(async () => {
  inMemoryStore.exchangeRates.clear();
  inMemoryStore.quotes.clear();
  inMemoryStore.orders.clear();
  inMemoryStore.systemSettings.clear();
  await RuntimeConfigService.init();
});

/** Seed the USD/VND rate with margins 0 (effective == base) and fee 3 USD. */
async function seedRate(baseRate: number) {
  await RuntimeConfigService.setBuyMarginVnd(0, "TEST");
  await RuntimeConfigService.setSellMarginVnd(0, "TEST");
  await QuoteService.setRateAndInvalidate(
    "USD/VND",
    baseRate,
    0,
    0,
    3,
    "USD",
    "admin-1",
    "SUPER_ADMIN"
  );
}

/** Strict narrowing for nullable USD breakdown values (no `!` assertions). */
function usd(v: Decimal | null, label: string): Decimal {
  if (v === null) throw new Error(`Expected a frozen ${label} on the quote`);
  return v;
}

describe("Financial matrix (Decimal, authoritative fee from the rate row)", () => {
  it("A. SOURCE_FIXED VND->USD: source stays exactly 2,000,000; net = 74.22; displayed rate = 25,900", async () => {
    await seedRate(25900);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuote(customer.id, "VND", "USD", 2_000_000);

    expect(quote.rateSide).toBe("SOURCE_FIXED");
    expect(quote.sourceAmount.toString()).toBe("2000000");
    expect(quote.targetAmount.toNumber()).toBeCloseTo(74.22, 2);
    // Authoritative frozen display rate — NOT the source/target ratio (~0.0000371).
    expect(quote.displayRate.toNumber()).toBeCloseTo(25900, 6);
    expect(usd(quote.conversionUsd, "conversionUsd").toNumber()).toBeCloseTo(77.220077, 4);
    expect(usd(quote.feeUsd, "feeUsd").toNumber()).toBe(3);
  });

  it("B. TARGET_FIXED USD->VND: target stays EXACTLY 2,000,000; payer rounds up to 81.13", async () => {
    await seedRate(25600);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuoteFromTarget(customer.id, "USD", "VND", 2_000_000);

    expect(quote.rateSide).toBe("TARGET_FIXED");
    // The fixed target is NEVER recomputed from the rounded payer amount
    // (the old bug produced 2,000,100 / 2,000,128 VND).
    expect(quote.targetAmount.toString()).toBe("2000000");
    expect(quote.sourceAmount.toNumber()).toBe(81.13);
    expect(usd(quote.payerAmountExact, "payerAmountExact").toString()).toBe("81.125");
    expect(usd(quote.conversionUsd, "conversionUsd").toString()).toBe("78.125");
    expect(quote.displayRate.toNumber()).toBe(25600);
  });

  it("C. SOURCE_FIXED USD->VND: source stays exactly 100; principal 97 -> 2,483,200 VND", async () => {
    await seedRate(25600);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);

    expect(quote.sourceAmount.toString()).toBe("100");
    expect(quote.targetAmount.toString()).toBe("2483200");
    // Fee absorbed from the USD principal BEFORE conversion: 100 - 3 = 97.
    expect(usd(quote.conversionUsd, "conversionUsd").toString()).toBe("97");
    expect(quote.displayRate.toNumber()).toBe(25600);
    expect(usd(quote.feeUsd, "feeUsd").toNumber()).toBe(3);
  });

  it("D. TARGET_FIXED VND->USD: target stays exactly 100; funding = 2,667,700 VND", async () => {
    await seedRate(25900);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuoteFromTarget(customer.id, "VND", "USD", 100);

    expect(quote.targetAmount.toString()).toBe("100");
    expect(quote.sourceAmount.toString()).toBe("2667700");
    expect(usd(quote.conversionUsd, "conversionUsd").toNumber()).toBe(100);
    expect(quote.displayRate.toNumber()).toBeCloseTo(25900, 6);
  });
});

describe("Snapshot safety", () => {
  it("an existing quote keeps its frozen display rate after a later margin change", async () => {
    await seedRate(25900);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const quote = await QuoteService.createQuote(customer.id, "VND", "USD", 2_000_000);
    expect(quote.displayRate.toNumber()).toBeCloseTo(25900, 6);

    // Admin changes the margin afterwards — the stored quote must not move.
    await RuntimeConfigService.setBuyMarginVnd(999, "TEST");
    await RuntimeConfigService.setSellMarginVnd(999, "TEST");

    expect(quote.displayRate.toNumber()).toBeCloseTo(25900, 6);
    expect(quote.sourceAmount.toString()).toBe("2000000");
    expect(quote.targetAmount.toNumber()).toBeCloseTo(74.22, 2);
  });

  it("SOURCE_FIXED amount too small to cover the fee → rejected, never a negative/zero target", async () => {
    await seedRate(25600); // fee = 3 USD
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    // USD source (2) < fee (3): (2-3) × 25,600 < 0.
    await expect(QuoteService.calculateQuote("USD", "VND", 2)).rejects.toThrow();
    await expect(QuoteService.createQuote(customer.id, "USD", "VND", 2)).rejects.toThrow();

    // VND source converts to less than the fee: 50,000/25,600 ≈ 1.95 < 3.
    await expect(QuoteService.createQuote(customer.id, "VND", "USD", 50_000)).rejects.toThrow();

    // Exactly-covering boundary still works: (4-3) × 25,600 = 25,600 VND.
    const ok = await QuoteService.createQuote(customer.id, "USD", "VND", 4);
    expect(ok.targetAmount.toString()).toBe("25600");
    expect(ok.sourceAmount.toString()).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// Locale matrix — all four locales render the SAME numbers, different labels.
// Fixtures follow the existing repo test convention (baseQuote/fakeQuote use
// `as any` for prisma-row literals).
// ---------------------------------------------------------------------------
const sourceFixedRow = {
  id: "Q-SF",
  sourceCurrency: "VND",
  targetCurrency: "USD",
  sourceAmount: new Decimal("2000000"),
  targetAmount: new Decimal("74.22"),
  effectiveRate: new Decimal("0.00003861"),
  baseRate: new Decimal("25900"),
  fee: new Decimal("3"),
  feeCurrency: "USD",
  status: "PENDING",
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
  rateSide: "SOURCE_FIXED",
  displayRate: new Decimal("25900"),
  conversionUsd: new Decimal("77.22"),
  feeUsd: new Decimal("3"),
  payerAmountExact: null
} as any;

const targetFixedRow = {
  ...sourceFixedRow,
  id: "Q-TF",
  sourceCurrency: "USD",
  targetCurrency: "VND",
  sourceAmount: new Decimal("81.13"),
  targetAmount: new Decimal("2000000"),
  effectiveRate: new Decimal("25600"),
  displayRate: new Decimal("25600"),
  conversionUsd: new Decimal("78.125"),
  payerAmountExact: new Decimal("81.125"),
  rateSide: "TARGET_FIXED"
} as any;

const hasScript = (s: string, lo: number, hi: number): boolean =>
  [...s].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= lo && cp <= hi;
  });

const LOCALES = ["vi", "en", "km", "zh"] as const;

describe("Transparent quote card renders in all 4 locales", () => {
  it("SOURCE_FIXED: correct localized labels, identical numbers, no mojibake", () => {
    for (const loc of LOCALES) {
      const card = renderQuoteCard(sourceFixedRow, 10, loc);

      // Identical underlying numbers in every locale.
      expect(card).toContain("2 000 000 VND");
      expect(card).toContain("74.22 USD");
      expect(card).toContain("1 USD = 25 900 VND");
      expect(card).toContain("77.22 USD");
      expect(card).toContain("-3.00 USD");

      // The renderer used the right key with the right args for this locale.
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.rate", { rate: "1 USD = 25 900 VND" })
      );
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.conversion", { amount: "77.22 USD" })
      );
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.fee_minus", { fee: "3.00 USD" })
      );
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.net_received", { amount: "74.22 USD" })
      );

      // Script sanity for the non-Latin locales; no replacement chars anywhere.
      if (loc === "km") expect(hasScript(card, 0x1780, 0x17ff)).toBe(true);
      if (loc === "zh") expect(hasScript(card, 0x4e00, 0x9fff)).toBe(true);
      expect(card).not.toContain("\uFFFD");
    }
  });

  it("TARGET_FIXED: total-to-pay + safe rounding shown; target stays exact", () => {
    for (const loc of LOCALES) {
      const card = renderQuoteCard(targetFixedRow, 10, loc);

      expect(card).toContain("81.13 USD");
      expect(card).toContain("2 000 000 VND");
      expect(card).toContain("1 USD = 25 600 VND");
      expect(card).toContain("78.125 USD");
      expect(card).toContain("+3.00 USD");
      expect(card).toContain("81.125 USD");

      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.total_to_pay", { amount: "81.125 USD" })
      );
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.payment_rounded", { amount: "81.13 USD" })
      );
      expect(card).toContain(
        t(resolveLocale(loc), "quote.line.customer_receives", { amount: "2 000 000 VND" })
      );

      // The exact requested target — never 2,000,100 / 2,000,128.
      expect(card).not.toContain("2 000 100");
      expect(card).not.toContain("2 000 128");

      if (loc === "km") expect(hasScript(card, 0x1780, 0x17ff)).toBe(true);
      if (loc === "zh") expect(hasScript(card, 0x4e00, 0x9fff)).toBe(true);
      expect(card).not.toContain("\uFFFD");
    }
  });

  it("legacy rows (breakdown columns NULL) keep the compact card", () => {
    const legacy = {
      id: "Q-LEG",
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: new Decimal("100"),
      targetAmount: new Decimal("2540000"),
      effectiveRate: new Decimal("25400"),
      baseRate: new Decimal("25450"),
      fee: new Decimal("2"),
      feeCurrency: "USD",
      status: "PENDING",
      expiresAt: new Date(Date.now() + 600_000),
      createdAt: new Date(),
      rateSide: null,
      displayRate: null,
      conversionUsd: null,
      feeUsd: null,
      payerAmountExact: null
    } as any;

    const card = renderQuoteCard(legacy, 10, "vi");
    expect(card).toContain("25 400");
    expect(card).not.toContain("77.22");
    expect(card).not.toContain("-3.00 USD");
  });

  it("footer still appends AFTER the financial breakdown section", () => {
    const card = renderQuoteCard(sourceFixedRow, 10, "vi");
    const breakdownEnd = card.indexOf("74.22 USD");
    const footerIdx = card.indexOf("──────────");
    expect(footerIdx).toBeGreaterThan(breakdownEnd);
  });
});

