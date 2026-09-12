import { describe, it, expect } from "vitest";
import {
  parseImportedQr
} from "../src/modules/payment-qr/qr-import.js";
import {
  getQrReadiness,
  detectKhqrCapability,
  detectVietQrCapability
} from "../src/modules/payment-qr/payment-qr-service.js";
import { applyImportedQrMeta } from "../src/bot/admin/account-qr-meta.js";
import { prisma } from "../src/database/client.js";

/**
 * REAL runtime QR payloads (decoded from actual bank QR images) — regression
 * tests for KHQR/VietQR import parsing. Exact payload strings, no fixtures.
 */

// CASE A — REAL BIDV VietQR (tag 38/01 is ITSELF a nested TLV):
//   38/00 = A000000727, 38/01 = {00: 970418, 01: 8838831979}, 38/02 = QRIBFTTA
const BIDV_VIETQR =
  "00020101021138540010A00000072701240006970418011088388319790208QRIBFTTA53037045802VN6304E72E";

// CASE B — REAL ABA KHQR USD (Bakong-ID-first template, NO A000000727 GUID):
//   30/00 = abaakhppxxx@abaa, 30/01 = 179168179, 30/02 = ABA Bank,
//   59 = BUI DUY TON, 60 = Phnom Penh, 53 = 840 (USD), 58 = KH
const ABA_KHQR_USD =
  "00020101021130450016abaakhppxxx@abaa01091791681790208ABA Bank40390006abaP2P0112C7B3D112C50C02091791681795204000053038405802KH5911BUI DUY TON6010Phnom Penh630443AA";

