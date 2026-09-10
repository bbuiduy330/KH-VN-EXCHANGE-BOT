import { describe, it, expect } from "vitest";
import { ConversationService } from "../src/modules/conversation/conversation-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { AiProvider } from "../src/modules/ai/ai-provider.js";
import { inMemoryStore } from "../src/database/client.js";

/**
 * HUMAN support <-> BOT routing regression tests.
 *
 * The customer text router gates on ConversationService mode:
 *   mode === "HUMAN" -> messages are relayed to staff (no automatic quote)
 *   mode === "AUTO"  -> messages reach the deterministic exchange parser
 *
 * The customer exit button ("↩️ Quay lại đổi tiền") and the coherent
 * "💱 Đổi tiền" press both call ConversationService.releaseByCustomer(),
 * which performs the SAME lifecycle transition as the staff release():
 * mode "AUTO" + claimedById null. No new database status is introduced.
 */

describe("Human support routing lifecycle", () => {
  it("customer exit returns the conversation to AUTO bot routing", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `cust-exit-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });

    // Staff claims: customer is now in HUMAN mode (texts go to staff, not parser)
    await ConversationService.claim(customer.id, "staff_1");
    let conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("HUMAN");

    // Customer presses "↩️ Quay lại đổi tiền"
    const released = await ConversationService.releaseByCustomer(customer.id);
    expect(released.mode).toBe("AUTO");
    expect(released.claimedById).toBeNull();

    conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("AUTO");
  });

  it("customer exit is idempotent: stale or double button presses are safe no-ops", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `cust-exit-idem-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });
    await ConversationService.claim(customer.id, "staff_1");

    await ConversationService.releaseByCustomer(customer.id);
    // Second press (stale button) must not throw and must not corrupt state
    await expect(ConversationService.releaseByCustomer(customer.id)).resolves.toBeTruthy();

    const conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("AUTO");
    expect(conv.claimedById).toBeNull();
  });

  it("staff release also returns the customer to normal BOT routing", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `cust-staff-rel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });
    await ConversationService.claim(customer.id, "staff_1");
    let conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("HUMAN");

    await ConversationService.release(customer.id, "staff_1");
    conv = await ConversationService.getOrCreateConversation(customer.id);
    expect(conv.mode).toBe("AUTO");
    expect(conv.claimedById).toBeNull();
  });

  it("after customer exit, an exchange request reaches the parser and creates a resumable quote", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `cust-exit-quote-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });
    await ConversationService.claim(customer.id, "staff_1");
    await ConversationService.releaseByCustomer(customer.id);

    // Routing gate is AUTO again: the parser will handle the customer text.
    // Sanity: the deterministic parser resolves the exact required direction.
    const intent = AiProvider.parseLocalExchangeIntent("100 đô");
    expect(intent).not.toBeNull();
    expect(intent?.sourceCurrency).toBe("USD");
    expect(intent?.targetCurrency).toBe("VND");

    // ...and the automatic flow can create a real quote for it.
    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    expect(quote.status).toBe("PENDING");
    expect(quote.sourceCurrency).toBe("USD");
    expect(quote.targetCurrency).toBe("VND");

    // /start must resume this active unexpired quote afterwards.
    const active = await QuoteService.getLatestActiveQuote(customer.id);
    expect(active).not.toBeNull();
    expect(active?.id).toBe(quote.id);
  });

  it("expired quotes are not resumed after exit (gt comparator on expiresAt)", async () => {
    const customer = await CustomerService.getOrCreateCustomer({
      telegramId: `cust-exit-exp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    });
    await ConversationService.claim(customer.id, "staff_1");
    await ConversationService.releaseByCustomer(customer.id);

    const quote = await QuoteService.createQuote(customer.id, "USD", "VND", 100);
    let active = await QuoteService.getLatestActiveQuote(customer.id);
    expect(active?.id).toBe(quote.id);

    // Simulate expiry (quote expired while customer was in support)
    const stored = inMemoryStore.quotes.get(quote.id);
    stored.expiresAt = new Date(Date.now() - 60_000);

    active = await QuoteService.getLatestActiveQuote(customer.id);
    expect(active).toBeNull();
  });

  it("required direction examples parse locally (no Gemini needed)", () => {
    const vndToUsd = AiProvider.parseLocalExchangeIntent("10 triệu lấy $");
    expect(vndToUsd?.sourceCurrency).toBe("VND");
    expect(vndToUsd?.targetCurrency).toBe("USD");

    const usdToVnd = AiProvider.parseLocalExchangeIntent("500$ lấy tiền Việt");
    expect(usdToVnd?.sourceCurrency).toBe("USD");
    expect(usdToVnd?.targetCurrency).toBe("VND");
  });
});
