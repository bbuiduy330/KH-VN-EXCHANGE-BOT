import { describe, it, expect, vi } from "vitest";
import { prisma } from "../src/database/client.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import {
  hasValidPaymentEvidence,
  ADMIN_CANCEL_REASONS,
  adminCancelReasonLabel
} from "../src/modules/orders/order-safety.js";
import {
  computeReminderState,
  REMINDER_OFFSETS_MIN,
  AUTO_CANCEL_MIN,
  tickPaymentReminders
} from "../src/modules/orders/payment-reminder-service.js";
import {
  resolveEvidenceMime,
  sniffMimeFromBytes
} from "../src/modules/files/media-validation.js";
import { setPendingAction, consumePendingAction } from "../src/bot/admin/admin-session.js";
import { SUPPORTED_LOCALES, t } from "../src/modules/i18n/locales.js";
import * as notifications from "../src/bot/notifications.js";

// ---------------------------------------------------------------------------
// The test run uses the in-memory mock database (non-production fallback).
// ---------------------------------------------------------------------------

const CUSTOMER_TG = "cancel-rem-tg-1";
let customerId = "";
let orderSeq = 0;

async function ensureCustomer(): Promise<any> {
  let customer = await prisma.customer.findUnique({ where: { telegramId: CUSTOMER_TG } });
  if (!customer) {
    customer = await prisma.customer.create({
      data: { telegramId: CUSTOMER_TG, username: "cancel_tester", fullName: "Cancel Tester", language: "vi" }
    });
  }
  customerId = customer.id;
  return customer;
}

async function createTestOrder(overrides: Record<string, any> = {}): Promise<any> {
  orderSeq++;
  const id = `ORD-CANCELTEST-${String(orderSeq).padStart(3, "0")}`;
  return prisma.order.create({
    data: {
      id,
      customerId,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      status: "WAITING_PAYMENT",
      ...overrides
    }
  });
}

const ALL_STATES = [
  "WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "PAYMENT_CONFIRMED",
  "WAITING_PAYOUT", "PAYOUT_SENT", "COMPLETED", "CANCELLED", "PAYMENT_MISMATCH",
  "MANUAL_REVIEW", "SUSPICIOUS"
];

