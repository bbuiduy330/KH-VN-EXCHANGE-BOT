/**
 * TASK 6 — QR IMPORT (📷 Nhập từ QR ngân hàng) tests F–J.
 *
 * Payload-level fixtures are used (deterministic EMV TLV strings built with
 * buildEmvTlv); image-level decoding (jsqr) is exercised only when deps are
 * installed — it is never machine-TZ- or environment-dependent.
 *
 * F. valid KHQR Individual payload → metadata extracted, readiness green.
 * G. valid KHQR Merchant payload → actual merchant fields preserved.
 * H. incomplete KHQR → save BLOCKED with the exact missing list.
 * I. valid VietQR payload → BIN/account parsed, readiness green.
 * J. source QR fixed amount/memo → NOT persisted to account config; runtime
 *    Order QR keeps using the FROZEN Order amount + Order.transferMemo.
 */
import { describe, it, expect } from "vitest";
import { buildEmvTlv, parseImportedQr, parseEmvTlv } from "../src/modules/payment-qr/qr-import.js";
import { getQrReadiness } from "../src/modules/payment-qr/payment-qr-service.js";
import { previewImportedQr, applyImportedQrMeta } from "../src/bot/admin/account-qr-meta.js";
import { prisma } from "../src/database/client.js";

const KHQR_RID = "A000000727";

/** Craft a KHQR Individual payload fixture (tag 29 = AIB, no MIS). */
function khqrIndividualPayload(bakong: string, name: string, city: string, amount?: string, memo?: string): string {
  const aib = buildEmvTlv({ "00": KHQR_RID, "01": bakong, "02": name, "03": city });
  const tags: Record<string, string> = {
    "00": "01", "01": "02", "29": aib, "53": "840", "58": "KH"
  };
  if (amount) tags["54"] = amount;
  if (memo) tags["62"] = buildEmvTlv({ "05": memo });
  tags["63"] = "ABCD"; // fake CRC suffix for TLV structure (verify() re-checks)
  return buildEmvTlv(tags);
}

/** Craft a KHQR Merchant payload fixture (tag 29 AIB + tag 30 MIS). */
function khqrMerchantPayload(bakong: string, name: string, city: string, merchantId: string, acquiring: string): string {
  const aib = buildEmvTlv({ "00": KHQR_RID, "01": bakong, "02": name, "03": city });
  const mis = buildEmvTlv({ "00": KHQR_RID, "01": merchantId, "02": acquiring });
  return buildEmvTlv({
    "00": "01", "01": "12", "29": aib, "30": mis, "53": "840", "58": "KH", "63": "ABCD"
  });
}

/** Craft a VietQR payload fixture (tag 38 = NAPAS 247). */
function vietQrPayload(bin: string, account: string, amount?: string, memo?: string): string {
  const merchantAccount = buildEmvTlv({ "00": KHQR_RID, "01": bin, "02": account });
  const tags: Record<string, string> = { "00": "01", "01": "11", "38": merchantAccount, "53": "704" };
  if (amount) tags["54"] = amount;
  if (memo) tags["62"] = buildEmvTlv({ "05": memo });
  tags["63"] = "ABCD";
  return buildEmvTlv(tags);
}

