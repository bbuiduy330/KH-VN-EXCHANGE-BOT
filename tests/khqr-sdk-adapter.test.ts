import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * KHQR SDK ADAPTER (buildKhqrPayload) — focused tests with a mocked
 * `bakong-khqr` module (runtime response shape verified on VPS:
 * { status: { code }, data: { qr } }). VietQR is NOT mocked here — it must
 * stay unchanged.
 */

const generateIndividual = vi.fn();
const generateMerchant = vi.fn();
const verify = vi.fn((): { isValid: boolean } => ({ isValid: true }));

vi.mock("bakong-khqr", () => {
  class IndividualInfo {
    bakongAccountID: string;
    merchantName: string;
    merchantCity: string;
    optional: any;
    constructor(bakongAccountID: string, merchantName: string, merchantCity: string, optional?: any) {
      this.bakongAccountID = bakongAccountID;
      this.merchantName = merchantName;
      this.merchantCity = merchantCity;
      this.optional = optional;
    }
  }
  class MerchantInfo extends IndividualInfo {
    merchantID: string;
    acquiringBank: string;
    constructor(
      bakongAccountID: string, merchantName: string, merchantCity: string,
      merchantID: string, acquiringBank: string, optional?: any
    ) {
      super(bakongAccountID, merchantName, merchantCity, optional);
      this.merchantID = merchantID;
      this.acquiringBank = acquiringBank;
    }
  }
  class MockBakongKHQR {
    static generateIndividual = generateIndividual;
    static generateMerchant = generateMerchant;
    static verify = verify;
    generateIndividual(info: any) { return MockBakongKHQR.generateIndividual(info); }
    generateMerchant(info: any) { return MockBakongKHQR.generateMerchant(info); }
  }
  return {
    BakongKHQR: MockBakongKHQR,
    khqrData: { currency: { usd: "USD", khr: "KHR" }, merchantType: { individual: "C", merchant: "M" } },
    IndividualInfo,
    MerchantInfo
  };
});

import { BakongKHQR } from "bakong-khqr";
import { buildKhqrPayload, buildVietQrPayload } from "../src/modules/payment-qr/payment-qr-service.js";

const capIndividual = {
  mode: "INDIVIDUAL" as const,
  bakongAccountId: "user@aba",
  merchantName: "TEST USER",
  merchantCity: "Phnom Penh"
};
const capMerchant = {
  mode: "MERCHANT" as const,
  bakongAccountId: "merchant@aba",
  merchantName: "TEST SHOP",
  merchantCity: "Phnom Penh",
  merchantId: "123456",
  acquiringBank: "ABA"
};

const EXPIRY = 1757000000000;

beforeEach(() => {
  generateIndividual.mockReset();
  generateMerchant.mockReset();
  verify.mockReset().mockReturnValue({ isValid: true });
});