describe("CASE A — real BIDV VietQR (nested tag 38/01)", () => {
  it("parses BIN 970418 / account 8838831979 / service QRIBFTTA", () => {
    const meta = parseImportedQr(BIDV_VIETQR);
    expect(meta).not.toBeNull();
    expect(meta!.provider).toBe("VIETQR");
    expect(meta!.bankBin).toBe("970418");
    expect(meta!.bankNumber).toBe("8838831979");
    expect(meta!.service).toBe("QRIBFTTA");
    // Never the flat mis-reads:
    expect(meta!.bankBin).not.toBe("000697041801108838831979");
    expect(meta!.bankNumber).not.toBe("QRIBFTTA");
  });

  it("readiness uses the SAME capability rules as the generator", () => {
    const meta = parseImportedQr(BIDV_VIETQR)!;
    const readiness = getQrReadiness({
      currency: "VND",
      qrProvider: "VIETQR",
      bankBin: meta.bankBin ?? null,
      accountNumber: meta.bankNumber ?? null
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(
      detectVietQrCapability({ bankBin: meta.bankBin, accountNumber: meta.bankNumber })
    ).toEqual({ bankBin: "970418", bankNumber: "8838831979" });
  });

  it("account matching compares the REAL account number; save works; service never persisted", async () => {
    const account = await prisma.paymentAccount.create({
      data: {
        id: `PA-BIDV-${Date.now().toString(36).toUpperCase()}`,
        currency: "VND",
        bankName: "BIDV",
        accountName: "BIDV TEST",
        accountNumber: "8838831979",
        isActive: true
      }
    }) as any;

    const meta = parseImportedQr(BIDV_VIETQR)!;
    const outcome = await applyImportedQrMeta(account.id, "886333010", meta);
    expect(outcome.ok).toBe(true);
    expect(outcome.readiness.ready).toBe(true);

    const saved: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    expect(saved.qrProvider).toBe("VIETQR");
    expect(saved.bankBin).toBe("970418");
    // Account number untouched — and the service code is never saved:
    expect(saved.accountNumber).toBe("8838831979");
    const json = JSON.stringify(saved);
    expect(json).not.toContain("QRIBFTTA");
  });

  it("account mismatch: a different account number is refused (not re-pointed)", async () => {
    const other = await prisma.paymentAccount.create({
      data: {
        id: `PA-BIDVX-${Date.now().toString(36).toUpperCase()}`,
        currency: "VND",
        bankName: "Other Bank",
        accountName: "OTHER",
        accountNumber: "0000000001",
        isActive: true
      }
    }) as any;
    const meta = parseImportedQr(BIDV_VIETQR)!;
    const outcome = await applyImportedQrMeta(other.id, "886333010", meta);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("account_mismatch");
  });
});

describe("CASE B — real ABA KHQR USD (Bakong-ID-first, no A000000727 GUID)", () => {
  it("classifies as KHQR (never UNKNOWN) and extracts all metadata", () => {
    const meta = parseImportedQr(ABA_KHQR_USD);
    expect(meta).not.toBeNull();
    expect(meta!.provider).toBe("KHQR");
    expect(meta!.khqrBakongAccountId).toBe("abaakhppxxx@abaa");
    expect(meta!.khqrMerchantId).toBe("179168179");
    expect(meta!.khqrAcquiringBank).toBe("ABA Bank");
    // Name/city come from the EMVCo 59/60 tags:
    expect(meta!.khqrMerchantName).toBe("BUI DUY TON");
    expect(meta!.khqrMerchantCity).toBe("Phnom Penh");
    // NBC semantics: tag 30 (MIS) with merchant ID + acquiring bank ⇒ MERCHANT.
    expect(meta!.khqrMode).toBe("MERCHANT");
    // CRC accepted:
    expect(meta!.crcValid).toBe(true);
    // ABA proprietary tag 40 is ignored; no source amount/memo present:
    expect(meta!.sourceAmount).toBeUndefined();
    expect(meta!.sourceMemo).toBeUndefined();
  });

  it("readiness uses the SAME capability rules as the generator (MERCHANT)", () => {
    const meta = parseImportedQr(ABA_KHQR_USD)!;
    const readiness = getQrReadiness({
      currency: "USD",
      qrProvider: "KHQR",
      khqrMode: meta.khqrMode ?? null,
      khqrBakongAccountId: meta.khqrBakongAccountId ?? null,
      khqrMerchantName: meta.khqrMerchantName ?? null,
      khqrMerchantCity: meta.khqrMerchantCity ?? null,
      khqrMerchantId: meta.khqrMerchantId ?? null,
      khqrAcquiringBank: meta.khqrAcquiringBank ?? null
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);

    const cap = detectKhqrCapability({
      khqrMode: meta.khqrMode,
      khqrBakongAccountId: meta.khqrBakongAccountId,
      khqrMerchantName: meta.khqrMerchantName,
      khqrMerchantCity: meta.khqrMerchantCity,
      khqrMerchantId: meta.khqrMerchantId,
      khqrAcquiringBank: meta.khqrAcquiringBank
    });
    expect(cap).not.toBeNull();
    expect(cap!.mode).toBe("MERCHANT");
    expect(cap!.bakongAccountId).toBe("abaakhppxxx@abaa");
  });

  it("save works and proprietary source data (tag 40) never lands on the account", async () => {
    const account = await prisma.paymentAccount.create({
      data: {
        id: `PA-ABA-${Date.now().toString(36).toUpperCase()}`,
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "ABA TEST",
        accountNumber: "179168179",
        isActive: true
      }
    }) as any;

    const meta = parseImportedQr(ABA_KHQR_USD)!;
    const outcome = await applyImportedQrMeta(account.id, "886333011", meta);
    expect(outcome.ok).toBe(true);
    expect(outcome.readiness.ready).toBe(true);

    const saved: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    expect(saved.qrProvider).toBe("KHQR");
    expect(saved.khqrMode).toBe("MERCHANT");
    expect(saved.khqrBakongAccountId).toBe("abaakhppxxx@abaa");
    expect(saved.khqrMerchantId).toBe("179168179");
    expect(saved.khqrAcquiringBank).toBe("ABA Bank");
    expect(saved.khqrMerchantName).toBe("BUI DUY TON");
    expect(saved.khqrMerchantCity).toBe("Phnom Penh");
    // Proprietary source-QR data never persisted:
    const json = JSON.stringify(saved);
    expect(json).not.toContain("abaP2P");
    expect(json).not.toContain("C7B3D112C50C");
  });
});