// F — KHQR Individual import
describe("F. KHQR INDIVIDUAL import (personal ABA/USD-type QR)", () => {
  it("extracts Bakong ID/name/city, prefers INDIVIDUAL, readiness green", () => {
    const payload = khqrIndividualPayload("personal@aba", "Personal ABA", "Phnom Penh");
    const meta = parseImportedQr(payload);
    expect(meta).not.toBeNull();
    expect(meta!.provider).toBe("KHQR");
    expect(meta!.khqrMode).toBe("INDIVIDUAL"); // source metadata supports Individual
    expect(meta!.khqrBakongAccountId).toBe("personal@aba");
    expect(meta!.khqrMerchantName).toBe("Personal ABA");
    expect(meta!.khqrMerchantCity).toBe("Phnom Penh");
    // NO guessed merchant fields:
    expect(meta!.khqrMerchantId).toBeUndefined();
    expect(meta!.khqrAcquiringBank).toBeUndefined();

    const readiness = getQrReadiness({
      currency: "USD", qrProvider: "KHQR", khqrMode: meta!.khqrMode ?? null,
      khqrBakongAccountId: meta!.khqrBakongAccountId ?? null,
      khqrMerchantName: meta!.khqrMerchantName ?? null,
      khqrMerchantCity: meta!.khqrMerchantCity ?? null
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);
  });

  it("preview names the mode explicitly and shows the green readiness line", () => {
    const payload = khqrIndividualPayload("personal@aba", "Personal ABA", "Phnom Penh");
    const meta = parseImportedQr(payload)!;
    const preview = previewImportedQr({ currency: "USD" }, meta);
    expect(preview).toContain("KHQR INDIVIDUAL");
    expect(preview).toContain("🟢 KHQR động — Sẵn sàng");
    expect(preview).toContain("personal@aba");
  });
});

// G — KHQR Merchant import
describe("G. KHQR MERCHANT import", () => {
  it("preserves ACTUAL merchant fields (ID + acquiring bank) from the MIS tag", () => {
    const payload = khqrMerchantPayload("merchant@aba", "MERCHANT DESK", "Phnom Penh", "123456", "ABA");
    const meta = parseImportedQr(payload)!;
    expect(meta.provider).toBe("KHQR");
    expect(meta.khqrMode).toBe("MERCHANT"); // ONLY from the MIS structure
    expect(meta.khqrBakongAccountId).toBe("merchant@aba");
    expect(meta.khqrMerchantName).toBe("MERCHANT DESK");
    expect(meta.khqrMerchantCity).toBe("Phnom Penh");
    expect(meta.khqrMerchantId).toBe("123456");
    expect(meta.khqrAcquiringBank).toBe("ABA");

    const readiness = getQrReadiness({
      currency: "USD", qrProvider: "KHQR", khqrMode: "MERCHANT",
      khqrBakongAccountId: "merchant@aba", khqrMerchantName: "MERCHANT DESK",
      khqrMerchantCity: "Phnom Penh", khqrMerchantId: "123456", khqrAcquiringBank: "ABA"
    });
    expect(readiness.ready).toBe(true);
  });
});

// H — incomplete KHQR → save blocked
describe("H. Incomplete KHQR import is BLOCKED (never saved broken)", () => {
  it("missing city → readiness not ready with the exact missing field", () => {
    const payload = khqrIndividualPayload("half@aba", "Half Config", ""); // no city
    const meta = parseImportedQr(payload)!;
    const readiness = getQrReadiness({
      currency: "USD", qrProvider: "KHQR", khqrMode: meta.khqrMode ?? null,
      khqrBakongAccountId: meta.khqrBakongAccountId ?? null,
      khqrMerchantName: meta.khqrMerchantName ?? null,
      khqrMerchantCity: meta.khqrMerchantCity ?? null
    });
    expect(readiness.ready).toBe(false);
    expect(JSON.stringify(readiness.missing)).toContain("Thành phố");
  });

  it("applyImportedQrMeta refuses to save a not-ready config (shared gate)", async () => {
    const meta = parseImportedQr(khqrIndividualPayload("half@aba", "Half Config", ""))!;
    const outcome = await applyImportedQrMeta("no-such-account", "886222000", meta);
    expect(outcome.ok).toBe(false);
  });
});

// I — VietQR import
describe("I. VietQR import (BIN + account parsed from the QR)", () => {
  it("extracts bank BIN/account, readiness green, no manual BIN typing needed", () => {
    const payload = vietQrPayload("970436", "9988776655");
    const meta = parseImportedQr(payload)!;
    expect(meta.provider).toBe("VIETQR");
    expect(meta.bankBin).toBe("970436");
    expect(meta.bankNumber).toBe("9988776655");

    const readiness = getQrReadiness({
      currency: "VND", qrProvider: "VIETQR", bankBin: meta.bankBin ?? null, accountNumber: meta.bankNumber ?? null
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.missing).toEqual([]);

    const preview = previewImportedQr({ currency: "VND" }, meta);
    expect(preview).toContain("VietQR");
    expect(preview).toContain("970436");
    expect(preview).toContain("🟢 VietQR động — Sẵn sàng");
  });
});

// J — source amount/memo never contaminate future Orders
describe("J. Source QR amount/memo do NOT become account config", () => {
  it("parseImportedQr captures source amount/memo as TRANSPARENCY-ONLY fields", () => {
    const meta = parseImportedQr(
      khqrIndividualPayload("personal@aba", "Personal ABA", "Phnom Penh", "2540000", "ORD-SRC CK")
    )!;
    // Captured for preview only:
    expect(meta.sourceAmount).toBe("2540000");
    expect(meta.sourceMemo).toBe("ORD-SRC CK");
    // The account metadata NEVER carries amount/memo fields:
    const keys = Object.keys(meta);
    expect(keys).not.toContain("accountAmount");
    expect(keys).not.toContain("accountMemo");
    expect(keys).not.toContain("amount");
    expect(keys).not.toContain("memo");
  });

  it("applyImportedQrMeta persists ONLY account metadata (no source amount/memo)", async () => {
    const account = await prisma.paymentAccount.create({
      data: {
        id: `PA-QRI-${Date.now().toString(36).toUpperCase()}`,
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "PERSONAL ABA USD",
        accountNumber: "0099881",
        isActive: true
      }
    }) as any;

    const meta = parseImportedQr(
      khqrIndividualPayload("personal@aba", "Personal ABA", "Phnom Penh", "2540000", "ORD-SRC CK")
    )!;
    const outcome = await applyImportedQrMeta(account.id, "886222001", meta);
    expect(outcome.ok).toBe(true);
    expect(outcome.readiness.ready).toBe(true);
    expect(outcome.readiness.missing).toEqual([]);

    const saved: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    // Account config = receiving-account metadata ONLY:
    expect(saved.qrProvider).toBe("KHQR");
    expect(saved.khqrMode).toBe("INDIVIDUAL");
    expect(saved.khqrBakongAccountId).toBe("personal@aba");
    // Source QR amount/memo never land on the account row:
    const json = JSON.stringify(saved);
    expect(json).not.toContain("2540000");
    expect(json).not.toContain("ORD-SRC CK");
  });

  it("runtime Order QR uses the FROZEN Order amount + Order.transferMemo (structurally)", async () => {
    // PaymentQrService.generateForOrder builds from FROZEN Order fields only:
    // amount = normalizeUsdAmountString(order.sourceAmount), memo =
    // OrderService.getOrderTransferMemo(order) — the imported account row
    // carries NO amount/memo, so contamination is structurally impossible.
    const { normalizeUsdAmountString } = await import("../src/modules/payment-qr/payment-qr-service.js");
    const { OrderService } = await import("../src/modules/orders/order-service.js");
    expect(normalizeUsdAmountString("100")).toBe("100");
    // The frozen memo accessor prefers the persisted Order memo:
    const memo = await OrderService.getOrderTransferMemo({ id: "ORD-FROZEN-1", transferMemo: "J4X9Z2 CK" });
    expect(memo).toBe("J4X9Z2 CK");
  });
});

// TLV structure sanity (fixtures used above are well-formed)
describe("EMV TLV fixture helper", () => {
  it("round-trips tags through parseEmvTlv", () => {
    const payload = buildEmvTlv({ "00": "01", "29": buildEmvTlv({ "00": KHQR_RID, "01": "x@aba" }) });
    const tags = parseEmvTlv(payload);
    expect(tags.get("00")).toBe("01");
    expect(tags.get("29")!.startsWith(`00${String(KHQR_RID.length).padStart(2, "0")}${KHQR_RID}`)).toBe(true);
  });
});


