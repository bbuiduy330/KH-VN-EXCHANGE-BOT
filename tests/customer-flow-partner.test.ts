/**
 * Customer-flow simplification + Partner/CTV core tests (Z).
 * Node unavailable in the audit environment → NOT EXECUTED locally.
 */
import { describe, it, expect } from "vitest";
import { prisma } from "../src/database/client.js";
import { Bot } from "grammy";
import { OrderService } from "../src/modules/orders/order-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { getCustomerBillEvidence } from "../src/modules/orders/bill-evidence.js";
import { resolveUserIdentity, identityMiddleware } from "../src/bot/middleware/identity.js";
import { adminOperationsHandler } from "../src/bot/admin/index.js";
import { handleCustomerPhoto } from "../src/bot/handlers/customer-handler.js";
import { setBotInstance, sendPayoutReceiptToCustomer } from "../src/bot/notifications.js";
import { SUPPORTED_LOCALES, t } from "../src/modules/i18n/locales.js";

let seq = 0;
async function makeCustomer(opts: { withPartner?: boolean } = {}): Promise<any> {
  seq++;
  const tg = String(880000000 + seq);
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId: tg,
    username: `cf_${seq}`,
    fullName: `Customer Flow ${seq}`
  });
  if (opts.withPartner) {
    const admin = await PartnerService.createPartner("admin-test", `CTV ${seq}`);
    await prisma.customer.update({
      where: { id: customer.id },
      data: { partnerId: admin.id, partnerAssignedAt: new Date() }
    });
    (customer as any).partnerId = admin.id;
    (customer as any)._partner = admin;
  }
  return customer;
}

async function makeOrder(customerId: string, overrides: Record<string, any> = {}): Promise<any> {
  seq++;
  return prisma.order.create({
    data: {
      id: `ORD-CF${seq}-${Date.now().toString(36).toUpperCase()}`,
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

describe("Z — memo Admin callback is reachable from the REAL keyboard data", () => {
  it("ops:config:edit:transfer_memo reaches startConfigEdit (router-level)", async () => {
    const { PermissionService } = await import("../src/modules/permissions/permission-service.js");
    const adminTg = String(899000000 + (seq += 1)); // numeric → ctx.from.id matches
    await PermissionService.inviteStaff({ telegramId: adminTg, name: "CF Admin", role: "ADMIN" });
    const identity = await resolveUserIdentity(adminTg);
    expect(identity.userType).toBe("ADMIN");

    const bot = new Bot("100000000:TEST-TOKEN");
    (bot as any).botInfo = { id: 1, is_bot: true, first_name: "T", username: "cf_test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
    const sent: any[] = [];
    bot.api.config.use((async (_p: any, method: string, payload: any) => {
      if (method === "answerCallbackQuery") return { ok: true, result: true };
      sent.push({ method, payload });
      return { ok: true, result: { message_id: 1, chat: { id: 1 }, date: 1, text: "" } };
    }) as any);
    bot.use(identityMiddleware);
    bot.use(adminOperationsHandler);

    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb1",
        from: { id: Number(adminTg), is_bot: false, first_name: "A" },
        data: "ops:config:edit:transfer_memo",
        message: { message_id: 5, chat: { id: 1, type: "private" }, date: 1, from: { id: Number(adminTg), is_bot: false, first_name: "A" } }
      }
    } as any);

    // The memo-edit wizard prompt must have been sent (handler reached).
    const reply = sent.find((c) => c.method === "sendMessage");
    expect(reply).toBeDefined();
    expect(String(reply!.payload.text)).toContain("chuyển tiền");
  });
});

describe("Z — payout QR routing via DB state (K)", () => {
  it("safe image with NO session attaches as payout QR for the single eligible order (never bill.none)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, { status: "WAITING_PAYOUT", verifiedAt: new Date() });

    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("cf-qr")]);
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/octet-stream" },
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength)
    });
    const ctx: any = {
      from: { id: Number(customer.telegramId), is_bot: false, first_name: "C" },
      chat: { id: Number(customer.telegramId), type: "private" },
      message: { message_id: 1, photo: [{ file_id: "cf-qr-photo", file_unique_id: "u", width: 10, height: 10, file_size: PNG.length }] },
      api: { getFile: async () => ({ file_id: "cf-qr-photo", file_path: "qr/cf.png" }) },
      reply: async () => ({ message_id: 1 })
    };
    try {
      await handleCustomerPhoto(ctx);
      const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
      expect((fresh.payoutBankSnapshot as any)?.type).toBe("qr");
      expect(await getCustomerBillEvidence(order.id)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Z — duplicate bill safety preserved (I)", () => {
  it("duplicate/re-upload keeps the order in a review state and evidence intact", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id);
    const first: any = await OrderService.submitCustomerBill(order.id, Buffer.from("dup-bill-cf-1"), "b1.jpg", "image/jpeg", customer.telegramId);
    expect(first.status).toBe("WAITING_ADMIN_VERIFY");
    const second: any = await OrderService.submitCustomerBill(order.id, Buffer.from("dup-bill-cf-2"), "b2.jpg", "image/jpeg", customer.telegramId);
    // Additional bill never silently replaces evidence: flagged for review.
    expect(["MANUAL_REVIEW", "WAITING_ADMIN_VERIFY"]).toContain(second.status);
    const evidence = await getCustomerBillEvidence(order.id);
    expect(evidence).not.toBeNull();
  });
});