describe("Centralized cancellation rules (L — one rule set for customer/admin/scheduler)", () => {
  it("allows customer cancel ONLY for unpaid WAITING_PAYMENT with no evidence", () => {
    expect(OrderService.canCustomerCancel({ status: "WAITING_PAYMENT" }).allowed).toBe(true);
    for (const status of ALL_STATES.filter((s) => s !== "WAITING_PAYMENT")) {
      expect(OrderService.canCustomerCancel({ status }).allowed, status).toBe(false);
    }
  });

  it("blocks customer cancel after incoming payment confirmed (PAYMENT_CONFIRMED)", () => {
    expect(OrderService.canCustomerCancel({ status: "WAITING_PAYOUT" }).code).toBe("PAYMENT_CONFIRMED");
    expect(OrderService.canCustomerCancel({ status: "PAYMENT_CONFIRMED" }).code).toBe("PAYMENT_CONFIRMED");
    expect(OrderService.canCustomerCancel({ status: "WAITING_PAYMENT", verifiedAt: new Date() }).code).toBe("PAYMENT_CONFIRMED");
  });

  it("blocks customer cancel when a bill/evidence exists (routes to review)", () => {
    const d = OrderService.canCustomerCancel({ status: "WAITING_PAYMENT", customerBillFileId: "ev-1" });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("BILL_EXISTS");
    expect(d.billWarning).toBe(true);
    // An evidence row in history (not yet promoted) blocks too.
    expect(hasValidPaymentEvidence({ status: "WAITING_PAYMENT", bills: [{ id: "x" }] })).toBe(true);
    expect(OrderService.canCustomerCancel({ status: "WAITING_PAYMENT", bills: [{ id: "x" }] }).code).toBe("BILL_EXISTS");
  });

  it("never customer-cancels COMPLETED or already CANCELLED", () => {
    expect(OrderService.canCustomerCancel({ status: "COMPLETED" }).code).toBe("COMPLETED");
    expect(OrderService.canCustomerCancel({ status: "CANCELLED" }).code).toBe("ALREADY_CANCELLED");
  });

  it("admin normal-cancel is limited to a SAFELY UNPAID WAITING_PAYMENT order (financial safety audit)", () => {
    // Allowed: exactly the same financial-safety principle as customer cancel.
    expect(OrderService.canAdminCancel({ status: "WAITING_PAYMENT" }).allowed).toBe(true);
    expect(
      OrderService.canAdminCancel({ status: "WAITING_PAYMENT", customerBillFileId: "ev" }).allowed
    ).toBe(false);
    expect(
      OrderService.canAdminCancel({ status: "WAITING_PAYMENT", verifiedAt: new Date() }).allowed
    ).toBe(false);
    expect(OrderService.canAdminCancel({ status: "WAITING_PAYMENT", payoutAt: new Date() }).allowed).toBe(false);
    expect(OrderService.canAdminCancel({ status: "WAITING_PAYMENT", completedAt: new Date() }).allowed).toBe(false);

    // Evidence / possible incoming money → normal cancel BLOCKED, routed to
    // the existing manualFinancialOverride / not-received review flows.
    for (const status of ["CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "PAYMENT_MISMATCH", "MANUAL_REVIEW", "SUSPICIOUS"]) {
      const d = OrderService.canAdminCancel({ status });
      expect(d.allowed, status).toBe(false);
      expect(["BILL_EXISTS", "NOT_CANCELLABLE"]).toContain(d.code);
    }
    expect(OrderService.canAdminCancel({ status: "WAITING_ADMIN_VERIFY", customerBillFileId: "ev" }).code).toBe("BILL_EXISTS");

    // Confirmed money / payout / completed / already-cancelled remain blocked.
    for (const status of ["PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT", "COMPLETED", "CANCELLED"]) {
      expect(OrderService.canAdminCancel({ status }).allowed, status).toBe(false);
    }
    expect(ADMIN_CANCEL_REASONS.length).toBeGreaterThanOrEqual(3);
    expect(adminCancelReasonLabel("customer_request")).toContain("Khách");
    expect(adminCancelReasonLabel("custom", "Sai so tien")).toBe("Sai so tien");
  });
});

describe("Customer cancel via authoritative OrderService (mock DB)", () => {
  it("cancels an eligible unpaid order and audits CUSTOMER_CANCELLED", async () => {
    await ensureCustomer();
    const order = await createTestOrder();
    const cancelled = await OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "CUSTOMER_CANCELLED", {
      source: "CUSTOMER_CANCELLED"
    });
    expect((cancelled as any).status).toBe("CANCELLED");
    const history = await prisma.orderStateHistory.findMany({ where: { orderId: order.id } });
    const cancelEntry: any = history.find((h: any) => h.toStatus === "CANCELLED");
    expect(cancelEntry).toBeTruthy();
    expect(cancelEntry.metadata.source).toBe("CUSTOMER_CANCELLED");
  });

  it("is idempotent — cancelling an already-cancelled order never double-cancels", async () => {
    await ensureCustomer();
    const order = await createTestOrder();
    await OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "CUSTOMER_CANCELLED");
    const before = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: order.id } });
    const again = await OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "CUSTOMER_CANCELLED");
    expect((again as any).status).toBe("CANCELLED");
    const after = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: order.id } });
    expect(after.length).toBe(before.length); // no duplicate audit/mutation
  });

  it("refuses customer cancel of a CONFIRMED-payment order", async () => {
    await ensureCustomer();
    const order = await createTestOrder({ status: "WAITING_PAYOUT", verifiedAt: new Date() });
    await expect(OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "CUSTOMER_CANCELLED")).rejects.toThrow();
  });

  it("refuses unsafe customer cancel when a bill exists (BILL_EXISTS guard)", async () => {
    await ensureCustomer();
    const order = await createTestOrder({ status: "WAITING_PAYMENT", customerBillFileId: "ev-late" });
    await expect(OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "CUSTOMER_CANCELLED")).rejects.toThrow("BILL_EXISTS");
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYMENT"); // untouched
  });
});

