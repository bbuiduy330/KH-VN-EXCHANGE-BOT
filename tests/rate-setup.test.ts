import { describe, it, expect, beforeEach } from "vitest";
import { inMemoryStore } from "../src/database/client.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { parseNonNegativeInteger } from "../src/bot/admin/admin-rates.js";

/**
 * Fresh-DB first USD/VND rate setup — service-level, deterministic tests.
 *
 * The unit harness has no grammy-ctx mocking by design (see phase-a.test.ts):
 * handler-level wizard screens/keyboards are exercised on the VPS. Here we
 * verify the authoritative service path and customer safety around the
 * missing-rate state.
 *
 * NOTE: no test seeds or asserts any specific "correct" financial rate — the
 * values below are arbitrary test fixtures, not business guidance.
 */

const uniqueId = () => `ratesetup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(() => {
  inMemoryStore.exchangeRates.clear();
  inMemoryStore.quotes.clear();
});

describe("Fresh DB — customer safety before any rate exists", () => {
  it("quote requests fail safely: no crash, no fake/default rate, localized error", async () => {
    expect(await QuoteService.getRate("USD/VND")).toBeNull();

    // Source-side intent (USD → VND)
    await expect(
      QuoteService.createQuote("no-customer", "USD", "VND", 100)
    ).rejects.toThrow(/Chưa thiết lập tỷ giá/);

    // Target-side intent (VND → USD)
    await expect(
      QuoteService.createQuoteFromTarget("no-customer", "VND", "USD", 100)
    ).rejects.toThrow(/Chưa thiết lập tỷ giá/);

    // Nothing was persisted.
    expect(inMemoryStore.quotes.size).toBe(0);
  });
});

describe("Fresh DB — admin creates the first USD/VND rate", () => {
  it("create goes through the authoritative setRateAndInvalidate upsert and is immediately readable", async () => {
    expect(await QuoteService.getRate("USD/VND")).toBeNull();

    const res = await QuoteService.setRateAndInvalidate(
      "USD/VND", 25450, 50, 100, 2, "USD", "admin-1", "SUPER_ADMIN"
    );

    expect(res.invalidatedCount).toBe(0);
    expect(Number(res.rate.baseRate)).toBe(25450);

    const saved = await QuoteService.getRate("USD/VND");
    expect(saved).not.toBeNull();
    expect(Number(saved!.baseRate)).toBe(25450);
    expect(Number(saved!.buyMargin)).toBe(50);
    expect(Number(saved!.sellMargin)).toBe(100);
    expect(Number(saved!.fee)).toBe(2);
    expect(saved!.feeCurrency).toBe("USD");
  });

  it("after the first rate exists, the normal customer quote flow works", async () => {
    await QuoteService.setRateAndInvalidate(
      "USD/VND", 25450, 50, 100, 2, "USD", "admin-1", "SUPER_ADMIN"
    );
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    expect(quote.status).toBe("PENDING");
    // effectiveBuy = base 25450 − buyMargin 50 = 25400
    expect(Number(quote.effectiveRate)).toBe(25400);
  });
});

describe("Later rate updates still invalidate PENDING quotes", () => {
  it("a rate change after first setup expires PENDING quotes and new quotes use the new rate", async () => {
    await QuoteService.setRateAndInvalidate(
      "USD/VND", 25450, 50, 100, 2, "USD", "admin-1", "SUPER_ADMIN"
    );
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);

    const res = await QuoteService.setRateAndInvalidate(
      "USD/VND", 26000, 50, 100, 2, "USD", "admin-1", "ADMIN"
    );
    expect(res.invalidatedCount).toBeGreaterThanOrEqual(1);

    // No active quote anymore.
    const active = await QuoteService.getLatestActiveQuote(customer.id);
    expect(active).toBeNull();

    // Snapshot preserved, only expiry truncated.
    const stored: any = inMemoryStore.quotes.get(quote.id);
    expect(stored.status).toBe("PENDING");
    expect(new Date(stored.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());

    // New quote uses the updated rate: 26000 − 50 = 25950
    const quote2 = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    expect(Number(quote2.effectiveRate)).toBe(25950);
  });
});

describe("First-time-setup margin/fee parser", () => {
  it("parseNonNegativeInteger is deterministic and rejects ambiguous input", () => {
    expect(parseNonNegativeInteger("50")).toBe(50);
    expect(parseNonNegativeInteger("0")).toBe(0);
    expect(parseNonNegativeInteger(" 100 ")).toBe(100);
    expect(parseNonNegativeInteger("1.000")).toBeNull();
    expect(parseNonNegativeInteger("1,000")).toBeNull();
    expect(parseNonNegativeInteger("-5")).toBeNull();
    expect(parseNonNegativeInteger("abc")).toBeNull();
    expect(parseNonNegativeInteger("")).toBeNull();
  });
});
