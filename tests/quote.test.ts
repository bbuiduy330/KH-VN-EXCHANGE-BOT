import { describe, it, expect } from "vitest";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { PermissionService } from "../src/modules/permissions/permission-service.js";
import { AiProvider } from "../src/modules/ai/ai-provider.js";

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

describe("AiProvider regex fallback", () => {
  it("parses exchange intent accurately from text", () => {
    const intent = AiProvider.parseWithRegex("đổi 1000 USD sang VND");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(1000);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });

  it("parses alternative phrasing", () => {
    const intent = AiProvider.parseWithRegex("500 usd to vnd");
    expect(intent).not.toBeNull();
    expect(intent?.amount).toBe(500);
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");
  });
});
