import { describe, it, expect } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import {
  canAdminCancel,
  canCustomerCancel,
  adminCancelSource,
  incomingPaymentVerified,
  payoutSentEvidence,
  sanitizeAdminCancelReason,
  ADMIN_CANCELLABLE_STATUSES
} from "../src/modules/orders/order-safety.js";

/**
 * Part A — EXPANDED ADMIN CANCEL (authoritative policy in order-safety.ts).
 * Customer cancellation policy must remain UNCHANGED.
 */

const uniqueId = () => `acx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe("Part A — authoritative admin-cancel policy (pure rules)", () => {
  it("allows EVERY pre-payout state", () => {
    for (const status of ADMIN_CANCELLABLE_STATUSES) {
      expect(canAdminCancel({ status } as any).allowed).toBe(true);
      expect(canAdminCancel({ status } as any).code).toBe("ALLOWED");
    }
  });

  it("blocks PAYOUT_SENT and COMPLETED", () => {
    expect(canAdminCancel({ status: "PAYOUT_SENT" } as any)).toMatchObject({ allowed: false, code: "PAYOUT_SENT" });
    expect(canAdminCancel({ status: "COMPLETED" } as any)).toMatchObject({ allowed: false, code: "COMPLETED" });
  });

  it("blocks payout evidence even with a stale pre-payout status", () => {
    expect(canAdminCancel({ status: "WAITING_PAYOUT", payoutAt: new Date() } as any)).toMatchObject({
      allowed: false, code: "PAYOUT_SENT"
    });
    expect(canAdminCancel({ status: "PAYMENT_CONFIRMED", payoutBillFileId: "ev-1" } as any)).toMatchObject({
      allowed: false, code: "PAYOUT_SENT"
    });
    expect(payoutSentEvidence({ status: "WAITING_PAYMENT", payoutAt: new Date() } as any)).toBe(true);
  });

  it("verified incoming payment is detected for the warning/source", () => {
    expect(incomingPaymentVerified({ status: "WAITING_PAYMENT" } as any)).toBe(false);
    expect(incomingPaymentVerified({ status: "WAITING_PAYMENT", verifiedAt: new Date() } as any)).toBe(true);
    expect(incomingPaymentVerified({ status: "PAYMENT_CONFIRMED" } as any)).toBe(true);
    expect(adminCancelSource({ status: "WAITING_PAYMENT" } as any)).toBe("ADMIN_CANCELLED_UNPAID");
    expect(adminCancelSource({ status: "PAYMENT_CONFIRMED" } as any)).toBe("ADMIN_CANCELLED_AFTER_PAYMENT");
  });

  it("free-form reason sanitizer: trim, control chars, ≤300, non-empty", () => {
    expect(sanitizeAdminCancelReason("  Khách fake bill \u0001 test  ")).toBe("Khách fake bill  test");
    expect(sanitizeAdminCancelReason("")).toBeNull();
    expect(sanitizeAdminCancelReason("x".repeat(301))).toBeNull();
    expect(sanitizeAdminCancelReason("abc")).toBe("abc");
  });

  it("CUSTOMER cancellation policy remains UNCHANGED (restrictive)", () => {
    expect(canCustomerCancel({ status: "WAITING_PAYMENT" } as any).allowed).toBe(true);
    expect(canCustomerCancel({ status: "WAITING_PAYMENT", customerBillFileId: "ev" } as any).allowed).toBe(false);
    expect(canCustomerCancel({ status: "PAYMENT_CONFIRMED" } as any).allowed).toBe(false);
    expect(canCustomerCancel({ status: "WAITING_PAYOUT", verifiedAt: new Date() } as any).allowed).toBe(false);
  });
});

describe("Part A — OrderService.cancelOrder end-to-end (mock DB)", () => {
  async function mkCustomer(): Promise<any> {
    return CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
  }
  async function mkOrder(customerId: string, data: Record<string, unknown> = {}): Promise<any> {
    return prisma.order.create({
      data: {
        id: `ORD-ACX-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6)}`,
        customerId,
        sourceCurrency: "USD",
        targetCurrency: "VND",
        sourceAmount: 100,
        targetAmount: 2540000,
        rate: 25400,
        fee: 2,
        feeCurrency: "USD",
        status: "WAITING_PAYMENT",
        ...data
      } as any
    });
  }

  it("Admin cancels WAITING_PAYMENT with free-form reason (audited)", async () => {
    const c = await mkCustomer();
    const o = await mkOrder(c.id);
    const updated: any = await OrderService.cancelOrder(o.id, "admin-9", "ADMIN", "Khách gửi bill giả", {
      source: "ADMIN_CANCELLED_UNPAID"
    });
    expect(updated.status).toBe("CANCELLED");
    const audits: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: o.id } });
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0].details)).toContain("Khách gửi bill giả");
    expect(JSON.stringify(audits[0].details)).toContain("ADMIN_CANCELLED_UNPAID");
  });

  it("Admin cancels CUSTOMER_SENT_BILL / WAITING_ADMIN_VERIFY / PAYMENT_CONFIRMED / WAITING_PAYOUT(+destination)", async () => {
    const c = await mkCustomer();
    for (const [status, extra] of [
      ["CUSTOMER_SENT_BILL", { customerBillFileId: "ev-1" }],
      ["WAITING_ADMIN_VERIFY", { customerBillFileId: "ev-2" }],
      ["PAYMENT_CONFIRMED", { verifiedAt: new Date(), verifiedByAdminId: "admin-9" }],
      ["WAITING_PAYOUT", { verifiedAt: new Date(), payoutBankSnapshot: { bankName: "VCB", accountNumber: "123" } }]
    ] as [string, Record<string, unknown>][]) {
      const o = await mkOrder(c.id, { status, ...extra });
      const updated: any = await OrderService.cancelOrder(o.id, "admin-9", "ADMIN", `Huỷ ${status}`, {
        source: "ADMIN_CANCELLED_AFTER_PAYMENT"
      });
      expect(updated.status).toBe("CANCELLED");
    }
  });

  it("after-payment cancel uses the AFTER_PAYMENT source in audit + state history", async () => {
    const c = await mkCustomer();
    const o = await mkOrder(c.id, { status: "PAYMENT_CONFIRMED", verifiedAt: new Date() });
    await OrderService.cancelOrder(o.id, "admin-9", "ADMIN", "Sai thông tin khách", {
      metadata: { adminTelegramId: "admin-9", paymentVerified: true }
    });
    const audits: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: o.id } });
    const stateHistories: any[] = await prisma.orderStateHistory.findMany({ where: { orderId: o.id } });
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0].details)).toContain("ADMIN_CANCELLED_AFTER_PAYMENT");
    expect(JSON.stringify(stateHistories)).toContain("ADMIN_CANCELLED_AFTER_PAYMENT");
  });

  it("PAYOUT_SENT / COMPLETED cannot be normal-cancelled", async () => {
    const c = await mkCustomer();
    const sent = await mkOrder(c.id, { status: "PAYOUT_SENT", verifiedAt: new Date(), payoutAt: new Date() });
    await expect(OrderService.cancelOrder(sent.id, "admin-9", "ADMIN", "test")).rejects.toThrow();
    const done = await mkOrder(c.id, { status: "COMPLETED", verifiedAt: new Date(), payoutAt: new Date(), completedAt: new Date() });
    await expect(OrderService.cancelOrder(done.id, "admin-9", "ADMIN", "test")).rejects.toThrow();
  });

  it("double Confirm is safe (idempotent, no duplicate audit)", async () => {
    const c = await mkCustomer();
    const o = await mkOrder(c.id);
    await OrderService.cancelOrder(o.id, "admin-9", "ADMIN", "huỷ lần 1", { source: "ADMIN_CANCELLED_UNPAID" });
    const again: any = await OrderService.cancelOrder(o.id, "admin-9", "ADMIN", "huỷ lần 2", { source: "ADMIN_CANCELLED_UNPAID" });
    expect(again.status).toBe("CANCELLED");
    const audits: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: o.id } });
    expect(audits.length).toBe(1);
  });
});

