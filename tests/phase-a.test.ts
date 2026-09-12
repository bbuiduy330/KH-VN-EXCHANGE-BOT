import { describe, it, expect, beforeEach } from "vitest";
import { inMemoryStore } from "../src/database/client.js";
import { AiProvider } from "../src/modules/ai/ai-provider.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import {
  getCustomerMenuKeyboard,
  getBankWizardKeyboard,
  renderCustomerWelcomeText
} from "../src/bot/menus/customer-menu.js";

/**
 * Phase A — Customer transaction UX regression tests.
 *
 * Scope covered here (service level, deterministic — no Gemini):
 *  1. Target-amount intent: "đổi VND lấy 100 đô"  -> RECEIVE 100 USD (VND -> USD)
 *  2. Conversational correction: "ý anh là nhận 100 đô" -> same target-side intent
 *  3. Source-side intent unchanged: "10 triệu lấy $" -> 10 000 000 VND -> USD
 *  4. Target-quote arithmetic: closed-form inversion of the forward formula,
 *     reusing the exact rate/margin/fee rules of calculateQuote (25450 VND/USD,
 *     fee 2 USD) so the customer receives exactly the requested target amount.
 *  5. Main menu simplification: no receiving-account entry on the main menu;
 *     the bank wizard is reachable contextually and targets the order currency.
 *  6. Customer-facing welcome never mentions KHR (USD/VND only).
 *
 * Non-deterministic / handler-level behaviour (bill -> payout prompt, friendly
 * "desk account missing" error, callback acknowledgement order) is exercised on
 * the VPS; the unit harness has no grammy-ctx mocking by design.
 */

const uniqueId = () => `phasea-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(() => {
  inMemoryStore.exchangeRates.clear();
});

function seedUsdVndRate(): void {
  inMemoryStore.exchangeRates.set("USD/VND", {
    id: uniqueId(),
    pair: "USD/VND",
    baseRate: 25400,
    buyMargin: 50,
    sellMargin: 50,
    fee: 2,
    feeCurrency: "USD",
    updatedBy: "test",
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

describe("Phase A parser — target-amount and correction intents (local, no Gemini)", () => {
  it("parses 'đổi VND lấy 100 đô' as RECEIVE 100 USD (VND -> USD)", () => {
    const intent = AiProvider.parseLocalExchangeIntent("đổi VND lấy 100 đô");
    expect(intent).not.toBeNull();
    expect(intent!.amountSide).toBe("target");
    expect(intent!.sourceCurrency).toBe("VND");
    expect(intent!.targetCurrency).toBe("USD");
    expect(intent!.amount).toBe(100);
  });

  it("parses the conversational correction 'ý anh là nhận 100 đô'", () => {
    const intent = AiProvider.parseLocalExchangeIntent("ý anh là nhận 100 đô");
    expect(intent).not.toBeNull();
    expect(intent!.amountSide).toBe("target");
    expect(intent!.sourceCurrency).toBe("VND");
    expect(intent!.targetCurrency).toBe("USD");
    expect(intent!.amount).toBe(100);
  });

  it("keeps the source-side direction for '10 triệu lấy $'", () => {
    const intent = AiProvider.parseLocalExchangeIntent("10 triệu lấy $");
    expect(intent).not.toBeNull();
    expect(intent!.amountSide).toBe("source");
    expect(intent!.sourceCurrency).toBe("VND");
    expect(intent!.targetCurrency).toBe("USD");
    expect(intent!.amount).toBe(10000000);
  });
});

describe("Phase A target-quote arithmetic (MoneyService/QuoteService rules reused)", () => {
  it("computes the source amount so the customer receives exactly 100 USD", async () => {
    seedUsdVndRate();
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });

    const quote = await QuoteService.createQuoteFromTarget(customer.id, "VND", "USD", 100);

    expect(quote.sourceCurrency).toBe("VND");
    expect(quote.targetCurrency).toBe("USD");
    // effectiveSell = base 25400 + sellMargin 50 = 25450 VND per USD
    expect(Number(quote.effectiveRate)).toBe(25450);
    // (100 USD + 2 USD fee) * 25450 = 2 595 900 VND to send
    expect(Number(quote.sourceAmount)).toBeGreaterThanOrEqual(2595900);
    expect(Number(quote.sourceAmount)).toBeLessThanOrEqual(2600000);
    // The quoted receive amount is exactly the requested target
    expect(Number(quote.targetAmount)).toBe(100);
  });

  it("throws a customer-safe error when no rate is configured", async () => {
    await expect(
      QuoteService.createQuoteFromTarget("no-customer", "VND", "USD", 100)
    ).rejects.toThrow(/Chưa thiết lập tỷ giá/);
  });
});

describe("Phase A menu simplification and USD/VND-only surfaces", () => {
  it("main customer menu no longer contains the receiving-account entry", () => {
    const json = JSON.stringify(getCustomerMenuKeyboard());
    expect(json).not.toContain("customer:menu:bank");
    expect(json).toContain("customer:menu:quote");
  });

  it("🧹 clear chat is TEMPORARILY hidden from the customer menu (backend stays wired)", () => {
    const json = JSON.stringify(getCustomerMenuKeyboard());
    expect(json).not.toContain("customer:menu:clearchat");
    expect(json).not.toContain("menu.clearchat");
  });

  it("bank wizard keyboard targets the given order currency", () => {
    const json = JSON.stringify(getBankWizardKeyboard("USD"));
    expect(json).toContain("customer:bank:wiz:USD");
  });

  it("welcome text never mentions KHR", async () => {
    seedUsdVndRate();
    const text = await renderCustomerWelcomeText("Tester");
    expect(text).not.toContain("KHR");
    expect(text).toContain("USD");
  });
});