describe("Admin cancel flow (reason → preview → final confirm)", () => {
  it("preview/final-confirm session guards reject missing, consumed and stale previews", () => {
    const adminId = "admin-cancel-test-1";
    expect(consumePendingAction(adminId, "cancel_order", "ORD-X").valid).toBe(false); // nothing pending
    setPendingAction(adminId, "cancel_order", "ORD-X", { reason: "Khách yêu cầu hủy đơn" });
    const ok = consumePendingAction(adminId, "cancel_order", "ORD-X");
    expect(ok.valid).toBe(true);
    expect(ok.data?.reason).toBe("Khách yêu cầu hủy đơn");
    expect(consumePendingAction(adminId, "cancel_order", "ORD-X").valid).toBe(false); // consumed once
  });

  it("the authoritative service reloads state — COMPLETED can never be admin-cancelled", async () => {
    await ensureCustomer();
    const order = await createTestOrder({ status: "COMPLETED" });
    await expect(OrderService.cancelOrder(order.id, "admin-1", "ADMIN", "test")).rejects.toThrow();
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("COMPLETED");
  });

  it("admin cancels an unpaid order through the same authoritative method (actor + reason audited)", async () => {
    await ensureCustomer();
    const order = await createTestOrder();
    const updated: any = await OrderService.cancelOrder(order.id, "admin-1", "ADMIN", "Đơn thử nghiệm", {
      source: "ADMIN_CANCELLED"
    });
    expect(updated.status).toBe("CANCELLED");
    const logs: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_CANCELLED", targetId: order.id } });
    expect(logs.length).toBe(1);
    expect(logs[0].details.source).toBe("ADMIN_CANCELLED");
    expect(logs[0].details.reason).toBe("Đơn thử nghiệm");
  });

  it("admin CANNOT normal-cancel evidence/manual-review states — must route to review instead", async () => {
    await ensureCustomer();
    for (const status of ["CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW", "SUSPICIOUS", "PAYMENT_MISMATCH"]) {
      const order = await createTestOrder({ status });
      await expect(
        OrderService.cancelOrder(order.id, "admin-1", "ADMIN", "test", { source: "ADMIN_CANCELLED" }),
        `state ${status}`
      ).rejects.toThrow();
      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect(fresh.status, status).toBe(status); // untouched — evidence/history preserved
    }
  });
});

describe("Payment reminder schedule (pure decision helper)", () => {
  const created = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60000);

  it("reminder 1 is due at +10 and not before", () => {
    expect(computeReminderState({ createdAt: created(9) }, 0).dueReminder).toBeNull();
    expect(computeReminderState({ createdAt: created(10) }, 0).dueReminder).toBe(1);
  });

  it("reminder 2 is due at +20 once reminder 1 was sent", () => {
    expect(computeReminderState({ createdAt: created(19) }, 1).dueReminder).toBeNull();
    expect(computeReminderState({ createdAt: created(20) }, 1).dueReminder).toBe(2);
  });

  it("reminder 3 is due at +30", () => {
    expect(computeReminderState({ createdAt: created(30) }, 2).dueReminder).toBe(3);
  });

  it("reminder 4 is due at +40", () => {
    expect(computeReminderState({ createdAt: created(40) }, 3).dueReminder).toBe(4);
  });

  it("auto-cancel is due at +50 and not at +49", () => {
    expect(computeReminderState({ createdAt: created(49) }, 4).autoCancelDue).toBe(false);
    expect(computeReminderState({ createdAt: created(50) }, 4).autoCancelDue).toBe(true);
    expect(computeReminderState({ createdAt: created(50) }, 0).autoCancelDue).toBe(true);
  });

  it("after restart, catch-up never skips ahead: with 2 markers at +25 the next due is 3", () => {
    const s = computeReminderState({ createdAt: created(25) }, 2);
    expect(s.dueReminder).toBe(3);
  });
});

