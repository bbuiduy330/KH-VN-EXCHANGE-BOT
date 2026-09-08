import { describe, it, expect } from "vitest";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import { AiProvider } from "../src/modules/ai/ai-provider.js";
import { MoneyService } from "../src/modules/money/money-service.js";

describe("QuoteService", () => {
  it("calculates direct quotes with buyMargin applied", async () => {
    const quote = await QuoteService.calculateQuote("USD", "VND", 100);
    expect(quote.sourceCurrency).toBe("USD");
    expect(quote.targetCurrency).toBe("VND");
    expect(quote.sourceAmount.toNumber()).toBe(100);
    expect(quote.targetAmount.toNumber()).toBeGreaterThan(0);
    expect(quote.effectiveRate.toNumber()).toBeLessThanOrEqual(quote.baseRate.toNumber());
  });

  it("throws error for negative or zero amount", async () => {
    await expect(QuoteService.calculateQuote("USD", "VND", 0)).rejects.toThrow();
  });
});

describe("PermissionService", () => {
  it("denies payment.verify for CSKH staff by default", async () => {
    const hasPermission = await PermissionService.hasPermission("cskh-user-123", "payment.verify");
    expect(hasPermission).toBe(false);
  });
});

describe("AiProvider local exchange intent parser", () => {
  // --- Full explicit direction ---
  it('parses "đổi 100 usd sang vnd"', () => {
    const intent = AiProvider.parseLocalExchangeIntent("đổi 100 usd sang vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "đổi 1 triệu vnd sang usd"', () => {
    const intent = AiProvider.parseLocalExchangeIntent("đổi 1 triệu vnd sang usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "500 usd to vnd"', () => {
    const intent = AiProvider.parseLocalExchangeIntent("500 usd to vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(500);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  // --- Partial: source only, target inferred ---
  it('parses "doi 100 đô" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("doi 100 đô");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "đổi 100 đô" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("đổi 100 đô");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "doi 100 do" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("doi 100 do");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "100 đô" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100 đô");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "100 do" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100 do");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "100$" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100$");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "100 usd" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100 usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "doi 100 usd" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("doi 100 usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  // --- Partial: VND source, target inferred ---
  it('parses "100k vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100k vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "500k vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("500k vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(500000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "1 triệu vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("1 triệu vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "1 trieu vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("1 trieu vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  // --- M / tr multipliers (delegated to MoneyService.parseHumanAmount) ---
  it('parses "2m vnd" -> 2 000 000 VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("2m vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(2000000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "2tr usd" -> 2 000 000 USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("2tr usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(2000000);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "2 triệu usd" -> 2 000 000 USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("2 triệu usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(2000000);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  // --- Rejections ---
  it("rejects zero amount", () => {
    expect(AiProvider.parseLocalExchangeIntent("0 usd")).toBeNull();
  });

  it("rejects negative amount", () => {
    expect(AiProvider.parseLocalExchangeIntent("-100 usd")).toBeNull();
  });

  it("rejects unsupported currency (KHR)", () => {
    expect(AiProvider.parseLocalExchangeIntent("100 khr")).toBeNull();
    expect(AiProvider.parseLocalExchangeIntent("100 usd sang khr")).toBeNull();
  });

  it("rejects source === target", () => {
    expect(AiProvider.parseLocalExchangeIntent("100 usd sang usd")).toBeNull();
  });

  it("rejects non-exchange messages", () => {
    expect(AiProvider.parseLocalExchangeIntent("xin chào")).toBeNull();
    expect(AiProvider.parseLocalExchangeIntent("rate thế nào")).toBeNull();
  });

  // --- False positive control: non-exchange sentences with amounts ---
  it("rejects 'gia 100 usd' (price inquiry, no exchange signal)", () => {
    expect(AiProvider.parseLocalExchangeIntent("gia 100 usd")).toBeNull();
  });

  it("rejects 'doanh thu 100 usd' (revenue mention, no exchange signal)", () => {
    expect(AiProvider.parseLocalExchangeIntent("doanh thu 100 usd")).toBeNull();
  });

  it("rejects 'don hang 100 usd' (order mention, no exchange signal)", () => {
    expect(AiProvider.parseLocalExchangeIntent("don hang 100 usd")).toBeNull();
  });

  it("rejects 'toi co 100 usd' (possession, no exchange signal)", () => {
    expect(AiProvider.parseLocalExchangeIntent("toi co 100 usd")).toBeNull();
  });

  it("rejects '100 usdt' (usdt is not USD)", () => {
    expect(AiProvider.parseLocalExchangeIntent("100 usdt")).toBeNull();
  });

  it("rejects '100 usdc' (usdc is not USD)", () => {
    expect(AiProvider.parseLocalExchangeIntent("100 usdc")).toBeNull();
  });

  // --- Exchange signal with verb in longer sentence ---
  it('parses "toi muon doi 100 usd" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("toi muon doi 100 usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "muon doi 500k vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("muon doi 500k vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(500000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  // --- Space-separated thousands ---
  it('parses "1 000 000 vnd" -> VND -> USD', () => {
    const intent = AiProvider.parseLocalExchangeIntent("1 000 000 vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000000);
    expect(intent?.sourceCurrency).toBe("VND");
    expect(intent?.targetCurrency).toBe("USD");
  });

  it('parses "1 000 000 usd sang vnd" -> USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("1 000 000 usd sang vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000000);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  // --- Ambiguous forms rejected ---
  it("rejects '1,000,000 vnd' (ambiguous thousands)", () => {
    expect(AiProvider.parseLocalExchangeIntent("1,000,000 vnd")).toBeNull();
  });

  it("rejects '1.000.000 vnd' (ambiguous thousands)", () => {
    expect(AiProvider.parseLocalExchangeIntent("1.000.000 vnd")).toBeNull();
  });

  it("rejects '1.000 vnd' (ambiguous: decimal or thousands?)", () => {
    expect(AiProvider.parseLocalExchangeIntent("1.000 vnd")).toBeNull();
  });

  it("rejects '1,000 vnd' (ambiguous: decimal or thousands?)", () => {
    expect(AiProvider.parseLocalExchangeIntent("1,000 vnd")).toBeNull();
  });

  // --- Decimal amounts ---
  it('parses "100.50 usd" -> 100.5 USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100.50 usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100.5);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it('parses "100,50 usd" -> 100.5 USD -> VND', () => {
    const intent = AiProvider.parseLocalExchangeIntent("100,50 usd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(100.5);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  // --- Simple inputs are handled locally without Gemini ---
  it("simple local-parser inputs do NOT need Gemini (parseExchangeIntent returns local result)", async () => {
    // These must be recognized by the deterministic parser, so parseExchangeIntent
    // returns early without calling Gemini.
    const simpleInputs = [
      "100$",
      "100 đô",
      "100 usd",
      "500k vnd",
      "1 triệu vnd",
      "2m vnd",
      "2tr usd"
    ];
    for (const input of simpleInputs) {
      const intent = await AiProvider.parseExchangeIntent(input);
      expect(intent).not.toBeNull();
      expect(intent?.amount).toBeGreaterThan(0);
      expect(["USD", "VND"]).toContain(intent?.sourceCurrency);
      expect(["USD", "VND"]).toContain(intent?.targetCurrency);
    }
  });
});

describe("MoneyService.parseHumanAmount", () => {
  it('parses "2M" -> 2 000 000', () => {
    expect(MoneyService.parseHumanAmount("2M")).toBe(2000000);
  });
  it('parses "2m" -> 2 000 000', () => {
    expect(MoneyService.parseHumanAmount("2m")).toBe(2000000);
  });
  it('parses "2 triệu" -> 2 000 000', () => {
    expect(MoneyService.parseHumanAmount("2 triệu")).toBe(2000000);
  });
  it('parses "2tr" -> 2 000 000', () => {
    expect(MoneyService.parseHumanAmount("2tr")).toBe(2000000);
  });
  it('parses "500k" -> 500 000', () => {
    expect(MoneyService.parseHumanAmount("500k")).toBe(500000);
  });
  it('parses "1 nghìn" -> 1 000', () => {
    expect(MoneyService.parseHumanAmount("1 nghìn")).toBe(1000);
  });
  it('parses "1 ngàn" -> 1 000', () => {
    expect(MoneyService.parseHumanAmount("1 ngàn")).toBe(1000);
  });
  it('parses "100" -> 100', () => {
    expect(MoneyService.parseHumanAmount("100")).toBe(100);
  });
  it('parses "100.50" -> 100.5', () => {
    expect(MoneyService.parseHumanAmount("100.50")).toBe(100.5);
  });
  it('parses "100.5" -> 100.5', () => {
    expect(MoneyService.parseHumanAmount("100.5")).toBe(100.5);
  });
  it('parses "100,50" -> 100.5', () => {
    expect(MoneyService.parseHumanAmount("100,50")).toBe(100.5);
  });
  it('parses "100,5" -> 100.5', () => {
    expect(MoneyService.parseHumanAmount("100,5")).toBe(100.5);
  });
  it('parses "1 000 000" -> 1000000', () => {
    expect(MoneyService.parseHumanAmount("1 000 000")).toBe(1000000);
  });
  it("rejects ambiguous forms", () => {
    expect(MoneyService.parseHumanAmount("1.000.000")).toBeNull();
    expect(MoneyService.parseHumanAmount("1,000,000")).toBeNull();
    expect(MoneyService.parseHumanAmount("1.000,50")).toBeNull();
    expect(MoneyService.parseHumanAmount("1,000.50")).toBeNull();
    expect(MoneyService.parseHumanAmount("1.000")).toBeNull();
    expect(MoneyService.parseHumanAmount("1,000")).toBeNull();
  });
  it("rejects zero and negative", () => {
    expect(MoneyService.parseHumanAmount("0")).toBeNull();
    expect(MoneyService.parseHumanAmount("-100")).toBeNull();
  });
});

describe("MoneyService.formatVnd", () => {
  it('formats 2000000 -> "2 000 000 VND"', () => {
    expect(MoneyService.formatVnd(2000000)).toBe("2 000 000 VND");
  });
  it('formats 2635742 -> "2 635 742 VND" (display only, no rounding)', () => {
    expect(MoneyService.formatVnd(2635742)).toBe("2 635 742 VND");
  });
  it('formats 2635750 -> "2 635 750 VND" (display only, no rounding)', () => {
    expect(MoneyService.formatVnd(2635750)).toBe("2 635 750 VND");
  });
  it('formats 1234567 -> "1 234 567 VND" (display only, no rounding)', () => {
    expect(MoneyService.formatVnd(1234567)).toBe("1 234 567 VND");
  });
});

describe("MoneyService.roundVnd", () => {
  it('rounds 2635749 -> 2635700', () => {
    expect(MoneyService.roundVnd(2635749).toNumber()).toBe(2635700);
  });
  it('rounds 2635750 -> 2635800', () => {
    expect(MoneyService.roundVnd(2635750).toNumber()).toBe(2635800);
  });
  it('rounds 2635742 -> 2635700', () => {
    expect(MoneyService.roundVnd(2635742).toNumber()).toBe(2635700);
  });
});

describe("MoneyService.formatUsd", () => {
  it('formats 100 -> "100 USD"', () => {
    expect(MoneyService.formatUsd(100)).toBe("100 USD");
  });
  it('formats 100.5 -> "100,5 USD"', () => {
    expect(MoneyService.formatUsd(100.5)).toBe("100,5 USD");
  });
  it('formats 100.50 -> "100,5 USD"', () => {
    expect(MoneyService.formatUsd(100.50)).toBe("100,5 USD");
  });
  it('formats 100.25 -> "100,25 USD"', () => {
    expect(MoneyService.formatUsd(100.25)).toBe("100,25 USD");
  });
  it('formats 1234.5 -> "1 234,5 USD"', () => {
    expect(MoneyService.formatUsd(1234.5)).toBe("1 234,5 USD");
  });
  it('formats 10.999 -> "11 USD" (rounds to 2dp, strips zeros)', () => {
    expect(MoneyService.formatUsd(10.999)).toBe("11 USD");
  });
  it('formats 10.506 -> "10,51 USD"', () => {
    expect(MoneyService.formatUsd(10.506)).toBe("10,51 USD");
  });
  it('formats 10.500 -> "10,5 USD"', () => {
    expect(MoneyService.formatUsd(10.500)).toBe("10,5 USD");
  });
});