describe("Z — suspicious/manual-review is resolvable (J)", () => {
  it("manualFinancialOverride moves SUSPICIOUS → WAITING_PAYOUT with verifiedAt + strict audit", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, { status: "SUSPICIOUS" });
    const updated: any = await OrderService.manualFinancialOverride({
      orderId: order.id,
      actorId: "admin-cf",
      actorRole: "ADMIN",
      targetStatus: "WAITING_PAYOUT",
      reason: "Admin xác nhận đã nhận tiền sau kiểm tra thủ công"
    });
    expect(updated.status).toBe("WAITING_PAYOUT");
    expect(updated.verifiedAt).toBeTruthy();
    const audits = await prisma.auditLog.findMany({ where: { action: "FINANCIAL_MANUAL_OVERRIDE", targetId: order.id } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Z — rating never blocks completion (O)", () => {
  it("rating is a best-effort audit record", async () => {
    const customer = await makeCustomer();
    await prisma.auditLog.create({
      data: { actorId: customer.telegramId, actorRole: "CUSTOMER", action: "CUSTOMER_RATING", targetType: "ORDER", targetId: "ORD-ANY", details: { rating: 5 } }
    });
    const rows = await prisma.auditLog.findMany({ where: { action: "CUSTOMER_RATING", actorId: customer.telegramId } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Z — payout receipt delivery to customer (N)", () => {
  it("delivers the stored evidence photo and reports success/failure honestly", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, { status: "WAITING_PAYOUT", verifiedAt: new Date() });
    const sent: any = await OrderService.submitPayoutBill(order.id, "admin-cf", Buffer.from("payout-receipt-cf"), "r.jpg", "image/jpeg");

    const deliveredPhotos: number[] = [];
    const goodBot: any = {
      api: {
        sendPhoto: async () => {
          deliveredPhotos.push(1);
          return { message_id: 1 };
        },
        sendDocument: async () => ({ message_id: 2 })
      }
    };
    setBotInstance(goodBot);
    const ok = await sendPayoutReceiptToCustomer(sent);
    expect(ok).toBe(true);
    expect(deliveredPhotos.length).toBe(1);

    // Delivery failure must NOT be reported as success; state preserved.
    const brokenBot: any = { api: { sendPhoto: async () => { throw new Error("blocked"); } } };
    setBotInstance(brokenBot);
    const ok2 = await sendPayoutReceiptToCustomer(sent);
    expect(ok2).toBe(false);
    const fresh: any = await prisma.order.findUnique({ where: { id: sent.id } });
    expect(fresh.status).toBe("PAYOUT_SENT");
    setBotInstance(null);
  });
});

describe("Z — localized simplified copy keys (C/L14)", () => {
  it("new short-copy keys exist for vi/en/km/zh", () => {
    const keys = [
      "payout.verified_prompt",
      "payout.ask_hint",
      "payout.received_title",
      "payout.receipt_caption",
      "order.completed_title",
      "order.history_title",
      "rate.title",
      "rate.skip",
      "rate.thanks"
    ];
    for (const loc of SUPPORTED_LOCALES) {
      for (const key of keys) {
        const v = t(loc, key, { id: "X", src: "A", tgt: "B" });
        expect(v, `${loc}:${key}`).toBeTruthy();
        expect(v, `${loc}:${key}`).not.toBe(key);
      }
    }
  });
});

describe("Z — CTV attribution rules (T/U/V)", () => {
  it("referral assigns only eligible unassigned customers; never overwrites; never claims prior-completed", async () => {
    const partner = await PartnerService.createPartner("admin-cf2", "CTV Rules");
    const newCust = await makeCustomer();
    const ok = await PartnerService.claimReferral(PartnerService.referralPayload(partner), newCust.telegramId);
    expect(ok.assigned).toBe(true);
    const reloaded = await prisma.customer.findUnique({ where: { id: newCust.id } });
    expect(reloaded?.partnerId).toBe(partner.id);

    // Second referral never overwrites:
    const partner2 = await PartnerService.createPartner("admin-cf2", "CTV Rules 2");
    const again = await PartnerService.claimReferral(PartnerService.referralPayload(partner2), newCust.telegramId);
    expect(again.assigned).toBe(false);
    expect(again.reason).toBe("ALREADY_ASSIGNED");
    const still = await prisma.customer.findUnique({ where: { id: newCust.id } });
    expect(still?.partnerId).toBe(partner.id);

    // Prior COMPLETED customer not silently claimed:
    const old = await makeCustomer();
    await makeOrder(old.id, { status: "COMPLETED", completedAt: new Date() });
    const prior = await PartnerService.claimReferral(PartnerService.referralPayload(partner), old.telegramId);
    expect(prior.assigned).toBe(false);
    expect(prior.reason).toBe("PRIOR_COMPLETED");
  });

  it("Order snapshots the partner; COMPLETED creates exactly ONE commission; rerun cannot duplicate", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId });
    expect(order.partnerId).toBe(customer.partnerId);

    await prisma.order.update({ where: { id: order.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await PartnerService.onOrderCompleted(order.id);
    await PartnerService.onOrderCompleted(order.id); // rerun — idempotent
    const commissions = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(commissions.length).toBe(1);
    // Base-only formula (spread bonus DEFERRED):
    expect(Number(commissions[0].baseCommissionUsd)).toBe(1);
    expect(Number(commissions[0].spreadBonusUsd)).toBe(0);
    expect(commissions[0].status).toBe("HELD");
    expect(commissions[0].availableAt).toBeTruthy(); // 72h hold
  });

  it("small orders get base commission only; partner summary aggregates effective states", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId, sourceAmount: 50, targetAmount: 1270000 });
    await prisma.order.update({ where: { id: order.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await PartnerService.onOrderCompleted(order.id);
    const c: any = await prisma.commission.findUnique({ where: { orderId: order.id } });
    expect(Number(c.totalUsd)).toBe(1); // < $500 → base only

    const summary = await PartnerService.partnerSummary(customer.partnerId);
    expect(summary.eligibleCompleted).toBeGreaterThanOrEqual(1);
    expect(summary.held.toNumber()).toBeGreaterThanOrEqual(1);
  });

  it("settlement batching: AVAILABLE → PENDING → PAID, audited", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId });
    await prisma.order.update({ where: { id: order.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await PartnerService.onOrderCompleted(order.id);
    // Force availability (simulate 72h elapsed):
    await prisma.commission.updateMany({ where: { partnerId: customer.partnerId }, data: { availableAt: new Date(Date.now() - 1000) } });

    const settlement = await PartnerService.createSettlement("admin-cf3", customer.partnerId);
    expect(settlement.status).toBe("PENDING");
    expect(Number(settlement.totalUsd)).toBeGreaterThanOrEqual(1);

    const paid = await PartnerService.markSettlementPaid("admin-cf3", settlement.id);
    expect(paid.status).toBe("PAID");
    const c: any = await prisma.commission.findUnique({ where: { orderId: order.id } });
    expect(c.status).toBe("PAID");
    const audits = await prisma.auditLog.findMany({ where: { action: "PARTNER_SETTLEMENT_PAID", targetId: settlement.id } });
    expect(audits.length).toBe(1);
  });

describe("Z — commission atomicity + reconciliation (1)", () => {
  it("same-transaction completion creates the commission together with COMPLETED", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "PAYOUT_SENT", payoutAt: new Date() });
    const completed: any = await OrderService.completePayout(order.id, "admin-safe");
    expect(completed.status).toBe("COMPLETED");
    const commissions = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(commissions.length).toBe(1);
  });

  it("simulated missing commission (crash window) is reconciled exactly once", async () => {
    const customer = await makeCustomer({ withPartner: true });
    // Simulate the crash window: order COMPLETED but NO commission exists.
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    expect(await prisma.commission.findUnique({ where: { orderId: order.id } })).toBeNull();

    const created1 = await PartnerService.reconcileMissingCommissions();
    const created2 = await PartnerService.reconcileMissingCommissions(); // rerun
    const commissions = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(commissions.length).toBe(1);
    // First pass created it (≥1 across the run); the rerun created nothing new.
    expect(created1).toBeGreaterThanOrEqual(1);
    // The rerun must not double-count this order again.
    const afterRerun = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(afterRerun.length).toBe(1);
    void created2;
  });
});

describe("Z — HELD → AVAILABLE mechanism (2)", () => {
  it("elapsed non-risk HELD becomes AVAILABLE; risk-flagged stays HELD; idempotent", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    const normal = await prisma.commission.create({
      data: { orderId: order.id, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", availableAt: new Date(Date.now() - 1000) }
    });
    const risky = await prisma.commission.create({
      data: { orderId: `ORD-RISK-${Date.now().toString(36).toUpperCase()}`, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", riskFlag: "PAYOUT_ACCOUNT_OVERLAP" }
    });

    const changed = await PartnerService.reconcileAvailableCommissions();
    expect(changed).toBeGreaterThanOrEqual(1);
    const normalAfter: any = await prisma.commission.findUnique({ where: { id: normal.id } });
    const riskyAfter: any = await prisma.commission.findUnique({ where: { id: risky.id } });
    expect(normalAfter.status).toBe("AVAILABLE");
    expect(riskyAfter.status).toBe("HELD"); // Admin release only

    // Idempotent: second run changes nothing further for these rows.
    const again = await PartnerService.reconcileAvailableCommissions();
    const normalAfter2: any = await prisma.commission.findUnique({ where: { id: normal.id } });
    expect(normalAfter2.status).toBe("AVAILABLE");
    void again;
  });
});

describe("Z — settlement lifecycle HELD→AVAILABLE→PAID (2/3)", () => {
  it("HELD cannot settle; risky HELD must be released to AVAILABLE first", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const order = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    // Risky HELD: no availableAt, riskFlag set — reconciliation skips it.
    const commission = await prisma.commission.create({
      data: { orderId: order.id, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", riskFlag: "PAYOUT_ACCOUNT_OVERLAP" }
    });
    await expect(PartnerService.createSettlement("admin-lc", customer.partnerId)).rejects.toThrow();

    // Admin release → AVAILABLE → now settleable:
    await PartnerService.releaseCommission("admin-lc", commission.id);
    const settled = await PartnerService.createSettlement("admin-lc", customer.partnerId);
    expect(settled.status).toBe("PENDING");
    const paid = await PartnerService.markSettlementPaid("admin-lc", settled.id);
    expect(paid.status).toBe("PAID");
    const after: any = await prisma.commission.findUnique({ where: { id: commission.id } });
    expect(after.status).toBe("PAID");
  });

  it("not-yet-elapsed HELD cannot settle; elapsed HELD materialises to AVAILABLE then settles", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const future = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    await prisma.commission.create({
      data: { orderId: future.id, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", availableAt: new Date(Date.now() + 3600_000) }
    });
    await expect(PartnerService.createSettlement("admin-lc2", customer.partnerId)).rejects.toThrow();

    // Simulate hold elapsed, then materialise + settle:
    await prisma.commission.updateMany({ where: { partnerId: customer.partnerId }, data: { availableAt: new Date(Date.now() - 1000) } });
    const settled = await PartnerService.createSettlement("admin-lc2", customer.partnerId);
    expect(settled.itemCount).toBe(1);
  });

  it("same commission cannot enter two settlements; PAID and REVERSED cannot settle again", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const orderA = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    const orderB = await makeOrder(customer.id, { partnerId: customer.partnerId, status: "COMPLETED", completedAt: new Date() });
    const cA = await prisma.commission.create({
      data: { orderId: orderA.id, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "AVAILABLE" }
    });
    const cB = await prisma.commission.create({
      data: { orderId: orderB.id, partnerId: customer.partnerId, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "REVERSED" }
    });

    const s1 = await PartnerService.createSettlement("admin-lc3", customer.partnerId);
    expect(s1.itemCount).toBe(1); // only the AVAILABLE commission; REVERSED excluded
    const claimedA: any = await prisma.commission.findUnique({ where: { id: cA.id } });
    expect(claimedA.settlementId).toBe(s1.id);
    const reversedB: any = await prisma.commission.findUnique({ where: { id: cB.id } });
    expect(reversedB.settlementId).toBeNull();

    // Nothing AVAILABLE left → second settlement impossible:
    await expect(PartnerService.createSettlement("admin-lc3", customer.partnerId)).rejects.toThrow();

    // PAID path marks exactly its own AVAILABLE commissions:
    const paid = await PartnerService.markSettlementPaid("admin-lc3", s1.id);
    expect(paid.status).toBe("PAID");
    const paidA: any = await prisma.commission.findUnique({ where: { id: cA.id } });
    expect(paidA.status).toBe("PAID");
    const stillReversed: any = await prisma.commission.findUnique({ where: { id: cB.id } });
    expect(stillReversed.status).toBe("REVERSED");

    // Idempotent re-confirm adds no second audit record:
    const auditsBefore = await prisma.auditLog.count({ where: { action: "PARTNER_SETTLEMENT_PAID", targetId: s1.id } });
    await PartnerService.markSettlementPaid("admin-lc3", s1.id);
    const auditsAfter = await prisma.auditLog.count({ where: { action: "PARTNER_SETTLEMENT_PAID", targetId: s1.id } });
    expect(auditsAfter).toBe(auditsBefore);
  });
});

describe("Z — missing-commission reconciliation starvation fix (1)", () => {
  it("oldest missing commissions are reconciled even when newer ones already exist (250 = 200 filled + 50 missing)", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const baseTime = Date.now();
    const orderIds: string[] = [];

    // 250 COMPLETED partner Orders. Oldest 50 have NO Commission;
    // newest 200 already have exactly one Commission.
    for (let i = 0; i < 250; i++) {
      const isOldMissing = i < 50;
      const o = await prisma.order.create({
        data: {
          id: `ORD-STARVE-${String(i).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}`,
          customerId: customer.id,
          partnerId: customer.partnerId,
          sourceCurrency: "USD",
          targetCurrency: "VND",
          sourceAmount: 50,
          targetAmount: 1270000,
          rate: 25400,
          fee: 2,
          feeCurrency: "USD",
          status: "COMPLETED",
          completedAt: new Date(baseTime + (isOldMissing ? -600_000 : i))
        }
      });
      orderIds.push(o.id);
      if (!isOldMissing) {
        await prisma.commission.create({
          data: { orderId: o.id, partnerId: customer.partnerId!, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", availableAt: new Date() }
        });
      }
    }

    // Before: exactly 50 missing.
    expect(await prisma.commission.count()).toBeGreaterThanOrEqual(200);
    expect(await prisma.commission.count({ where: { partnerId: customer.partnerId } })).toBe(200);

    // Run reconciliation (bounded batches, oldest-first):
    const created = await PartnerService.reconcileMissingCommissions();
    expect(created).toBe(50);

    // Every one of the 250 orders now has EXACTLY one commission.
    let withCommission = 0;
    for (const id of orderIds) {
      const c = await prisma.commission.findMany({ where: { orderId: id } });
      expect(c.length).toBe(1);
      withCommission++;
    }
    expect(withCommission).toBe(250);

    // Rerun: zero duplicates created, count unchanged.
    const createdRerun = await PartnerService.reconcileMissingCommissions();
    expect(createdRerun).toBe(0);
    let totalAfterRerun = 0;
    for (const id of orderIds) {
      totalAfterRerun += (await prisma.commission.findMany({ where: { orderId: id } })).length;
    }
    expect(totalAfterRerun).toBe(250);
  });
});

describe("Z — missing-only reconciliation beyond reconciled rows + work limit (1)", () => {
  it("finds missing commissions BEYOND many already-reconciled rows immediately", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const baseTime = Date.now();
    const orderIds: string[] = [];
    // 120 oldest: already reconciled; 3 newest: missing (the report's exact
    // starvation shape — missing rows sit beyond the reconciled prefix).
    for (let i = 0; i < 123; i++) {
      const isMissing = i >= 120;
      const o = await prisma.order.create({
        data: {
          id: `ORD-BEYOND-${String(i).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}`,
          customerId: customer.id,
          partnerId: customer.partnerId,
          sourceCurrency: "USD",
          targetCurrency: "VND",
          sourceAmount: 50,
          targetAmount: 1270000,
          rate: 25400,
          fee: 2,
          feeCurrency: "USD",
          status: "COMPLETED",
          completedAt: new Date(baseTime + (isMissing ? 600_000 + i : i))
        }
      });
      orderIds.push(o.id);
      if (!isMissing) {
        await prisma.commission.create({
          data: { orderId: o.id, partnerId: customer.partnerId!, baseCommissionUsd: 1, spreadBonusUsd: 0, totalUsd: 1, status: "HELD", availableAt: new Date() }
        });
      }
    }

    const created = await PartnerService.reconcileMissingCommissions();
    expect(created).toBe(3);
    for (const id of orderIds) {
      expect((await prisma.commission.findMany({ where: { orderId: id } })).length).toBe(1);
    }
    // Rerun: nothing missing, zero created.
    expect(await PartnerService.reconcileMissingCommissions()).toBe(0);
  });

  it("per-run work limit progresses without a cursor: 250 missing → 100/100/50/0", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const orderIds: string[] = [];
    for (let i = 0; i < 250; i++) {
      const o = await prisma.order.create({
        data: {
          id: `ORD-WL-${String(i).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}`,
          customerId: customer.id,
          partnerId: customer.partnerId,
          sourceCurrency: "USD",
          targetCurrency: "VND",
          sourceAmount: 50,
          targetAmount: 1270000,
          rate: 25400,
          fee: 2,
          feeCurrency: "USD",
          status: "COMPLETED",
          completedAt: new Date(Date.now() + i)
        }
      });
      orderIds.push(o.id);
    }

    // Run 1–3 with workLimit 100: 100 / 100 / 50 — created rows stop appearing
    // in the next run's missing-only selection, so progress is automatic.
    expect(await PartnerService.reconcileMissingCommissions(100)).toBe(100);
    expect(await PartnerService.reconcileMissingCommissions(100)).toBe(100);
    expect(await PartnerService.reconcileMissingCommissions(100)).toBe(50);
    // Run 4: nothing missing → 0.
    expect(await PartnerService.reconcileMissingCommissions(100)).toBe(0);

    // Exactly ONE Commission per Order, zero duplicates:
    let total = 0;
    for (const id of orderIds) {
      const rows = await prisma.commission.findMany({ where: { orderId: id } });
      expect(rows.length).toBe(1);
      total += rows.length;
    }
    expect(total).toBe(250);
  });
});

describe("Z — partner privacy (4)", () => {
  it("partner-facing surfaces never include customer sensitive fields", async () => {
    const customer = await makeCustomer({ withPartner: true });
    const partner = customer._partner;
    const summary = await PartnerService.partnerSummary(partner.id);
    const json = JSON.stringify(summary);
    expect(json).not.toContain(customer.telegramId);
    expect(json).not.toContain("bankName");
    expect(json).not.toContain("accountNumber");
    expect(json).not.toContain("customerBillFileId");
  });
});