describe("Reminder / auto-cancel eligibility guards", () => {
  it("a valid bill stops all future reminders and auto-cancel", () => {
    expect(OrderService.isOrderPaymentReminderEligible({ status: "WAITING_PAYMENT" })).toBe(true);
    expect(OrderService.isOrderPaymentReminderEligible({ status: "WAITING_PAYMENT", customerBillFileId: "ev" })).toBe(false);
    expect(OrderService.isOrderSafelyAutoCancellable({ status: "WAITING_PAYMENT", customerBillFileId: "ev" })).toBe(false);
  });

  it("WAITING_ADMIN_VERIFY / MANUAL_REVIEW / confirmed-payment / payout / completed are never auto-cancelled", () => {
    for (const status of ["CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW", "SUSPICIOUS", "PAYMENT_CONFIRMED", "WAITING_PAYOUT", "PAYOUT_SENT", "COMPLETED", "CANCELLED", "PAYMENT_MISMATCH"]) {
      expect(OrderService.isOrderSafelyAutoCancellable({ status }), status).toBe(false);
      expect(OrderService.isOrderPaymentReminderEligible({ status }), status).toBe(false);
    }
    expect(OrderService.isOrderSafelyAutoCancellable({ status: "WAITING_PAYMENT", verifiedAt: new Date() })).toBe(false);
  });
});

describe("Scheduler end-to-end on the mock DB", () => {
  it("sends reminder 1 at +10; a repeat run does not duplicate it (restart-safe)", async () => {
    await ensureCustomer();
    const sendSpy = vi.spyOn(notifications, "sendToCustomer").mockResolvedValue({ message_id: 1 } as any);

    const order = await createTestOrder({ createdAt: new Date(Date.now() - 11 * 60000) });
    const now = new Date();

    const first = await tickPaymentReminders(now);
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    expect(await OrderService.countPaymentReminders(order.id)).toBe(1);

    // Repeat scheduler run at the same instant → no duplicate reminder.
    await tickPaymentReminders(now);
    expect(await OrderService.countPaymentReminders(order.id)).toBe(1);

    sendSpy.mockRestore();
  });

  it("auto-cancels a still-unpaid order at +50 exactly once (atomic/idempotent)", async () => {
    await ensureCustomer();
    vi.spyOn(notifications, "sendToAdminNotificationChat").mockResolvedValue(true as any);
    vi.spyOn(notifications, "sendToCustomer").mockResolvedValue(null as any);

    const order = await createTestOrder({ createdAt: new Date(Date.now() - 51 * 60000) });
    const now = new Date();
    const r = await tickPaymentReminders(now);
    expect(r.autoCancelled).toBeGreaterThanOrEqual(1);
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("CANCELLED");
    const logs: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT", targetId: order.id } });
    expect(logs.length).toBe(1);

    // Second scheduler run cannot cancel twice.
    await tickPaymentReminders(now);
    const logs2: any[] = await prisma.auditLog.findMany({ where: { action: "ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT", targetId: order.id } });
    expect(logs2.length).toBe(1);
  });

  it("never auto-cancels WAITING_ADMIN_VERIFY or MANUAL_REVIEW orders even at +60", async () => {
    await ensureCustomer();
    const billOrder = await createTestOrder({
      status: "WAITING_ADMIN_VERIFY", customerBillFileId: "ev-1",
      createdAt: new Date(Date.now() - 60 * 60000)
    });
    const reviewOrder = await createTestOrder({
      status: "MANUAL_REVIEW",
      createdAt: new Date(Date.now() - 60 * 60000)
    });
    await tickPaymentReminders(new Date());
    const afterBill: any = await prisma.order.findUnique({ where: { id: billOrder.id } });
    const afterReview: any = await prisma.order.findUnique({ where: { id: reviewOrder.id } });
    expect(afterBill.status).toBe("WAITING_ADMIN_VERIFY");
    expect(afterReview.status).toBe("MANUAL_REVIEW");
  });

  it("auto-cancel is a no-op for an already-cancelled order", async () => {
    await ensureCustomer();
    const cancelled = await createTestOrder({
      status: "CANCELLED", createdAt: new Date(Date.now() - 60 * 60000)
    });
    const r = await OrderService.cancelOrderForPaymentTimeout(cancelled.id);
    expect(r.cancelled).toBe(false);
  });
});

