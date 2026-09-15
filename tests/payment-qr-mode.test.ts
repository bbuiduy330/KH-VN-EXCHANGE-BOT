/**
 * Payment QR MODE tests — AUTO | STATIC_ONLY.
 *
 * STATIC_ONLY (product decision): the official Admin-uploaded static QR is
 * PRIMARY for orders frozen to that receiving account — the dynamic KHQR /
 * VietQR generators are never invoked. AUTO preserves the existing behavior
 * exactly. The mode lives on PaymentAccount.qrProvider (existing metadata
 * field — NO schema change) and is FROZEN into receivingAccountSnapshot at
 * Order creation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { inMemoryStore, prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { QuoteService } from "../src/modules/quotes/quote-service.js";
import { PaymentAccountService } from "../src/modules/payment-accounts/account-service.js";
import { PaymentQrService } from "../src/modules/payment-qr/payment-qr-service.js";
import { FileService } from "../src/modules/files/file-service.js";
import { RuntimeConfigService } from "../src/modules/system-config/runtime-config-service.js";

let seq = 0;
const uniqueId = () => `qrmode-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

beforeEach(async () => {
  for (const key of Object.keys(inMemoryStore as any)) {
    const store: any = (inMemoryStore as any)[key];
    if (store instanceof Map) store.clear();
    else if (Array.isArray(store)) store.length = 0;
  }
  await RuntimeConfigService.init();
  await RuntimeConfigService.setBuyMarginVnd(0, "TEST");
  await RuntimeConfigService.setSellMarginVnd(0, "TEST");
  await QuoteService.setRateAndInvalidate("USD/VND", 25600, 0, 0, 3, "USD", "admin-1", "SUPER_ADMIN");
});

/** Minimal PNG-magic buffer (magic bytes are what matter for storage). */
const tinyPng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82
]);

async function makeAccount(qrProvider: string | null, withStaticFile: boolean, dynamicMeta = false) {
  let qrFilePath: string | null = null;
  if (withStaticFile) {
    const saved: any = await FileService.saveEvidenceFile(tinyPng, `${uniqueId()}.png`, "QR", "image/png");
    qrFilePath = saved.filePath;
  }
  return prisma.paymentAccount.create({
    data: {
      currency: "USD",
      bankName: "ABA Bank",
      accountName: "TEST HOLDER",
      accountNumber: "001234567",
      isActive: true,
      isDefault: true,
      qrFilePath,
      qrProvider,
      ...(dynamicMeta
        ? {
            khqrMode: "INDIVIDUAL",
            khqrBakongAccountId: "test@aba",
            khqrMerchantName: "TEST MERCHANT",
            khqrMerchantCity: "Phnom Penh"
          }
        : {})
    }
  });
}

async function makeOrder(): Promise<any> {
  const customer = await CustomerService.getOrCreateCustomer({ telegramId: uniqueId() });
  const calc = await QuoteService.calculateQuote("USD", "VND", 100);
  return OrderService.createOrderFromQuote(customer.id, calc);
}

// ___STATIC_ONLY_TESTS___

describe("STATIC_ONLY mode", () => {
  it("static file present → static QR returned; dynamic generators never invoked", async () => {
    const account: any = await makeAccount("STATIC", true);
    const order = await makeOrder();
    // FROZEN snapshot preserves the mode + account binding:
    expect((order as any).receivingAccountSnapshot.qrProvider).toBe("STATIC");
    expect((order as any).receivingAccountSnapshot.paymentAccountId).toBe(account.id);

    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result?.type).toBe("STATIC");
    expect(result?.imageBuffer).not.toBeNull();
    expect(result?.degradedReason).toBeUndefined();
  });

  it("dynamic metadata present + STATIC_ONLY → STILL static (metadata ignored)", async () => {
    await makeAccount("STATIC", true, true); // full KHQR dynamic metadata
    const order = await makeOrder();
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result?.type).toBe("STATIC");
    expect(result?.imageBuffer).not.toBeNull();
  });

  it("STATIC_ONLY + missing static QR → safe text fallback, no dynamic generation", async () => {
    await makeAccount("STATIC", false, true);
    const order = await makeOrder();
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result?.type).toBe("NONE");
    expect(result?.degradedReason).toBe("STATIC_ONLY_NO_FILE");
    expect(result?.imageBuffer).toBeNull();
  });

  it("setQrMode persists qrProvider and rejects invalid modes", async () => {
    const account: any = await makeAccount(null, false);
    await PaymentAccountService.setQrMode(account.id, "STATIC_ONLY", "admin-1");
    const after: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    expect(after.qrProvider).toBe("STATIC");
    await expect(PaymentAccountService.setQrMode(account.id, "km", "admin-1")).rejects.toThrow();
    await PaymentAccountService.setQrMode(account.id, "AUTO", "admin-1");
    const reverted: any = await prisma.paymentAccount.findUnique({ where: { id: account.id } });
    expect(reverted.qrProvider).toBeNull(); // AUTO = null (default behavior)
  });
});

describe("AUTO mode (existing behavior unchanged)", () => {
  it("AUTO + KHQR dynamic metadata → dynamic KHQR path", async () => {
    await makeAccount(null, true, true);
    const order = await makeOrder();
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result?.type).toBe("KHQR");
    expect((order as any).receivingAccountSnapshot.qrProvider).toBeNull();
  });

  it("AUTO + no dynamic metadata + static file → static fallback", async () => {
    await makeAccount(null, true, false);
    const order = await makeOrder();
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result?.type).toBe("STATIC");
  });
});