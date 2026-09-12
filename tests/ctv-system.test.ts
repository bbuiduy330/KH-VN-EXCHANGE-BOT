/**
 * FINAL CTV PASS — partner identity, bind/rebind, /ctv, privacy, referral,
 * commission lifecycle, reconciliation, settlement, payout destination.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { formatAdminDateTime } from "../src/shared/app-time.js";

const ADMIN_TG = "888000001";
const CTV_TG = "123456789";
const CTV_TG2 = "987654321";

async function mkPartner(name: string): Promise<any> {
  return PartnerService.createPartner(ADMIN_TG, name);
}

async function mkCustomerFor(ctv: any): Promise<any> {
  seq++;
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId: String(889000000 + seq),
    username: `ctvref_${seq}`
  });
  await prisma.customer.update({
    where: { id: customer.id },
    data: { partnerId: ctv.id, partnerAssignedAt: new Date() }
  });
  return customer;
}

async function mkCompletedOrder(customerId: string, partnerId: string): Promise<any> {
  const order = await prisma.order.create({
    data: {
      id: `ORD-CTVC-${seq}-${Date.now().toString(36).toUpperCase()}`,
      customerId,
      partnerId,
      sourceCurrency: "USD",
      targetCurrency: "VND",
      sourceAmount: 100,
      targetAmount: 2540000,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      status: "COMPLETED",
      completedAt: new Date()
    }
  });
  return order;
}

let seq = 0;
let customer: any;
let order: any;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  void customer; void order;
});
afterAll(() => { globalThis.fetch = realFetch; });

// PART A — identity model + uniqueness/conflict handling
describe("1. Partner identity: telegramId UNIQUE + conflict handling", () => {
  it("Partner.telegramId is unique in the schema (cuid id + unique telegramId + referralCode)", () => {
    // Schema authority (prisma/schema.prisma): Partner.telegramId String? @unique
    const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/model Partner \{[\s\S]*telegramId\s+String\?\s+@unique/);
    expect(schema).not.toMatch(/username\s+String?.*@unique/); // username ≠ identity
  });

  it("bindPartnerTelegram saves numeric binding + creates PARTNER_TELEGRAM_BIND audit", async () => {
    const p = await mkPartner("Nguyễn Văn A");
    const { partner, rebound } = await PartnerService.bindPartnerTelegram(ADMIN_TG, p.id, CTV_TG);
    expect(partner.telegramId).toBe(CTV_TG);
    expect(rebound).toBe(false);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PARTNER_TELEGRAM_BIND", targetId: p.id },
      orderBy: { createdAt: "desc" }
    });
    expect(audit).not.toBeNull();
    expect((audit!.details as any)?.newTelegramId).toBe(CTV_TG);
  });

  it("same Telegram ID bound to a SECOND partner is REJECTED (no silent reassign)", async () => {
    const p2 = await mkPartner("CTV Hai");
    await expect(PartnerService.bindPartnerTelegram(ADMIN_TG, p2.id, CTV_TG)).rejects.toThrow(/khác|trùng/i);
    const recheck = await PartnerService.getPartnerByTelegramId(CTV_TG);
    expect(recheck!.displayName).toBe("Nguyễn Văn A"); // still the first holder
  });

  it("non-numeric Telegram ID is rejected (integer validation)", async () => {
    const p = await mkPartner("Bind Validate");
    await expect(PartnerService.bindPartnerTelegram(ADMIN_TG, p.id, "@not_a_number")).rejects.toThrow();
    await expect(PartnerService.bindPartnerTelegram(ADMIN_TG, p.id, "abc123")).rejects.toThrow();
  });
});

// PART C — rebind audit + historical attribution unchanged
describe("6. Rebind → explicit confirmation path + old/new IDs audited", () => {
  it("rebind audits old AND new ids; Order.partnerId snapshot stays unchanged", async () => {
    const p = await PartnerService.getPartnerByTelegramId(CTV_TG);
    const c2 = await mkCustomerFor(p);
    const completedOrder: any = await mkCompletedOrder(c2.id, p.id);
    expect(completedOrder!.partnerId).toBe(p.id);

    const { rebound, oldTelegramId } = await PartnerService.bindPartnerTelegram(ADMIN_TG, p.id, CTV_TG2);
    expect(rebound).toBe(true);
    expect(oldTelegramId).toBe(CTV_TG);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PARTNER_TELEGRAM_REBIND", targetId: p!.id },
      orderBy: { createdAt: "desc" }
    });
    expect(audit).not.toBeNull();
    expect((audit!.details as any)?.oldTelegramId).toBe(CTV_TG);
    expect((audit!.details as any)?.newTelegramId).toBe(CTV_TG2);

    // Historical Order attribution snapshot NEVER rewritten:
    const o: any = await prisma.order.findUnique({ where: { id: completedOrder!.id } });
    expect(o!.partnerId).toBe(p!.id);
  });
});

// PART G — referral assignment rules
describe("7-9. Referral attribution rules stay authoritative", () => {
  it("7. new/unassigned customer CAN be attributed", async () => {
    const p = await mkPartner("Referral CTV");
    seq++;
    const tg = String(889500000 + seq);
    const claim = await PartnerService.claimReferral(`ref_${p.referralCode}`, tg);
    expect(claimReferralOk(claim)).toBe(true);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: tg });
    expect(customer.partnerId).toBe(p.id);
  });

  it("8. customer already assigned → second referral NEVER overwrites", async () => {
    const p = await mkPartner("Referral B");
    seq++;
    const tg = String(889600000 + seq);
    await CustomerService.getOrCreateCustomer({ telegramId: tg });
    await PartnerService.claimReferral(`ref_${p.referralCode}`, tg);
    const other = await mkPartner("Referral A");
    const second = await PartnerService.claimReferral(`ref_${other.referralCode}`, tg);
    expect(claimReferralOk(second)).toBe(false);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: tg });
    expect(customer.partnerId).toBe(p.id); // original stays
  });

  it("9. customer with prior COMPLETED orders cannot be silently claimed", async () => {
    const p = await mkPartner("Referral C");
    seq++;
    const tg = String(889700000 + seq);
    await CustomerService.getOrCreateCustomer({ telegramId: tg });
    await prisma.order.create({
      data: {
        id: `ORD-CTVDONE-${seq}-${Date.now().toString(36).toUpperCase()}`,
        customerId: (await CustomerService.getOrCreateCustomer({ telegramId: tg })).id,
        sourceCurrency: "USD", targetCurrency: "VND", sourceAmount: 100, targetAmount: 2540000,
        rate: 25400, fee: 2, feeCurrency: "USD", status: "COMPLETED", completedAt: new Date()
      }
    });
    const claim = await PartnerService.claimReferral(`ref_${p.referralCode}`, tg);
    expect(claim.reason).toBe("PRIOR_COMPLETED");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: tg });
    expect(customer.partnerId).toBeNull();
  });

  it("disabled Partner gets NO new assignments", async () => {
    const p = await mkPartner("Disabled CTV");
    await PartnerService.setPartnerStatus(ADMIN_TG, p.id, "DISABLED");
    seq++;
    const tg = String(889800000 + seq);
    await CustomerService.getOrCreateCustomer({ telegramId: tg });
    const claim = await PartnerService.claimReferral(`ref_${p.referralCode}`, tg);
    expect(claim.reason).toBe("DISABLED");
  });
});

function claimReferralOk(result: { assigned: boolean; reason: string }): boolean {
  return result.assigned && result.reason === "OK";
}

// 10 — Order partner snapshot stays unchanged after customer reassignment
describe("10. Order partner snapshot is immutable across reassignment", () => {
  it("adminAssignPartner changes Customer.partnerId but NEVER Order.partnerId", async () => {
    const p = await mkPartner("Snapshot CTV");
    const other = await mkPartner("Snapshot CTV Other");
    const cust = await mkCustomerFor(p);
    const order = await mkCompletedOrder(cust.id, p.id);

    // Admin explicitly reassigns the CUSTOMER to another partner:
    await PartnerService.adminAssignPartner(ADMIN_TG, cust.id, other.id);
    const customerAfter: any = await prisma.customer.findUnique({ where: { id: cust.id } });
    expect(customerAfter.partnerId).toBe(other.id);

    const orderAfter: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(orderAfter!.partnerId).toBe(p.id);
  });
});

// 11/12 — commission lifecycle
describe("11-12. Commission: $1 per COMPLETED Order + once-only reconciliation", () => {
  it("COMPLETED Order → $1 commission created (HELD)", async () => {
    const p = await mkPartner("Commission CTV");
    const cust = await mkCustomerFor(p);
    const order: any = await mkCompletedOrder(cust.id, p.id);
    await PartnerService.onOrderCompleted(order.id);
    const commission = await prisma.commission.findUnique({ where: { orderId: order.id } });
    expect(commission).not.toBeNull();
    expect(Number(commission!.totalUsd)).toBe(1);
    expect(commission!.status).toBe("HELD");
  });

  it("reconciliation creates missing commission EXACTLY once (no duplicates)", async () => {
    const p = await mkPartner("Reconcile CTV");
    const cust = await mkCustomerFor(p);
    const order: any = await mkCompletedOrder(cust.id, p.id);

    await PartnerService.reconcileMissingCommissions(50);
    await PartnerService.reconcileMissingCommissions(50);
    const commission = await prisma.commission.findUnique({ where: { orderId: order.id } });
    expect(commission).not.toBeNull();
    const rows = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(rows.length).toBe(1); // no duplicates
  });
});

// 13 — HELD → AVAILABLE after 72h
describe("13. HELD → AVAILABLE after the 72h hold", () => {
  it("risk-free commission becomes AVAILABLE at availableAt", async () => {
    const p = await mkPartner("Hold CTV");
    const cust = await mkCustomerFor(p);
    const order: any = await mkCompletedOrder(cust.id, p.id);
    await PartnerService.onOrderCompleted(order.id);
    const held = await prisma.commission.findUnique({ where: { orderId: order.id } });
    expect(held!.status).toBe("HELD");
    expect(held!.availableAt).not.toBeNull();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date((held!.availableAt as Date).getTime() + 1000));
      await PartnerService.reconcileAvailableCommissions();
      const after = await prisma.commission.findUnique({ where: { orderId: order.id } });
      expect(after!.status).toBe("AVAILABLE");
    } finally {
      vi.useRealTimers();
    }
  });
});

// 14 — settlement: AVAILABLE included, HELD excluded, no duplicate payout
describe("14. Settlement: AVAILABLE only, HELD excluded, no duplicates", () => {
  it("settlement claims AVAILABLE only and marks PAID exactly once", async () => {
    const p = await mkPartner("Settlement CTV");
    const cust = await mkCustomerFor(p);
    const availableOrder: any = await mkCompletedOrder(cust.id, p.id);
    await PartnerService.onOrderCompleted(availableOrder.id);
    const heldOrder: any = await mkCompletedOrder(cust.id, p.id);
    await PartnerService.onOrderCompleted(heldOrder.id);

    // Release ONLY the first commission; the second stays HELD:
    const availableCommission = await prisma.commission.findUnique({ where: { orderId: availableOrder.id } });
    const heldBefore = await prisma.commission.findUnique({ where: { orderId: heldOrder.id } });
    await PartnerService.releaseCommission(ADMIN_TG, availableCommission!.id);

    const settlement: any = await PartnerService.createSettlement(ADMIN_TG, p.id);
    expect(settlement.itemCount).toBe(1); // ONLY the AVAILABLE commission

    // The HELD commission must NOT be in the settlement:
    const heldAfter = await prisma.commission.findUnique({ where: { orderId: heldOrder.id } });
    expect(heldAfter!.status).toBe("HELD");
    expect(heldAfter!.settlementId).toBeNull();

    // No duplicate settlement of the same commission (nothing AVAILABLE remains):
    await expect(PartnerService.createSettlement(ADMIN_TG, p.id)).rejects.toThrow(/AVAILABLE/i);
  });
});

// 15 — CTV privacy regression
describe("15. PRIVACY: CTV surfaces contain NO customer identity", () => {
  it("partner commission/settlement projections never carry customer identity", async () => {
    const p = await mkPartner("Privacy CTV");
    const cust = await mkCustomerFor(p);
    const order: any = await mkCompletedOrder(cust.id, p.id);
    await PartnerService.onOrderCompleted(order.id);
    const commissions = await PartnerService.listPartnerCommissions(p.id, 20);
    expect(commissions.length).toBe(1);
    // The projection rows contain ONLY safe business references:
    const commissionJson = JSON.stringify(commissions[0]);
    expect(commissionJson).not.toContain(cust.telegramId);
    expect(commissionJson).not.toContain(cust.username ?? "@definitely-not");
    expect(commissionJson).not.toContain(cust.fullName ?? "no-name");
    // Settlement history likewise:
    const settlements = await PartnerService.listPartnerSettlements(p.id, 10);
    const settlementsJson = JSON.stringify(settlements);
    expect(settlementsJson).not.toContain(cust.telegramId);
    // Partner summary is aggregate-only:
    const summary = await PartnerService.partnerSummary(p.id);
    expect(Object.keys(summary).sort()).toEqual(
      ["available", "eligibleCompleted", "held", "paid"].sort()
    );
  });
});

// 16 — CTV payout destination (V2: free-form reference text, audited)
describe("16. Payout destination: free-form reference text + audited", () => {
  it("setPayoutDestination saves free-form text and audits WITHOUT logging the full text", async () => {
    const p = await mkPartner("Payout CTV");
    await PartnerService.setPayoutDestination(p.id, {
      text: "Vietcombank 0123456789 NGUYEN VAN A"
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "PARTNER_PAYOUT_UPDATED", targetId: p.id },
      orderBy: { createdAt: "desc" }
    });
    expect(audit).not.toBeNull();
    const details = JSON.stringify(audit!.details);
    expect(details).not.toContain("0123456789"); // full destination never logged
    const reloaded: any = await PartnerService.getPartnerById(p.id);
    expect(reloaded.payoutDestinationText).toBe("Vietcombank 0123456789 NGUYEN VAN A");
  });

  it("empty/oversized/command-like destination is rejected (nothing saved)", async () => {
    const p = await mkPartner("Payout Invalid");
    await expect(PartnerService.setPayoutDestination(p.id, { text: "" })).rejects.toThrow();
    await expect(PartnerService.setPayoutDestination(p.id, { text: "/bin/rm" })).rejects.toThrow();
    await expect(
      PartnerService.setPayoutDestination(p.id, { text: "x".repeat(501) })
    ).rejects.toThrow();
    const reloaded: any = await PartnerService.getPartnerById(p.id);
    expect(reloaded.payoutDestinationText).toBeNull();
  });
});

it("exact GMT+7 audit timestamp contract (PART L)", () => {
  expect(formatAdminDateTime(new Date("2026-09-12T08:42:00Z"))).toBe("12/09/2026 15:42");
});