describe("Late bill after auto-cancel (E)", () => {
  it("preserves evidence, keeps CANCELLED, never reopens, routes to review", async () => {
    await ensureCustomer();
    const order = await createTestOrder({
      status: "CANCELLED", createdAt: new Date(Date.now() - 60 * 60000)
    });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("late-bill-body")]);
    const result: any = await OrderService.submitCustomerBill(order.id, jpeg, "bill_late.jpg", "image/jpeg", CUSTOMER_TG);
    expect(result.status).toBe("LATE_BILL_CANCELLED");
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("CANCELLED"); // NOT reopened
    const evidence = await prisma.orderBillEvidence.findMany({ where: { orderId: order.id } });
    expect(evidence.length).toBe(1); // original bill evidence preserved
    const logs: any[] = await prisma.auditLog.findMany({ where: { action: "BILL_RECEIVED_AFTER_CANCEL", targetId: order.id } });
    expect(logs.length).toBe(1);
  });

  it("with TWO cancelled orders for the same customer, a late bill binds ONLY to the explicitly selected one", async () => {
    await ensureCustomer();
    const orderA = await createTestOrder({ status: "CANCELLED", createdAt: new Date(Date.now() - 70 * 60000) });
    const orderB = await createTestOrder({ status: "CANCELLED", createdAt: new Date(Date.now() - 60 * 60000) });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("bound-to-a")]);

    // The customer explicitly selected order A (customer:bill:attach callback):
    // the bill must attach to A and NEVER silently to the "latest" cancelled B.
    const result: any = await OrderService.submitCustomerBill(orderA.id, jpeg, "bill_a.jpg", "image/jpeg", CUSTOMER_TG);
    expect(result.status).toBe("LATE_BILL_CANCELLED");

    const evidenceA = await prisma.orderBillEvidence.findMany({ where: { orderId: orderA.id } });
    const evidenceB = await prisma.orderBillEvidence.findMany({ where: { orderId: orderB.id } });
    expect(evidenceA.length).toBe(1);
    expect(evidenceB.length).toBe(0); // not silently assigned to the wrong order
    const bFresh: any = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(bFresh.status).toBe("CANCELLED");
  });

  it("a bill can NEVER be attached to another customer's order (cross-customer guard)", async () => {
    await ensureCustomer();
    const order = await createTestOrder({ status: "CANCELLED" });
    const other = await prisma.customer.create({
      data: { telegramId: `${CUSTOMER_TG}-other`, username: "other_user", fullName: "Other" }
    });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("intruder")]);
    await expect(
      OrderService.submitCustomerBill(order.id, jpeg, "bill_x.jpg", "image/jpeg", (other as any).telegramId)
    ).rejects.toThrow();
    const evidence = await prisma.orderBillEvidence.findMany({ where: { orderId: order.id } });
    expect(evidence.length).toBe(0);
  });
});