describe("KHQR SDK adapter — runtime response shape { status, data: { qr } }", () => {
  it("accepts a successful SDK response and returns data.qr", () => {
    generateIndividual.mockReturnValue({ status: { code: 0 }, data: { qr: "KHQR-PAYLOAD-123" } });
    const payload = buildKhqrPayload(capIndividual, "25.5", "A7K92 CK", EXPIRY);
    expect(payload).toBe("KHQR-PAYLOAD-123");
    expect(verify).toHaveBeenCalledWith("KHQR-PAYLOAD-123");
  });

  it("passes amount as a finite NUMBER (max 2 USD decimals) and expirationTimestamp as a NUMBER", () => {
    generateIndividual.mockReturnValue({ status: { code: 0 }, data: { qr: "P" } });
    buildKhqrPayload(capIndividual, "25.5", "MEMO1", EXPIRY);
    const info = generateIndividual.mock.calls[0]?.[0];
    expect(info).toBeDefined();
    expect(typeof info?.optional.amount).toBe("number");
    expect(info?.optional.expirationTimestamp).toBe(EXPIRY);
    expect(typeof info?.optional.expirationTimestamp).toBe("number");
    expect(info?.optional.billNumber).toBe("MEMO1"); // frozen transfer memo preserved
  });

  it("accepts ≤2 USD decimal amounts exactly; NEVER rounds/truncates >2 decimals", () => {
    for (const [amountString, expected] of [
      ["100", 100],
      ["25.5", 25.5],
      ["25.50", 25.5],
      ["0.01", 0.01]
    ] as [string, number][]) {
      generateIndividual.mockReturnValue({ status: { code: 0 }, data: { qr: "P" } });
      buildKhqrPayload(capIndividual, amountString, "M", EXPIRY);
      const info = generateIndividual.mock.calls[0]?.[0];
      expect(info?.optional.amount, amountString).toBe(expected);
    }
    // >2 decimals are REJECTED — no rounding, no truncation, Order untouched:
    for (const bad of ["25.505", "100.256", "0.001"]) {
      generateIndividual.mockClear();
      expect(() => buildKhqrPayload(capIndividual, bad, "M", EXPIRY)).toThrow(/2 decimal places/);
      expect(generateIndividual).not.toHaveBeenCalled();
    }
  });

  it("rejects non-positive / non-finite amounts at the SDK boundary", () => {
    expect(() => buildKhqrPayload(capIndividual, "0", "M", EXPIRY)).toThrow();
    expect(() => buildKhqrPayload(capIndividual, "-5", "M", EXPIRY)).toThrow();
    expect(() => buildKhqrPayload(capIndividual, "NaN", "M", EXPIRY)).toThrow();
    expect(generateIndividual).not.toHaveBeenCalled();
  });
});

describe("KHQR MERCHANT mode + failure paths", () => {
  it("successful MERCHANT generation returns a dynamic KHQR with UNCHANGED merchant fields", () => {
    generateMerchant.mockReturnValue({ status: { code: 0 }, data: { qr: "MERCHANT-PAYLOAD" } });
    const payload = buildKhqrPayload(capMerchant, "100", "ORD-MEMO", EXPIRY);
    expect(payload).toBe("MERCHANT-PAYLOAD");
    const info = generateMerchant.mock.calls[0]?.[0];
    expect(info).toBeDefined();
    // MERCHANT fields passed through untouched:
    expect(info?.bakongAccountID).toBe("merchant@aba");
    expect(info?.merchantName).toBe("TEST SHOP");
    expect(info?.merchantCity).toBe("Phnom Penh");
    expect(info?.merchantID).toBe("123456");
    expect(info?.acquiringBank).toBe("ABA");
    expect(info?.optional.billNumber).toBe("ORD-MEMO");
  });

  it("SDK rejection (non-zero status / missing data.qr) throws into the fallback", () => {
    generateIndividual.mockReturnValue({
      status: { code: 1, errorCode: 9001, message: "invalid amount" }
    });
    expect(() => buildKhqrPayload(capIndividual, "25.5", "M", EXPIRY)).toThrow(
      /KHQR generation rejected by official SDK \(mode: INDIVIDUAL\)/
    );
    // Top-level legacy `qr` alone is NOT the success contract:
    generateIndividual.mockReturnValue({ status: { code: 0 }, qr: "LEGACY-TOP-LEVEL" });
    expect(() => buildKhqrPayload(capIndividual, "25.5", "M", EXPIRY)).toThrow();
  });

  it("invalid CRC on the SDK payload still throws (never returned)", () => {
    generateIndividual.mockReturnValue({ status: { code: 0 }, data: { qr: "BAD-CRC-PAYLOAD" } });
    verify.mockReturnValue({ isValid: false });
    expect(() => buildKhqrPayload(capIndividual, "25.5", "M", EXPIRY)).toThrow(/CRC validation/);
  });
});

describe("VietQR builder unchanged (no bakong-khqr involvement)", () => {
  it("still builds a valid VietQR payload via vietnam-qr-pay", () => {
    const payload = buildVietQrPayload(
      { bankBin: "970418", bankNumber: "8838831979" },
      "100000",
      "A7K92 CK"
    );
    expect(payload).toBeTruthy();
    expect(vi.mocked(BakongKHQR.verify)).not.toHaveBeenCalled();
  });
});

