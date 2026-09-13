import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import {
  getUplineChain,
  validateParentAssignment,
  computeCommissionableSpread,
  CTV_RULE_VERSION,
  FIXED_COMMISSION_BY_LEVEL,
  MAX_CTV_LEVELS
} from "../src/modules/partner/partner-hierarchy.js";

/**
 * PART E — multi-level CTV (max 5): hierarchy, cycle prevention, fixed tier
 * amounts, L1 spread share, frozen snapshot immutability, legacy preservation.
 */

const uniqueId = () => `ml-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(() => {
  void prisma;
});

async function mkPartner(name: string, parentPartnerId?: string | null): Promise<any> {
  const p = await PartnerService.createPartner("admin-ml", `${name}-${uniqueId().slice(-4)}`);
  if (parentPartnerId) {
    await prisma.partner.update({ where: { id: p.id }, data: { parentPartnerId } });
  }
  return prisma.partner.findUnique({ where: { id: p.id } });
}

async function mkCompletedOrder(customerId: string, partnerId: string, rateMarginSnapshot?: object): Promise<any> {
  const order = await prisma.order.create({
    data: {
      id: `ORD-ML-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1e6)}`,
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
      completedAt: new Date(),
      rateMarginSnapshot: rateMarginSnapshot ?? undefined
    } as any
  });
  // Directly AVAILABLE L1 commission (same pattern as existing tests):
  await prisma.commission.create({
    data: {
      orderId: order.id,
      partnerId,
      level: 1,
      baseCommissionUsd: 1,
      spreadBonusUsd: 0,
      totalUsd: 1,
      status: "AVAILABLE",
      availableAt: new Date()
    }
  });
  return order;
}

describe("Part E — hierarchy rules (E1)", () => {
  it("traverses L1..L5 and stops at MAX levels", () => {
    const map = new Map<string, string | null>([
      ["A", null], ["B", "A"], ["C", "B"], ["D", "C"], ["E", "D"], ["F", "E"]
    ]);
    const chain = getUplineChain(map, "F"); // F→E→D→C→B→A would be 6 deep
    expect(chain.length).toBe(MAX_CTV_LEVELS);
    expect(chain[0]).toEqual({ level: 1, partnerId: "F" });
    expect(chain[4]).toEqual({ level: 5, partnerId: "B" }); // A cut off at depth cap
  });

  it("validateParentAssignment blocks self-parent, cycles and over-deep chains", () => {
    const map = new Map<string, string | null>([
      ["A", null], ["B", "A"], ["C", "B"], ["D", "C"], ["E", "D"]
    ]);
    expect(validateParentAssignment(map, "A", "A")).toContain("chính nó");
    // E is already 4 deep under A; making A a child of E would create a cycle:
    expect(validateParentAssignment(map, "A", "E")).toContain("vòng lặp");
    expect(validateParentAssignment(map, "A", "D")).toContain("vòng lặp");
    // L6 → L1 keeps the chain within the 5-level traversal boundary:
    const deep = new Map<string, string | null>([
      ["L1", null], ["L2", "L1"], ["L3", "L2"], ["L4", "L3"], ["L5", "L4"], ["L6", "L5"]
    ]);
    expect(validateParentAssignment(deep, "L6", "L1")).toBeNull();
    // But a parent whose own upline is already 5 deep would push past the cap:
    const over = new Map<string, string | null>([
      ["A", null], ["B", "C"], ["C", "D"], ["D", "E"], ["E", "F"], ["F", "G"], ["G", null]
    ]);
    expect(validateParentAssignment(over, "A", "B")).toContain("quá sâu");
  });

  it("getUplineChain is cycle-safe (a corrupt cycle cannot loop forever)", () => {
    const map = new Map<string, string | null>([
      ["A", "B"], ["B", "A"]
    ]);
    const chain = getUplineChain(map, "A");
    expect(chain.length).toBeLessThanOrEqual(MAX_CTV_LEVELS);
  });
});

describe("Part E — spread math (E3, Decimal only)", () => {
  it("USD→VND: spreadVnd = sourceUsd × buyMargin; commissionable = /baseRate; share = 20%", () => {
    const { shareUsd, basis } = computeCommissionableSpread({
      sourceCurrency: "USD",
      sourceAmount: "100",
      targetCurrency: "VND",
      targetAmount: "2540000",
      rateMarginSnapshot: { baseRate: "25400", buyMargin: "50", sellMargin: "100" }
    });
    // spreadVnd = 100 × 50 = 5000; commissionable = 5000 / 25400; share = 20%
    expect(basis!.direction).toBe("USD_TO_VND");
    expect(Number(shareUsd).toFixed(6)).toBe("0.039370");
  });

  it("VND→USD: spreadVnd = targetUsd × sellMargin; commissionable = /baseRate; share = 20%", () => {
    const { shareUsd, basis } = computeCommissionableSpread({
      sourceCurrency: "VND",
      sourceAmount: "63500000",
      targetCurrency: "USD",
      targetAmount: "2500",
      rateMarginSnapshot: { baseRate: "25400", buyMargin: "50", sellMargin: "100" }
    });
    // spreadVnd = 2500 × 100 = 250000; commissionable = 250000 / 25400
    expect(basis!.direction).toBe("VND_TO_USD");
    expect(Number(shareUsd).toFixed(4)).toBe("1.9685");
  });

  it("missing/invalid frozen basis ⇒ null (never invented)", () => {
    expect(computeCommissionableSpread({ sourceCurrency: "USD", sourceAmount: "1", targetCurrency: "VND", targetAmount: "1" }).shareUsd).toBeNull();
    expect(
      computeCommissionableSpread({
        sourceCurrency: "USD", sourceAmount: "1", targetCurrency: "VND", targetAmount: "1",
        rateMarginSnapshot: { baseRate: "0", buyMargin: "50", sellMargin: "50" }
      }).shareUsd
    ).toBeNull();
  });
});

describe("Part E — multi-level commission engine (E2/E6/E7)", () => {
  it("creates L2..L5 rows with EXACT fixed amounts; legacy L1 row preserved", async () => {
    // Legacy commission row (pre-existing data, level defaults to 1):
    const legacyPartner = await mkPartner("Legacy");
    const legacyCustomer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const legacyOrder = await mkCompletedOrder(legacyCustomer.id, legacyPartner.id, { baseRate: "25400", buyMargin: "50", sellMargin: "50" });
    void legacyOrder;

    // Build a 5-level chain: P1←P2←P3←P4←P5 (P5 is the direct partner of the Order)
    const p1 = await mkPartner("L1 Root");
    const p2 = await mkPartner("L2", p1.id);
    const p3 = await mkPartner("L3", p2.id);
    const p4 = await mkPartner("L4", p3.id);
    const p5 = await mkPartner("L5 Direct", p4.id);
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const order = await mkCompletedOrder(customer.id, p5.id, {
      baseRate: "25400", buyMargin: "50", sellMargin: "50"
    });

    // Run the multi-level engine (creates the missing upline rows):
    await PartnerService.onOrderCompleted(order.id);
    const rows: any[] = await prisma.commission.findMany({ where: { orderId: order.id } });
    const byPartner = new Map(rows.map((r) => [r.partnerId, r]));

    // L1 row already existed (legacy-style) — must NOT be duplicated:
    expect(rows.filter((r) => r.partnerId === p5.id).length).toBe(1);
    expect(rows.length).toBeGreaterThanOrEqual(4);

    // Exact fixed amounts per level (E2):
    expect(Number(byPartner.get(p4.id)!.baseCommissionUsd)).toBe(Number(FIXED_COMMISSION_BY_LEVEL[2]));
    expect(Number(byPartner.get(p3.id)!.baseCommissionUsd)).toBe(Number(FIXED_COMMISSION_BY_LEVEL[3]));
    expect(Number(byPartner.get(p2.id)!.baseCommissionUsd)).toBe(Number(FIXED_COMMISSION_BY_LEVEL[4]));
    expect(Number(byPartner.get(p1.id)!.baseCommissionUsd)).toBe(Number(FIXED_COMMISSION_BY_LEVEL[5]));
    // Full network fixed total = exactly 0.4+0.3+0.2+0.1 = 1.00 (L2..L5):
    const network = rows
      .filter((r) => r.level >= 2)
      .reduce((acc, r) => acc + Number(r.baseCommissionUsd), 0);
    expect(network).toBeCloseTo(1, 5);
    // Rule version + frozen snapshot present on every new row:
    expect(rows.every((r) => r.ruleVersion === CTV_RULE_VERSION || r.level === 1)).toBe(true);
    expect(byPartner.get(p4.id)!.hierarchySnapshot).toBeTruthy();
    // Legacy row untouched:
    const legacyRows: any[] = await prisma.commission.findMany({ where: { orderId: legacyOrder.id } });
    expect(legacyRows.length).toBe(1);
  });

  it("missing upline is NOT redistributed (no invented L2..L5 rows)", async () => {
    const p5 = await mkPartner("Solo Direct");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const order = await mkCompletedOrder(customer.id, p5.id);
    await PartnerService.onOrderCompleted(order.id); // engine no-ops (L1 exists)
    const rows = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(rows.length).toBe(1); // no invented upline rows
  });

  it("changing the parent later does NOT rewrite past commissions", async () => {
    const oldParent = await mkPartner("Old Parent");
    const direct = await mkPartner("Direct Child");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    const order = await mkCompletedOrder(customer.id, direct.id, { baseRate: "25400", buyMargin: "50", sellMargin: "50" });

    // Assign hierarchy AFTER the commission exists, then change it:
    await PartnerService.setPartnerParent("admin-ml", direct.id, oldParent.id);
    const newParent = await mkPartner("New Parent");
    await PartnerService.setPartnerParent("admin-ml", direct.id, newParent.id);

    const rows: any[] = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    if (rows[0].hierarchySnapshot) {
      const snap: any = rows[0].hierarchySnapshot;
      expect(snap.ruleVersion).toBe(CTV_RULE_VERSION);
      expect(JSON.stringify(snap.chain)).not.toContain(newParent.id);
    }
    // Re-running the engine does not rewrite/add rows for the old Order:
    const countBefore = rows.length;
    await PartnerService.onOrderCompleted(order.id);
    const rowsAfter: any[] = await prisma.commission.findMany({ where: { orderId: order.id } });
    expect(rowsAfter.length).toBe(countBefore);
  });
});

describe("Part A — CTV privacy vs Admin traceability", () => {
  it("admin rows include customer identity; plain CTV list rows do not", async () => {
    const partner = await mkPartner("Trace CTV");
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
    await prisma.customer.update({ where: { id: customer.id }, data: { fullName: "Ziconat Test" } });
    await mkCompletedOrder(customer.id, partner.id);

    const adminRows = await PartnerService.getAdminCommissionRows(partner.id, 5);
    expect(adminRows.length).toBe(1);
    expect(adminRows[0].customer?.fullName).toBe("Ziconat Test");
    expect(adminRows[0].customer?.telegramId).toBeTruthy();
    expect(adminRows[0].order).toBeTruthy();

    // The CTV-facing list carries NO customer join/identity:
    const ctvRows: any[] = await PartnerService.listPartnerCommissions(partner.id, 5);
    expect(ctvRows.length).toBe(1);
    expect(JSON.stringify(ctvRows[0])).not.toContain("Ziconat");
    expect(ctvRows[0].customer).toBeUndefined();
  });
});