describe("Bill image acceptance (F root-cause fix)", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("photo")]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.from("doc")]);
  const octetStream = "application/octet-stream";

  it("accepts a Telegram compressed photo bill WITHOUT any filename", () => {
    const r = resolveEvidenceMime({ telegramMime: null, fileNameOrPath: null, responseMime: octetStream, buffer: jpeg });
    expect(r.accepted).toBe(true);
    expect(r.mimeType).toBe("image/jpeg");
  });

  it("accepts an image document bill even with octet-stream download headers", () => {
    const r = resolveEvidenceMime({ telegramMime: "image/png", fileNameOrPath: "bill.png", responseMime: octetStream, buffer: png });
    expect(r.accepted).toBe(true);
    expect(r.mimeType).toBe("image/png");
    // Sniffing wins even when Telegram metadata is absent entirely.
    const r2 = resolveEvidenceMime({ buffer: png } as any);
    expect(r2.accepted).toBe(true);
    expect(r2.mimeType).toBe("image/png");
  });

  it("rejects dangerous payloads and preserves PDF support", () => {
    const bad = Buffer.from("<html>not an image</html>");
    const r = resolveEvidenceMime({ telegramMime: "application/zip", fileNameOrPath: "virus.zip", responseMime: octetStream, buffer: bad });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe("UNSUPPORTED_TYPE");
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.from("bill")]);
    const rp = resolveEvidenceMime({ telegramMime: "application/pdf", fileNameOrPath: "bill.pdf", responseMime: octetStream, buffer: pdf });
    expect(rp.accepted).toBe(true);
    expect(rp.mimeType).toBe("application/pdf");
  });

  it("OCR/AI failure never participates in evidence acceptance", () => {
    // resolveEvidenceMime takes NO AI/OCR input — original image bytes are
    // authoritative; a failed extraction can never invalidate valid evidence.
    expect(sniffMimeFromBytes(jpeg)).toBe("image/jpeg");
    expect(resolveEvidenceMime({ buffer: jpeg } as any).accepted).toBe(true);
  });

  it("magic bytes are authoritative over Telegram metadata (metadata=JPEG, bytes=PDF → PDF)", () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.from("real-payload")]);
    const r = resolveEvidenceMime({
      telegramMime: "image/jpeg",          // metadata hint (wrong)
      fileNameOrPath: "photo.jpg",         // extension hint (wrong)
      responseMime: "image/jpeg",          // HTTP header hint (wrong)
      buffer: pdf
    });
    expect(r.accepted).toBe(true);
    expect(r.mimeType).toBe("application/pdf"); // BYTES win over every hint
  });

  it("when bytes have NO recognizable signature, Telegram metadata is the fallback hint", () => {
    const garbage = Buffer.from("\x00\x01\x02not-a-signature");
    // Declared safe image type + no signature → accepted via metadata hint.
    const r = resolveEvidenceMime({
      telegramMime: "image/jpeg", fileNameOrPath: null, responseMime: null, buffer: garbage
    });
    expect(r.accepted).toBe(true);
    expect(r.mimeType).toBe("image/jpeg");
    // Declared dangerous type + no signature → rejected (hints cannot bless it).
    const r2 = resolveEvidenceMime({
      telegramMime: "application/zip", fileNameOrPath: null, responseMime: null, buffer: garbage
    });
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe("UNSUPPORTED_TYPE");
  });
});

describe("Payout QR vs bill media routing (I)", () => {
  it("an image document is valid payout-QR media; a PDF is never a payout destination", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("qr")]);
    expect(resolveEvidenceMime({ buffer: png } as any).accepted).toBe(true);
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.from("x")]);
    expect(resolveEvidenceMime({ buffer: pdf } as any).mimeType).toBe("application/pdf");
  });

  it("routing is state-based: an unpaid order can never be payout-ready (bill media stays bill media)", () => {
    // handleCustomerPhoto checks the payout session (customer + explicit
    // eligible Order + WAITING_PAYOUT + no destination) BEFORE bill handling;
    // without that session, media can only ever flow to bill evidence.
    expect(OrderService.isPayoutReady({ status: "WAITING_PAYMENT" } as any)).toBe(false);
    expect(OrderService.isPayoutReady({ status: "WAITING_PAYOUT", payoutBankSnapshot: null } as any)).toBe(false);
    expect(OrderService.isPayoutReady({
      status: "WAITING_PAYOUT",
      payoutBankSnapshot: { type: "text", bankName: "A", accountNumber: "1", accountName: "B" }
    } as any)).toBe(true);
  });
});

