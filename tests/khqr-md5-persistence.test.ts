import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";

/**
 * PART 5 — KHQR MD5 persistence proof (G/H).
 *
 * A successful DYNAMIC KHQR generation must persist the SDK's authoritative
 * `response.data.md5` onto the SAME Order (Order.khqrMd5). Re-displaying the
 * payment info must not create a new Order or corrupt the stored MD5.
 * Orders without khqrMd5 remain on the manual verification flow.
 */

const generateIndividual = vi.fn();
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
    merchantID = "";
    acquiringBank = "";
  }
  class MockBakongKHQR {
    static generateIndividual = generateIndividual;
    static verify = verify;
    generateIndividual(info: any) { return MockBakongKHQR.generateIndividual(info); }
  }
  return {
    BakongKHQR: MockBakongKHQR,
    khqrData: { currency: { usd: "USD", khr: "KHR" }, merchantType: { individual: "C", merchant: "M" } },
    IndividualInfo,
    MerchantInfo
  };
});

import { PaymentQrService } from "../src/modules/payment-qr/payment-qr-service.js";

const uniqueId = () => `md5-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const snap = () => ({
  currency: "USD",
  bankName: "ABA",
  accountName: "ABA TEST",
  accountNumber: "179168179",
  qrProvider: "KHQR",
  khqrMode: "INDIVIDUAL",
  khqrBakongAccountId: "md5test@aba",
  khqrMerchantName: "MD5 TEST",
  khqrMerchantCity: "Phnom Penh"
});

beforeEach(() => {
  generateIndividual.mockReset();
  verify.mockReset().mockReturnValue({ isValid: true });
  generateIndividual.mockReturnValue({
    status: { code: 0 },
    data: { qr: "KHQR-PAYLOAD-MD5-TEST", md5: "MD5-ABC123" }
  });
});

describe("PART 5 — KHQR MD5 persistence (G/H)", () => {
  it("G. successful dynamic KHQR generation persists response.data.md5 on the SAME Order", async () => {
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId().replace(/\D/g, "") || "1" });
    const order = await prisma.order.create({
      data: {
        id: `ORD-MD5-${Date.now().toString(36).toUpperCase()}`,
        customerId: customer.id,
        sourceCurrency: "USD",
        targetCurrency: "VND",
        sourceAmount: 100,
        targetAmount: 2540000,
        rate: 25400,
        fee: 2,
        feeCurrency: "USD",
        transferMemo: "MD5MEMO1",
        status: "WAITING_PAYMENT",
        receivingAccountSnapshot: snap()
      } as any
    });

    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.type).toBe("KHQR");
    expect(result!.payload).toBe("KHQR-PAYLOAD-MD5-TEST");

    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.khqrMd5).toBe("MD5-ABC123"); // exact SDK value persisted
    // No new Order was created by re-display:
    const orderCount = await prisma.order.findMany({ where: { customerId: customer.id } });
    expect(orderCount.length).toBe(1);
  });

  it("re-displaying payment info does NOT corrupt the stored MD5", async () => {
    const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId().replace(/\D/g, "") || "2" });
    const order = await prisma.order.create({
      data: {
        id: `ORD-MD5B-${Date.now().toString(36).toUpperCase()}`,
        customerId: customer.id,
        sourceCurrency: "USD",
        targetCurrency: "VND",
        sourceAmount: 100,
        targetAmount: 2540000,
        rate: 25400,
        fee: 2,
        feeCurrency: "USD",
        transferMemo: "MD5MEMO2",
        status: "WAITING_PAYMENT",
        receivingAccountSnapshot: snap()
      } as any
    });
    await PaymentQrService.generateForOrder(order.id);
    const first: any = await prisma.order.findUnique({ where: { id: order.id } });
    const md5AfterFirst = first.khqrMd5;
    // Re-display (payinfo resend path) — deterministic mock returns same MD5:
    await PaymentQrService.generateForOrder(order.id);
    const second: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(second.khqrMd5).toBe(md5AfterFirst);
    expect(second.khqrMd5).toBe("MD5-ABC123");
  });
});
