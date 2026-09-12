import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { PartnerService } from "../src/modules/partner/partner-service.js";
import { FileService } from "../src/modules/files/file-service.js";
import {
  parsePayoutDestinationFreeForm,
  sanitizePayoutDestinationText,
  PAYOUT_DESTINATION_MAX_LEN
} from "../src/bot/state/partner-session.js";
import { setBotInstance } from "../src/bot/notifications.js";

/**
 * CTV payout destination V2 — free-form destination + reference QR +
 * settlement destination freeze + Admin payout proof (service level,
 * deterministic, in-memory mock store + real local file storage).
 *
 * Payout is MANUALLY reviewed and paid by Admin: the destination/QR/proof are
 * REFERENCE data only and are never treated as financial verification.
 */

const ADMIN_TG = "888010001";
let seq = 0;

async function mkPartner(name: string): Promise<any> {
  return PartnerService.createPartner(ADMIN_TG, `${name}-${++seq}`);
}

async function mkCompletedOrderFor(partnerId: string): Promise<void> {
  const customer = await CustomerService.getOrCreateCustomer({
    telegramId: `ctvpd-${Date.now()}-${++seq}`
  });
  await prisma.customer.update({ where: { id: customer.id }, data: { partnerId } });
  const order = await prisma.order.create({
    data: {
      id: `ORD-CTVPD-${seq}-${Date.now().toString(36).toUpperCase()}`,
      customerId: customer.id,
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
  // Directly AVAILABLE (same pattern as customer-flow-partner.test.ts).
  await prisma.commission.create({
    data: {
      orderId: order.id,
      partnerId,
      baseCommissionUsd: 1,
      spreadBonusUsd: 0,
      totalUsd: 1,
      status: "AVAILABLE",
      availableAt: new Date()
    }
  });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  // No Telegram downloads in these tests — evidence buffers come from the test.
  globalThis.fetch = (async () => {
    throw new Error("network disabled in unit tests");
  }) as any;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  setBotInstance(null);
});

describe("Free-form payout destination parser", () => {
  it("accepts the business reality samples", () => {
    expect(parsePayoutDestinationFreeForm("ABA 001234567 - BUI DUY")).toBe("ABA 001234567 - BUI DUY");
    expect(parsePayoutDestinationFreeForm("Bakong: abc@bakong")).toBe("Bakong: abc@bakong");
    expect(parsePayoutDestinationFreeForm("012345678")).toBe("012345678");
    expect(parsePayoutDestinationFreeForm("Vietcombank 1234567890 Nguyen Van A")).toBe(
      "Vietcombank 1234567890 Nguyen Van A"
    );
    // Old 3-line format is still accepted — as free-form text.
    expect(parsePayoutDestinationFreeForm("Vietcombank\n0123456789\nNGUYEN VAN A")).toBe(
      "Vietcombank\n0123456789\nNGUYEN VAN A"
    );
  });

  it("rejects empty, command-like, and oversized input", () => {
    expect(parsePayoutDestinationFreeForm("")).toBeNull();
    expect(parsePayoutDestinationFreeForm("   ")).toBeNull();
    expect(parsePayoutDestinationFreeForm("/setrate 26000")).toBeNull();
    expect(parsePayoutDestinationFreeForm("x".repeat(PAYOUT_DESTINATION_MAX_LEN + 1))).toBeNull();
  });

  it("strips control characters but keeps newlines/tabs", () => {
    const cleaned = sanitizePayoutDestinationText("ABA\u0000001\u007F123\n\tBUI DUY");
    expect(cleaned).not.toContain("\u0000");
    expect(cleaned).not.toContain("\u0001");
    expect(cleaned).not.toContain("\u007F");
    expect(cleaned).toContain("\n");
    expect(cleaned).toContain("\t");
  });
});

describe("Payout QR reference (FileEvidence reuse)", () => {
  it("saves the QR as FileEvidence and links it to the Partner", async () => {
    const p = await mkPartner("QR CTV");
    const evidence = await FileService.saveEvidenceFile(
      Buffer.from("FAKE-PARTNER-PAYOUT-QR-IMAGE"),
      `partner_payout_qr_${p.id}.png`,
      "QR",
      "image/png"
    );
    await PartnerService.setPayoutQr(p.id, evidence.id, "ctv-tg-1");

    const reloaded: any = await PartnerService.getPartnerById(p.id);
    expect(reloaded.payoutQrFileId).toBe(evidence.id);
  });

  it("rejects a QR reference that has no FileEvidence row", async () => {
    const p = await mkPartner("QR Missing");
    await expect(PartnerService.setPayoutQr(p.id, "no-such-evidence", "ctv-tg-2")).rejects.toThrow();
  });
});

describe("Settlement payout-destination freeze", () => {
  it("freezes text + qrFileId at createSettlement", async () => {
    const p = await mkPartner("Freeze CTV");
    await PartnerService.setPayoutDestination(p.id, { text: "ABA 001234567 - BUI DUY" });
    const qr = await FileService.saveEvidenceFile(
      Buffer.from("QR-BYTES-FREEZE"),
      `qr_${p.id}.png`,
      "QR",
      "image/png"
    );
    await PartnerService.setPayoutQr(p.id, qr.id, "ctv-tg-3");
    await mkCompletedOrderFor(p.id);

    const settlement = await PartnerService.createSettlement(ADMIN_TG, p.id);
    const snap: any = settlement.payoutDestinationSnapshot;
    expect(snap).not.toBeNull();
    expect(snap.source).toBe("free_form");
    expect(snap.text).toBe("ABA 001234567 - BUI DUY");
    expect(snap.qrFileId).toBe(qr.id);
  });

  it("editing the Partner later NEVER mutates an old settlement snapshot", async () => {
    const p = await mkPartner("Immutable CTV");
    await PartnerService.setPayoutDestination(p.id, { text: "OLD DESTINATION" });
    await mkCompletedOrderFor(p.id);
    const settlement = await PartnerService.createSettlement(ADMIN_TG, p.id);
    expect((settlement.payoutDestinationSnapshot as any).text).toBe("OLD DESTINATION");

    // Partner edits their destination afterwards:
    await PartnerService.setPayoutDestination(p.id, { text: "NEW DESTINATION" });

    const reloaded: any = await prisma.partnerSettlement.findUnique({ where: { id: settlement.id } });
    expect((reloaded.payoutDestinationSnapshot as any).text).toBe("OLD DESTINATION");
  });

  it("falls back to a read-only legacy snapshot when free-form fields are empty", () => {
    const snap = PartnerService.buildPayoutDestinationSnapshot({
      payoutBankName: "Vietcombank",
      payoutAccountNumber: "0123456789",
      payoutAccountName: "NGUYEN VAN A",
      payoutDestinationText: null,
      payoutQrFileId: null
    });
    expect(snap).not.toBeNull();
    expect(snap!.source).toBe("legacy");
    expect(snap!.text).toBe("Vietcombank · 0123456789 · NGUYEN VAN A");
    expect(snap!.qrFileId).toBeNull();

    expect(PartnerService.buildPayoutDestinationSnapshot({})).toBeNull();
  });
});

describe("Admin payout proof + PAID notification to the OWNING CTV only", () => {
  it("stores proof evidence on the PENDING settlement; rejects after PAID", async () => {
    const p = await mkPartner("Proof CTV");
    const settlement = await prisma.partnerSettlement.create({
      data: { partnerId: p.id, totalUsd: 3, itemCount: 3, status: "PENDING", createdBy: ADMIN_TG }
    });
    const proof = await FileService.saveEvidenceFile(
      Buffer.from("FAKE-PAYOUT-PROOF-PDF"),
      `proof_${settlement.id}.pdf`,
      "PAYOUT_BILL",
      "application/pdf"
    );
    const updated = await PartnerService.uploadSettlementProof(settlement.id, proof.id, ADMIN_TG);
    expect(updated.payoutProofFileId).toBe(proof.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "PARTNER_SETTLEMENT_PROOF_UPLOADED", targetId: settlement.id }
    });
    expect(audit).not.toBeNull();

    // PAID settlements can no longer accept proof.
    await prisma.partnerSettlement.update({ where: { id: settlement.id }, data: { status: "PAID" } });
    await expect(
      PartnerService.uploadSettlementProof(settlement.id, proof.id, ADMIN_TG)
    ).rejects.toThrow(/PAID/);
  });

  it("notifyPartnerSettlementPaid sends summary + proof ONLY to the owning CTV", async () => {
    const owner = await mkPartner("Owner CTV");
    const outsider = await mkPartner("Outsider CTV");
    await prisma.partner.update({ where: { id: owner.id }, data: { telegramId: "777001" } });
    await prisma.partner.update({ where: { id: outsider.id }, data: { telegramId: "777002" } });

    const settlement = await prisma.partnerSettlement.create({
      data: { partnerId: owner.id, totalUsd: 5, itemCount: 5, status: "PAID", createdBy: ADMIN_TG, paidAt: new Date() }
    });
    const proof = await FileService.saveEvidenceFile(
      Buffer.from("FAKE-PROOF-IMAGE"),
      `proof_${settlement.id}.jpg`,
      "PAYOUT_BILL",
      "image/jpeg"
    );
    await prisma.partnerSettlement.update({
      where: { id: settlement.id },
      data: { payoutProofFileId: proof.id }
    });

    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const sendPhoto = vi.fn(async () => ({ message_id: 2 }));
    const sendDocument = vi.fn(async () => ({ message_id: 3 }));
    setBotInstance({ botInfo: { username: "testbot" }, api: { sendMessage, sendPhoto, sendDocument } } as any);

    const { notifyPartnerSettlementPaid } = await import("../src/bot/notifications.js");
    const result = await notifyPartnerSettlementPaid(settlement.id);
    expect(result.sent).toBe(true);

    // Summary went to the OWNER only.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("777001");
    // Proof image went to the OWNER only (jpeg → sendPhoto).
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(sendPhoto.mock.calls[0][0]).toBe("777001");
    expect(sendDocument).not.toHaveBeenCalled();
    // The outsider's Telegram id must never appear anywhere.
    for (const call of [...sendMessage.mock.calls, ...sendPhoto.mock.calls]) {
      expect(String(call[0])).not.toBe("777002");
    }
  });
});