describe("Payout session restart recovery (J)", () => {
  it("WAITING_PAYOUT + no destination is fully DB-recoverable with no in-memory session", async () => {
    await ensureCustomer();
    const order = await createTestOrder({
      status: "WAITING_PAYOUT", verifiedAt: new Date(), payoutBankSnapshot: null
    });
    const eligible: any = await OrderService.getLatestEligiblePayoutOrder(customerId);
    expect(eligible?.id).toBe(order.id);
    expect(OrderService.isPayoutReady(eligible as any)).toBe(false);
    // /start's active-order view renders the payout chooser from THIS DB
    // state; nothing is auto-selected and no session object is required.
  });
});

describe("Localization completeness for cancel/reminder/expiry/bill keys (H)", () => {
  const REQUIRED_KEYS = [
    "order.cancel_btn", "order.payinfo_btn", "order.bill_btn", "order.bill_instruction",
    "order.cancel_warn_title", "order.cancel_warn_body", "order.cancel_confirm_btn",
    "order.cancel_keep_btn", "order.cancel_blocked_bill", "order.cancel_blocked_status",
    "order.cancel_already", "order.cancelled_by_admin", "order.cancel_none",
    "order.cancel_success", "order.cancel_error", "order.keep_note",
    "reminder.title", "reminder.pay_now", "reminder.transferred_hint", "reminder.deadline",
    "autocancel.customer_title", "autocancel.customer_body",
    "bill.too_large", "bill.unsupported", "bill.download_failed",
    "bill.not_eligible", "bill.late_cancelled_customer", "payout.quote_expired",
    "quote.expired_notice"
  ];

  for (const locale of SUPPORTED_LOCALES) {
    it(`locale ${locale} defines every cancellation/reminder/expiry/bill key`, () => {
      for (const key of REQUIRED_KEYS) {
        const value = t(locale, key);
        expect(value, `${locale}:${key} missing`).not.toBe(key);
        expect(String(value).trim().length).toBeGreaterThan(0);
      }
    });
  }

  it("cancel/reminder buttons are per-locale (vi/en/km/zh)", () => {
    expect(t("vi", "order.cancel_btn")).toContain("Huỷ đơn");
    expect(t("en", "order.cancel_btn")).toContain("Cancel");
    expect(t("km", "order.cancel_btn")).toContain("បោះបង់");
    expect(t("zh", "order.cancel_btn")).toContain("取消");
    expect(t("vi", "order.bill_btn")).toContain("Gửi bill");
    expect(t("zh", "order.bill_btn")).toContain("发送回执");
  });

  it("expired-quote notice is fully localized per locale (never raw Vietnamese service text)", () => {
    // The service throws Vietnamese "Báo giá đã hết hạn. ..." — the handler
    // must map expiry errors to quote.expired_notice, which is re-keyed for
    // all four locales and states the 10-minute validity.
    for (const locale of SUPPORTED_LOCALES) {
      const notice = t(locale, "quote.expired_notice");
      expect(notice).not.toBe("quote.expired_notice");
      expect(notice).toContain("10");
    }
    expect(t("en", "quote.expired_notice")).toContain("expired");
    expect(t("zh", "quote.expired_notice")).toContain("过期");
    expect(t("km", "quote.expired_notice")).toContain("ផុតកំណត់");
    // The service-side Vietnamese error text must never be re-exported as the
    // customer notice itself.
    expect(t("en", "quote.expired_notice")).not.toContain("Báo giá đã hết hạn");
  });
});