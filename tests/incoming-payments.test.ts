import { describe, it, expect } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import {
  INCOMING_PROVIDERS,
  handleProviderWebhook,
  matchAndApplyIncomingEvent,
  recordIncomingEvent,
  getVerificationReadiness,
  setAccountVerificationProvider
} from "../src/modules/incoming-payments/incoming-payment-service.js";

/**
 * PART F — automated incoming-payment verification (service level, mock DB).
 */

const uniqueId = () => `ip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function mkOrderWithCustomer(data: Record<string, unknown> = {}): Promise<{ order: any; customer: any }> {
  const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId().replace(/\D/g, "").slice(0, 9) || "1" });
  const order = await prisma.order.create({
    data: {
      id: `ORD-IP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6)}`,
      customerId: customer.id,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      transferMemo: `MEMO${Math.floor(Math.random() * 1e6)}`,
      status: "WAITING_ADMIN_VERIFY",
      ...data
    } as any
  });
  return { order, customer };
}

const eventFor = (order: any, overrides: Record<string, unknown> = {}) => ({
  provider: "BAKONG_OPEN_API" as const,
  externalTransactionId: `TXN-${uniqueId()}`,
  amount: "100",
  currency: "USD",
  memo: order.transferMemo,
  ...overrides
});

describe("Part F — deduplication + authoritative matching (F3/F4)", () => {
  it("duplicate event does not double-confirm (unique provider+external id)", async () => {
    const { order } = await mkOrderWithCustomer();
    const event = eventFor(order);
    const first = await recordIncomingEvent(event);
    expect(first.duplicate).toBe(false);
    const second = await recordIncomingEvent(event);
    expect(second.duplicate).toBe(true);

    await matchAndApplyIncomingEvent(first.event.id);
    await matchAndApplyIncomingEvent(second.event.id); // replay-safe
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYOUT"); // confirmed exactly once
    const confirmed = await prisma.incomingPaymentEvent.findUnique({ where: { id: first.event.id } });
    expect(confirmed.status).toBe("CONFIRMED");
  });

  it("wrong amount / wrong currency / wrong account → MISMATCH, never confirmed", async () => {
    const { order: wrongAmount } = await mkOrderWithCustomer();
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(wrongAmount, { amount: "99" }))).event.id);
    const a: any = await prisma.incomingPaymentEvent.findFirst({ where: { matchedOrderId: wrongAmount.id } });
    expect(a.status).toBe("MISMATCH");
    expect((await prisma.order.findUnique({ where: { id: wrongAmount.id } }) as any).status).toBe("PAYMENT_MISMATCH");

    const { order: wrongCurrency } = await mkOrderWithCustomer();
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(wrongCurrency, { currency: "VND", amount: "2540000" }))).event.id);
    const b: any = await prisma.incomingPaymentEvent.findFirst({ where: { matchedOrderId: wrongCurrency.id } });
    expect(b.status).toBe("MISMATCH");

    const { order: wrongAccount } = await mkOrderWithCustomer();
    const payAccount = await prisma.paymentAccount.create({
      data: {
        id: `PA-IP-${Date.now().toString(36).toUpperCase()}`,
        currency: "USD", bankName: "Other", accountName: "OTHER", accountNumber: "0000001111", isActive: true
      }
    }) as any;
    await prisma.order.update({ where: { id: wrongAccount.id }, data: { receivingAccountId: payAccount.id } });
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(wrongAccount, { accountNumber: "9999999999" }))).event.id);
    const c: any = await prisma.incomingPaymentEvent.findFirst({ where: { matchedOrderId: wrongAccount.id } });
    expect(c.status).toBe("MISMATCH");
  });

  it("correct event calls the authoritative verification path ONCE (no payout/completion)", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_ADMIN_VERIFY" });
    const { event } = await recordIncomingEvent(eventFor(order));
    await matchAndApplyIncomingEvent(event.id);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYOUT"); // verified — NOT completed/paid out
    expect(fresh.verifiedAt).toBeTruthy();
    const events: any[] = await prisma.incomingPaymentEvent.findMany({ where: { matchedOrderId: order.id } });
    expect(events.filter((e) => e.status === "CONFIRMED").length).toBe(1);
  });

  it("cancelled/completed orders can never be matched/reopened", async () => {
    const { order: cancelled } = await mkOrderWithCustomer({ status: "CANCELLED" });
    const { order: done } = await mkOrderWithCustomer({ status: "COMPLETED", verifiedAt: new Date() });
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(cancelled))).event.id);
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(done))).event.id);
    expect((await prisma.order.findUnique({ where: { id: cancelled.id } }) as any).status).toBe("CANCELLED");
    expect((await prisma.order.findUnique({ where: { id: done.id } }) as any).status).toBe("COMPLETED");
  });
});

describe("Part F — provider scaffolding + readiness (F7/F8/F9)", () => {
  it("all webhook providers are DISABLED — no unauthenticated confirmations", async () => {
    for (const provider of ["SEPAY", "APIPAY", "ABA_PAYWAY"]) {
      expect(INCOMING_PROVIDERS[provider as keyof typeof INCOMING_PROVIDERS].enabled).toBe(false);
      const res = await handleProviderWebhook(provider, { any: "payload" });
      expect(res.status).toBe(503);
    }
    const unknown = await handleProviderWebhook("NO_SUCH_PROVIDER", {});
    expect(unknown.status).toBe(404);
  });

  it("verification readiness states + provider save (token → encrypted secret only)", async () => {
    const account = await prisma.paymentAccount.create({
      data: {
        id: `PA-VR-${Date.now().toString(36).toUpperCase()}`,
        currency: "USD", bankName: "ABA", accountName: "ABA TEST", accountNumber: "179168179", isActive: true
      }
    }) as any;

    expect(getVerificationReadiness(account).status).toBe("OFF");
    await setAccountVerificationProvider("admin-ip", account.id, "BAKONG_OPEN_API", "https://api-bakong.nbc.gov.kh", "SECRET-TOKEN");
    const reloaded: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    expect(getVerificationReadiness(reloaded).status).toBe("READY");
    // Token stored ONLY as an encrypted secret, never on the account row:
    expect(JSON.stringify(reloaded)).not.toContain("SECRET-TOKEN");
    const secret: any = await prisma.systemSetting.findUnique({ where: { key: "incoming_payment_bakong_token" } });
    expect(secret).toBeTruthy();
    expect(JSON.stringify(secret)).not.toContain("SECRET-TOKEN");
  });
});

describe("Part F FIX — bank confirmation without bill + state-machine safety", () => {
  it("A. WAITING_PAYMENT + valid Bakong transaction → confirmed WITHOUT a bill", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_PAYMENT" });
    const { event } = await recordIncomingEvent(eventFor(order));
    await matchAndApplyIncomingEvent(event.id);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYOUT"); // PAYMENT_CONFIRMED → WAITING_PAYOUT
    expect(fresh.verifiedAt).toBeTruthy();
    expect(fresh.verifiedByAdminId).toBe("BANK:BAKONG_OPEN_API");
    const ev: any = await prisma.incomingPaymentEvent.findUnique({ where: { id: event.id } });
    expect(ev.status).toBe("CONFIRMED"); // NOT stuck at MATCHED
  });

  it("B. WAITING_ADMIN_VERIFY + valid Bakong transaction → confirms correctly", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_ADMIN_VERIFY" });
    const { event } = await recordIncomingEvent(eventFor(order));
    await matchAndApplyIncomingEvent(event.id);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYOUT");
  });

  it("C. WAITING_PAYMENT + wrong amount → no confirmation; PAYMENT_MISMATCH", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_PAYMENT" });
    await matchAndApplyIncomingEvent((await recordIncomingEvent(eventFor(order, { amount: "99" }))).event.id);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("PAYMENT_MISMATCH");
    const ev: any = await prisma.incomingPaymentEvent.findFirst({ where: { matchedOrderId: order.id } });
    expect(ev.status).toBe("MISMATCH");
  });

  it("D. cancelled / completed / payout-sent orders can NEVER be reopened by provider retry", async () => {
    for (const status of ["CANCELLED", "COMPLETED", "PAYOUT_SENT", "WAITING_PAYOUT", "PAYMENT_CONFIRMED"]) {
      const { order } = await mkOrderWithCustomer({ status, verifiedAt: new Date() });
      const { event } = await recordIncomingEvent(eventFor(order));
      await matchAndApplyIncomingEvent(event.id);
      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status, status).toBe(status); // untouched
      const ev: any = await prisma.incomingPaymentEvent.findUnique({ where: { id: event.id } });
      expect(ev.status, status).toBe("IGNORED"); // BANK_CONFIRMED_REFUSED → ignored
    }
  });

  it("F. old stuck MATCHED events are safely reprocessed by reprocessMatchedEvents", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_PAYMENT" });
    const { event } = await recordIncomingEvent(eventFor(order));
    // Simulate the OLD dead-data state: event stuck at MATCHED.
    await prisma.incomingPaymentEvent.update({
      where: { id: event.id }, data: { status: "MATCHED", matchedOrderId: order.id }
    });
    const { reprocessMatchedEvents } = await import("../src/modules/incoming-payments/incoming-payment-service.js");
    await reprocessMatchedEvents(10);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYOUT"); // recovered, confirmed once
    const ev: any = await prisma.incomingPaymentEvent.findUnique({ where: { id: event.id } });
    expect(ev.status).toBe("CONFIRMED");
    // Idempotent: re-running changes nothing.
    await reprocessMatchedEvents(10);
    expect((await prisma.incomingPaymentEvent.findUnique({ where: { id: event.id } }) as any).status).toBe("CONFIRMED");
  });

  it("I. bank-confirmed Order is excluded from bill-re confirmation (late bill safe)", async () => {
    const { order } = await mkOrderWithCustomer({ status: "WAITING_PAYMENT" });
    await OrderService.confirmPaymentFromBankProvider(order.id, "BAKONG_OPEN_API", "REF-1");
    // A second bank confirm attempt is refused by the authoritative service:
    await expect(
      OrderService.confirmPaymentFromBankProvider(order.id, "BAKONG_OPEN_API", "REF-2")
    ).rejects.toThrow(/BANK_CONFIRMED_REFUSED/);
    // And the accepted bill statuses no longer include this Order:
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    const allowedStatuses = ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW"];
    expect(allowedStatuses.includes(fresh.status)).toBe(false);
  });
});


