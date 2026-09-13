/**
 * DYNAMIC PAYMENT QR V1 — feature-branch tests.
 * Requires deps installed (bakong-khqr / vietnam-qr-pay / qrcode):
 * payload building, SDK CRC validation, PNG rendering and the Telegram
 * one-message card are all exercised. NOT EXECUTED in the local audit env.
 */
import { describe, it, expect, vi } from "vitest";
import { prisma } from "../src/database/client.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import {
  PaymentQrService,
  detectKhqrCapability,
  detectVietQrCapability,
  buildKhqrPayload,
  buildVietQrPayload,
  renderQrPng,
  computePaymentDeadlineMs,
  normalizeVndAmountString,
  normalizeUsdAmountString
} from "../src/modules/payment-qr/payment-qr-service.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { BakongKHQR } from "bakong-khqr";
import { QRPay } from "vietnam-qr-pay";
import { SystemConfigService } from "../src/modules/system-config/system-config-service.js";
import { SUPPORTED_LOCALES, t } from "../src/modules/i18n/locales.js";
import { getQrReadiness } from "../src/modules/payment-qr/payment-qr-service.js";
import { readinessLine, resolveVietQrBank } from "../src/bot/admin/account-qr-meta.js";

let seq = 0;

async function makeCustomer(): Promise<any> {
  seq++;
  return CustomerService.getOrCreateCustomer({
    telegramId: `pqr-${seq}-${Date.now()}`,
    username: `pqr_user_${seq}`
  });
}

function snap(base: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: "USD",
    bankName: "Acleda Bank",
    accountName: "EXCHANGE DESK",
    accountNumber: "0012345678",
    qrFilePath: null,
    ...base
  };
}

async function makeOrder(customerId: string, opts: {
  currency: string;
  amount: string;
  snapshot: Record<string, unknown>;
  status?: string;
  transferMemo?: string;
  /** Order creation time — required by expiry tests; defaults to "now" so
   *  non-expiry tests sit safely inside the 50-minute payment window. */
  createdAt?: Date;
}): Promise<any> {
  seq++;
  return prisma.order.create({
    data: {
      id: `ORD-PQR-${seq}-${Date.now().toString(36).toUpperCase()}`,
      customerId,
      sourceCurrency: opts.currency,
      targetCurrency: opts.currency === "USD" ? "VND" : "USD",
      sourceAmount: opts.amount,
      targetAmount: opts.currency === "USD" ? 2540000 : 100,
      rate: 25400,
      fee: 2,
      feeCurrency: "USD",
      receivingAccountSnapshot: opts.snapshot,
      transferMemo: opts.transferMemo,
      createdAt: opts.createdAt ?? new Date(),
      status: opts.status ?? "WAITING_PAYMENT"
    }
  });
}

// 1/2 — provider selection by incoming payment currency (real SDKs)
describe("provider selection (USD → KHQR, VND → VietQR)", () => {
  it("USD incoming generates a KHQR dynamic payload (official SDK, CRC valid)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "USD",
      amount: "100",
      snapshot: snap({ khqrBakongAccountId: "exchange@aclb", khqrMerchantName: "EXCHANGE DESK", khqrMerchantCity: "Phnom Penh" }),
      transferMemo: "A7K92 CK"
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.type).toBe("KHQR");
    expect(result!.payload).toBeTruthy();
    expect(BakongKHQR.verify(result!.payload!).isValid).toBe(true);
    expect(result!.imageBuffer!.length).toBeGreaterThan(0);
  });

  it("VND incoming generates a VietQR dynamic payload (library CRC valid)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "2540000",
      snapshot: snap({ currency: "VND", bankBin: "970436" }),
      transferMemo: "A7K92 CK"
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.type).toBe("VIETQR");
    expect(result!.payload).toBeTruthy();
    expect(new QRPay(result!.payload!).isValid).toBe(true);
    expect(result!.imageBuffer!.length).toBeGreaterThan(0);
  });
});

// FINAL PASS — KHQR expiration derives from the Order payment deadline
describe("KHQR expiration = Order payment deadline (never renewed on re-display)", () => {
  it("deadline = Order.createdAt + AUTO_CANCEL_MIN (authoritative constant)", () => {
    const createdAt = new Date("2026-01-01T10:00:00Z");
    const deadline = computePaymentDeadlineMs({ createdAt });
    expect(deadline).toBe(createdAt.getTime() + 50 * 60_000); // AUTO_CANCEL_MIN = 50
  });

  it("initial QR embeds the Order deadline; re-display does NOT extend it", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-01-01T10:00:00Z").getTime();
      vi.setSystemTime(new Date(t0));
      const customer = await makeCustomer();
      const order = await makeOrder(customer.id, {
        currency: "USD",
        amount: "100",
        snapshot: snap({ khqrBakongAccountId: "exchange@aclb", khqrMerchantName: "EXCHANGE DESK", khqrMerchantCity: "Phnom Penh" }),
        transferMemo: "A7K92 CK",
        createdAt: new Date(t0)
      });
      const deadlineMs = computePaymentDeadlineMs(order);
      expect(deadlineMs).toBe(t0 + 50 * 60_000);

      const first = await PaymentQrService.generateForOrder(order.id);
      expect(first!.type).toBe("KHQR");
      expect(first!.payload).toContain(String(deadlineMs));

      // Re-display 30 minutes later (payinfo path): expiration MUST be unchanged.
      vi.setSystemTime(new Date(t0 + 30 * 60_000));
      const second = await PaymentQrService.generateForOrder(order.id);
      expect(second!.type).toBe("KHQR");
      expect(second!.payload).toContain(String(deadlineMs));
      const extendedDeadline = Date.now() + 50 * 60_000;
      expect(second!.payload).not.toContain(String(extendedDeadline));
    } finally {
      vi.useRealTimers();
    }
  });

  it("expired WAITING_PAYMENT Order → EXPIRED result: NO dynamic QR, NO static, NO text card", async () => {
    const now = Date.now();
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "USD",
      amount: "100",
      snapshot: snap({
        khqrBakongAccountId: "exchange@aclb", khqrMerchantName: "EXCHANGE DESK", khqrMerchantCity: "Phnom Penh",
        qrFilePath: "pqr-test/should-never-be-sent.png" // static configured but MUST NOT be sent
      }),
      transferMemo: "A7K92 CK",
      createdAt: new Date(now - 51 * 60_000) // deadline passed (AUTO_CANCEL_MIN = 50)
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    // EXPIRED contract: no payment method of any kind is presented.
    expect(result!.type).toBe("EXPIRED");
    expect(result!.degradedReason).toBe("PAYMENT_DEADLINE_REACHED");
    expect(result!.imageBuffer).toBeNull();      // no dynamic/static QR
    expect(result!.payload).toBeUndefined();     // no payload at all
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYMENT"); // scheduler remains authoritative
  });
});

// 3/4/5/6 — locked Order data is the single source of truth
describe("frozen Order payment data", () => {
  it("KHQR Individual + Merchant mappings embed exact amount + memo", () => {
    // Deterministic valid-future expiration (within the 50-min payment window):
    const expirationMs = Date.now() + 50 * 60_000;
    const cap = detectKhqrCapability(snap({ khqrBakongAccountId: "x@dev", khqrMerchantName: "M", khqrMerchantCity: "Phnom Penh" }))!;
    expect(cap.mode).toBe("INDIVIDUAL");
    const pInd = buildKhqrPayload(cap, "100", "A7K92 CK", expirationMs);
    expect(BakongKHQR.verify(pInd).isValid).toBe(true);

    const capM = detectKhqrCapability(snap({
      khqrBakongAccountId: "x@dev", khqrMerchantName: "M", khqrMerchantCity: "Phnom Penh",
      khqrMode: "MERCHANT", khqrMerchantId: "M123", khqrAcquiringBank: "ACLEDA"
    }))!;
    expect(capM.mode).toBe("MERCHANT");
    const pMer = buildKhqrPayload(capM, "100", "A7K92 CK", expirationMs);
    expect(BakongKHQR.verify(pMer).isValid).toBe(true);
  });

  it("VietQR payload parses with exact bankBin/account/amount/purpose", () => {
    const cap = detectVietQrCapability(snap({ currency: "VND", bankBin: "970436" }))!;
    const payload = buildVietQrPayload(cap, "2540000", "A7K92 CK");
    const parsed = new QRPay(payload);
    expect(parsed.isValid).toBe(true);
    expect(parsed.consumer.bankBin).toBe("970436");
    expect(parsed.consumer.bankNumber).toBe("0012345678");
    expect(parsed.amount).toBe("2540000");
    expect(parsed.additionalData.purpose).toBe("A7K92 CK");
  });

  it("KHQR decimal USD amount 100.25 embeds exactly 100.25 (SDK boundary: NUMBER, ≤2dp)", () => {
    const expirationMs = Date.now() + 50 * 60_000; // deterministic valid-future
    const cap = detectKhqrCapability(snap({ khqrBakongAccountId: "x@dev", khqrMerchantName: "M", khqrMerchantCity: "Phnom Penh" }))!;
    const payload = buildKhqrPayload(cap, "100.25", "A7K92 CK", expirationMs);
    expect(BakongKHQR.verify(payload).isValid).toBe(true);
    // EMV tag 54 (amount), length 05, value "100.25":
    expect(payload).toContain("5405100.25");
    // >2 decimals are REJECTED at the SDK boundary — no rounding, no
    // truncation; the safe STATIC/TEXT fallback handles it instead:
    expect(() => buildKhqrPayload(cap, "100.256", "A7K92 CK", expirationMs)).toThrow(/2 decimal places/);
  });

  it("QR amount exactly equals the locked Order payment amount (no recomputation)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "1234500",
      snapshot: snap({ currency: "VND", bankBin: "970436" }),
      transferMemo: "A7K92 CK"
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.amount).toBe("1234500");
    const parsed = new QRPay(result!.payload!);
    expect(parsed.amount).toBe("1234500");
  });

  it("memo exactly equals the FROZEN Order.transferMemo — even if template changes", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "2540000",
      snapshot: snap({ currency: "VND", bankBin: "970436" }),
      transferMemo: "A7K92 CK"
    });
    // Admin changes the transfer-memo template AFTER Order creation:
    const prev = SystemConfigService.getTransferMemoTemplate();
    await SystemConfigService.setTransferMemoTemplate("{username}", "PQR-TEST");
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.memo).toBe("A7K92 CK"); // frozen — NOT regenerated
    const parsed = new QRPay(result!.payload!);
    expect(parsed.additionalData.purpose).toBe("A7K92 CK");
    await SystemConfigService.setTransferMemoTemplate(prev, "PQR-TEST-restore");
  });

  it("changing the PaymentAccount AFTER Order creation does not change the old Order QR", async () => {
    const customer = await makeCustomer();
    const account = await prisma.paymentAccount.create({
      data: {
        id: `PA-PQR-${seq}-${Date.now().toString(36).toUpperCase()}`,
        currency: "VND",
        bankName: "Vietcombank",
        accountName: "EXCHANGE DESK VND",
        accountNumber: "9988776655",
        qrProvider: "VIETQR",
        bankBin: "970436",
        isActive: true
      }
    });
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "500000",
      snapshot: snap({ currency: "VND", bankBin: "970436", accountNumber: "9988776655" }),
      transferMemo: "A7K92 CK"
    });
    // Admin rotates the account metadata AFTER the Order snapshot was frozen:
    await prisma.paymentAccount.update({
      where: { id: account.id },
      data: { bankBin: "970422", accountNumber: "0000000001", qrProvider: "STATIC" }
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    // Order still uses the FROZEN snapshot, not fresh config:
    const parsed = new QRPay(result!.payload!);
    expect(parsed.consumer.bankBin).toBe("970436");
    expect(parsed.consumer.bankNumber).toBe("9988776655");
    expect(result!.memo).toBe("A7K92 CK");
  });
});

// 7–15 — fallback chain + survival
describe("fallback chain and survival", () => {
  it("dynamic generation failure → STATIC fallback → text fallback (never throws)", async () => {
    const customer = await makeCustomer();
    // amount with >2 decimals → official KHQR SDK rejects (TRANSACTION_AMOUNT_
    // INVALID) → dynamic fails → no static file → text-only. Order survives.
    const order = await makeOrder(customer.id, {
      currency: "USD",
      amount: "100.256",
      snapshot: snap({ khqrBakongAccountId: "x@dev", khqrMerchantName: "M", khqrMerchantCity: "Phnom Penh" }),
      transferMemo: "A7K92 CK"
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("NONE");
    expect(String(result!.degradedReason).startsWith("DYNAMIC_FAILED")).toBe(true);
    expect(result!.memo).toBe("A7K92 CK");
    const fresh: any = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh.status).toBe("WAITING_PAYMENT");
  });

  it("static unavailable → text-only with exact amount/memo (Order survives)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, { currency: "USD", amount: "100", snapshot: snap() });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.type).toBe("NONE");
    expect(result!.amount).toBe("100");
    expect(result!.memo).toBeTruthy();
    expect(result!.imageBuffer).toBeNull();
  });

  it("PNG rendering produces a non-empty PNG buffer", async () => {
    const cap = detectVietQrCapability(snap({ currency: "VND", bankBin: "970436" }))!;
    const payload = buildVietQrPayload(cap, "100000", "A7K92 CK");
    const png = await renderQrPng(payload);
    expect(png.length).toBeGreaterThan(100);
    // PNG magic bytes
    expect(png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it("verified/cancelled orders are no longer presented as an active QR", async () => {
    const customer = await makeCustomer();
    const done = await makeOrder(customer.id, { currency: "USD", amount: "100", snapshot: snap(), status: "COMPLETED" });
    const cancelled = await makeOrder(customer.id, { currency: "USD", amount: "100", snapshot: snap(), status: "CANCELLED" });
    expect(await PaymentQrService.generateForOrder(done.id)).toBeNull();
    expect(await PaymentQrService.generateForOrder(cancelled.id)).toBeNull();
  });
});

// EXPIRED — customer UX (shared renderer + payinfo obey the same rule)
describe("expired Order customer UX (localized, no payment method)", () => {
  it("expired payinfo → localized expired message, NO QR/account details", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.setSystemTime(new Date(now));
      const customer = await makeCustomer();
      const order = await makeOrder(customer.id, {
        currency: "USD",
        amount: "100",
        snapshot: snap({ khqrBakongAccountId: "exchange@aclb", khqrMerchantName: "EXCHANGE DESK", khqrMerchantCity: "Phnom Penh" }),
        transferMemo: "A7K92 CK",
        createdAt: new Date(now - 51 * 60_000)
      });
      const { ctx, sent } = fakeCtx();
      await sendOrderPaymentCard(ctx, order, "vi" as any);

      expect(sent.length).toBe(1);
      expect(sent[0]!.kind).toBe("text"); // no photo/QR at all
      const text = String(sent[0]!.payload.text);
      expect(text).toContain("⏰");
      expect(text).toContain("#");
      expect(text).toContain("hết thời gian thanh toán");
      // No account details, no memo instruction, no keyboard actions:
      expect(text).not.toContain("Acleda");
      expect(text).not.toContain("A7K92 CK");
      expect(sent[0]!.payload.opts?.reply_markup).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("before deadline: dynamic failure → STATIC fallback still works", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(new Date(t0));
      const customer = await makeCustomer();
      // >2 decimals → official KHQR SDK rejects → dynamic fails INSIDE the
      // pre-deadline window → configured static QR (real file) is used.
      const { LocalStorageService } = await import("../src/modules/storage/local-storage-service.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const rel = `pqr-test/static-${seq}-${t0}.png`;
      const abs = path.join(LocalStorageService.getStorageRoot(), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));

      const order = await makeOrder(customer.id, {
        currency: "USD",
        amount: "100.256",
        snapshot: snap({
          khqrBakongAccountId: "x@dev", khqrMerchantName: "M", khqrMerchantCity: "Phnom Penh",
          qrFilePath: rel
        }),
        transferMemo: "A7K92 CK",
        createdAt: new Date(t0 - 10 * 60_000) // 10 min old — deadline NOT reached
      });
      const result = await PaymentQrService.generateForOrder(order.id);
      expect(result!.type).toBe("STATIC"); // static fallback BEFORE deadline
      expect(result!.degradedReason).toBe("DYNAMIC_FAILED");
      expect(result!.imageBuffer!.length).toBeGreaterThan(0);
      fs.rmSync(path.dirname(abs), { recursive: true, force: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("before deadline: no QR available → text fallback still works", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      vi.setSystemTime(new Date(t0));
      const customer = await makeCustomer();
      const order = await makeOrder(customer.id, {
        currency: "USD",
        amount: "100",
        snapshot: snap(),
        transferMemo: "A7K92 CK",
        createdAt: new Date(t0 - 10 * 60_000) // pre-deadline
      });
      const result = await PaymentQrService.generateForOrder(order.id);
      expect(result!.type).toBe("NONE"); // text payment info only
      expect(result!.degradedReason).toBe("NO_QR");
      expect(result!.memo).toBe("A7K92 CK");
    } finally {
      vi.useRealTimers();
    }
  });
});

// 19/20 — amount normalization
describe("amount normalization", () => {
  it("VND → integer string; USD → precision-preserving string", () => {
    expect(normalizeVndAmountString("2540000")).toBe("2540000");
    expect(normalizeVndAmountString("2540000.40")).toBe("2540000");
    expect(normalizeUsdAmountString("100")).toBe("100");
    expect(normalizeUsdAmountString("99.95")).toBe("99.95");
  });
});

// 16/17/18 — Telegram one-message card (auto-send, no Get-QR, shared renderer)
import { sendOrderPaymentCard } from "../src/bot/handlers/customer-handler.js";

function fakeCtx(): { ctx: any; sent: Array<{ kind: string; payload: any }> } {
  const sent: Array<{ kind: string; payload: any }> = [];
  const ctx: any = {
    reply: async (text: any, opts?: any) => {
      sent.push({ kind: "text", payload: { text, opts } });
      return { message_id: 1 };
    },
    replyWithPhoto: async (photo: any, opts?: any) => {
      sent.push({ kind: "photo", payload: { photo, opts } });
      return { message_id: 2 };
    }
  };
  return { ctx, sent };
}

describe("Telegram one-message payment card", () => {
  it("quote-confirm path sends ONE message; QR keyboard = ❌ Cancel + 💬 Support only (NO Get-QR)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "USD",
      amount: "100",
      snapshot: snap(),
      transferMemo: "A7K92 CK",
      status: "WAITING_PAYMENT"
    });
    const { ctx, sent } = fakeCtx();
    await sendOrderPaymentCard(ctx, order, "vi" as any);

    expect(sent.length).toBe(1); // ONE message — no separate QR step
    const payload = sent[0]!.payload;
    const caption = String(payload.text ?? payload.opts?.caption ?? "");
    expect(caption).toContain("#");
    expect(caption).toContain("A7K92 CK");
    expect(caption).toContain("100 USD");
    const kbJson = JSON.stringify(payload.opts?.reply_markup ?? {});
    // No QR available in mock → text card keeps the FULL keyboard
    // (incl. 💳 payinfo recovery). No Get-QR action may ever exist:
    expect(/getqr|showqr|generateqr/i.test(kbJson)).toBe(false);
    expect(kbJson).toContain("customer:menu:support");
  });

  it("QR photo message keyboard contains ONLY ❌ Cancel + 💬 Support", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "2540000",
      snapshot: snap({ currency: "VND", bankBin: "970436" }),
      transferMemo: "A7K92 CK"
    });
    const result = await PaymentQrService.generateForOrder(order.id);
    expect(result!.type).toBe("VIETQR"); // dynamic QR → photo message path

    const { ctx, sent } = fakeCtx();
    // Reuse the exact same renderer branch: photo present → caption + compact kb
    await sendOrderPaymentCard(ctx, { ...order, receivingAccountSnapshot: { ...snap({ currency: "VND", bankBin: "970436" }) } }, "vi" as any);
    const photo = sent.find((s) => s.kind === "photo");
    expect(photo).toBeDefined();
    const kbJson = JSON.stringify(photo!.payload.opts?.reply_markup ?? {});
    expect(kbJson).toContain("customer:order:cancel:");
    expect(kbJson).toContain("customer:menu:support");
    // No redundant actions under the QR itself:
    expect(kbJson).not.toContain("customer:bill:upload:");
    expect(kbJson).not.toContain("customer:order:payinfo:");
    expect(/getqr|showqr|generateqr/i.test(kbJson)).toBe(false);
  });

  it("payinfo re-display reproduces the SAME Order payment data (shared renderer)", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "USD",
      amount: "100",
      snapshot: snap(),
      transferMemo: "A7K92 CK"
    });
    const c1 = fakeCtx();
    const c2 = fakeCtx();
    await sendOrderPaymentCard(c1.ctx, order, "vi" as any);
    await sendOrderPaymentCard(c2.ctx, order, "vi" as any);
    const cap1 = String(c1.sent[0]!.payload.text ?? c1.sent[0]!.payload.opts?.caption ?? "");
    const cap2 = String(c2.sent[0]!.payload.text ?? c2.sent[0]!.payload.opts?.caption ?? "");
    expect(cap1).toBe(cap2);
    expect(cap1).toContain("A7K92 CK");
  });
});

// 21 — no AI path (functional: module works with zero AI configuration)
describe("deterministic — no AI", () => {
  it("identical output across runs; no AI configuration required", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, {
      currency: "VND",
      amount: "2540000",
      snapshot: snap({ currency: "VND", bankBin: "970436" }),
      transferMemo: "A7K92 CK"
    });
    const a = await PaymentQrService.generateForOrder(order.id);
    const b = await PaymentQrService.generateForOrder(order.id);
    expect(a!.payload).toBe(b!.payload);
  });
});

// 22 — caption keys for vi/en/km/zh
describe("customer card caption keys (vi/en/km/zh)", () => {
  it("paymentqr keys exist for all locales", () => {
    const keys = ["paymentqr.pay_line", "paymentqr.memo_line", "paymentqr.send_bill_hint"];
    for (const loc of SUPPORTED_LOCALES) {
      for (const key of keys) {
        const v = t(loc, key, { amount: "100", currency: "USD", memo: "ABC123 CK" });
        expect(v, `${loc}:${key}`).toBeTruthy();
        expect(v, `${loc}:${key}`).not.toBe(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// TASK 2 — KHQR CONFIG UX (shared readiness validation)
// ---------------------------------------------------------------------------
describe("getQrReadiness — the SAME validation PaymentQrService uses at runtime", () => {
  it("simple USD KHQR (INDIVIDUAL: bakong + name + city) is READY", () => {
    const r = getQrReadiness({
      currency: "USD",
      qrProvider: "KHQR",
      khqrMode: "INDIVIDUAL",
      khqrBakongAccountId: "personal@aba",
      khqrMerchantName: "Personal ABA",
      khqrMerchantCity: "Phnom Penh"
    });
    expect(r.provider).toBe("KHQR");
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
    // INDIVIDUAL never requires Merchant ID / Acquiring Bank:
    expect(JSON.stringify(r.missing)).not.toContain("Merchant ID");
    expect(JSON.stringify(r.missing)).not.toContain("Acquiring");
  });

  it("MERCHANT mode is NEVER ready unless every merchant field is present", () => {
    const incomplete = getQrReadiness({
      currency: "USD",
      qrProvider: "KHQR",
      khqrMode: "MERCHANT",
      khqrBakongAccountId: "merchant@aba",
      khqrMerchantName: "MERCHANT DESK",
      khqrMerchantCity: "Phnom Penh"
      // khqrMerchantId + khqrAcquiringBank MISSING
    });
    expect(incomplete.ready).toBe(false);
    expect(JSON.stringify(incomplete.missing)).toContain("Merchant ID");
    expect(JSON.stringify(incomplete.missing)).toContain("Acquiring Bank");

    const complete = getQrReadiness({
      currency: "USD",
      qrProvider: "KHQR",
      khqrMode: "MERCHANT",
      khqrBakongAccountId: "merchant@aba",
      khqrMerchantName: "MERCHANT DESK",
      khqrMerchantCity: "Phnom Penh",
      khqrMerchantId: "123456",
      khqrAcquiringBank: "ABA"
    });
    expect(complete.ready).toBe(true);
  });

  it("USD KHQR missing ANY simple field reports the exact missing list (never a blank mode)", () => {
    const r = getQrReadiness({ currency: "USD", qrProvider: "KHQR", khqrMode: "INDIVIDUAL" });
    expect(r.ready).toBe(false);
    expect(JSON.stringify(r.missing)).toContain("Bakong");
    expect(JSON.stringify(r.missing)).toContain("Tên hiển thị");
    expect(JSON.stringify(r.missing)).toContain("Thành phố");
  });

  it("VND VietQR readiness mirrors detectVietQrCapability", () => {
    const ok = getQrReadiness({ currency: "VND", qrProvider: "VIETQR", bankBin: "970436", accountNumber: "9988776655" });
    expect(ok.provider).toBe("VIETQR");
    expect(ok.ready).toBe(true);

    const bad = getQrReadiness({ currency: "VND", qrProvider: "VIETQR", accountNumber: "9988776655" });
    expect(bad.ready).toBe(false);
    expect(JSON.stringify(bad.missing)).toContain("Bank BIN");
  });

  it("readiness output strings follow the Admin UX contract (never a blank mode)", () => {
    expect(readinessLine({ provider: "KHQR", ready: true, missing: [] })).toBe("🟢 KHQR động — Sẵn sàng");
    expect(readinessLine({ provider: "VIETQR", ready: true, missing: [] })).toBe("🟢 VietQR động — Sẵn sàng");
    const notReady = readinessLine({
      provider: "KHQR",
      ready: false,
      missing: ["Bakong Account ID (name@bank)", "Tên hiển thị"]
    });
    expect(notReady.startsWith("🟡 QR tĩnh")).toBe(true);
    expect(notReady).toContain("KHQR động chưa sẵn sàng:");
    expect(notReady).toContain("Thiếu: Bakong Account ID (name@bank), Tên hiển thị");
    // The mode label is NEVER blank (old bug rendered "KHQR — "):
    expect(notReady).not.toContain("KHQR —");
  });
});

describe("resolveVietQrBank — verified NAPAS table only, BIN never invented", () => {
  it("resolves a bank by NAME (case-insensitive)", () => {
    const b = resolveVietQrBank("vietcombank");
    expect(b).not.toBeNull();
    expect(b!.bankBin).toMatch(/^\d{4,6}$/);
    expect(b!.bankName.toLowerCase()).toContain("vietcombank");
  });

  it("resolves an exact BIN and rejects an unknown BIN", () => {
    const b = resolveVietQrBank("970436");
    expect(b).not.toBeNull();
    expect(b!.bankBin).toBe("970436");
    expect(resolveVietQrBank("0000")).toBeNull();
    expect(resolveVietQrBank("not-a-bank")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TASK 2 — SIMPLE vs ADVANCED wizard save behavior (khqrMode is PERSISTED)
// ---------------------------------------------------------------------------
describe("ops:qrmeta wizard — simple flow saves KHQR/INDIVIDUAL, MERCHANT is gated", () => {
  let wizSeq = 0;

  function fakeCtx(telegramId: string): { ctx: any; replies: any[] } {
    const replies: any[] = [];
    const ctx: any = {
      from: { id: Number(telegramId), is_bot: false, first_name: "QR Admin" },
      reply: async (text: string, opts?: any) => {
        replies.push({ text, opts });
        return { message_id: replies.length };
      },
      answerCallbackQuery: async () => true,
      callbackQuery: { data: "" }
    };
    return { ctx, replies };
  }

  async function makeAccount(): Promise<any> {
    wizSeq++;
    return prisma.paymentAccount.create({
      data: {
        id: `PA-WIZ-${wizSeq}-${Date.now().toString(36).toUpperCase()}`,
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "PERSONAL ABA USD",
        accountNumber: `001234${wizSeq}`,
        isActive: true
      }
    }) as any;
  }

  it("simple KHQR flow (Bakong ID / Name / City ONLY) persists qrProvider=KHQR + khqrMode=INDIVIDUAL", async () => {
    wizSeq++;
    const adminTg = String(993000000 + wizSeq);
    const { PermissionService } = await import("../src/modules/permissions/permission-service.js");
    await PermissionService.inviteStaff({ telegramId: adminTg, name: "QR Admin", role: "ADMIN" });

    const acc = await makeAccount();
    const { startAccountQrMetaWizard, handleAccountQrMetaInput, confirmAccountQrMeta } =
      await import("../src/bot/admin/account-qr-meta.js");

    // 1. Open the SIMPLE wizard — only 3 questions are asked.
    const start = fakeCtx(adminTg);
    await startAccountQrMetaWizard(start.ctx, "khqr_simple", acc.id);
    const startText = start.replies.map((r) => r.text).join("\n");
    expect(startText).toContain("Bakong");
    expect(startText).toContain("1/3"); // exactly 3 steps, no merchant fields

    // 2. Answer Bakong ID, Display name, City.
    await handleAccountQrMetaInput(fakeCtx(adminTg).ctx, "personal@aba");
    await handleAccountQrMetaInput(fakeCtx(adminTg).ctx, "Personal ABA");
    const q3 = fakeCtx(adminTg);
    await handleAccountQrMetaInput(q3.ctx, "Phnom Penh");
    // Preview names the mode explicitly — never blank:
    expect(q3.replies.map((r) => r.text).join("\n")).toContain("KHQR INDIVIDUAL");

    // 3. Confirm → save.
    const confirm = fakeCtx(adminTg);
    await confirmAccountQrMeta(confirm.ctx, acc.id);

    const saved: any = await prisma.paymentAccount.findUnique({ where: { id: acc.id } });
    expect(saved.qrProvider).toBe("KHQR"); // NOT "MERCHANT" (old regression)
    expect(saved.khqrMode).toBe("INDIVIDUAL"); // never LOST (old regression)
    expect(saved.khqrBakongAccountId).toBe("personal@aba");
    expect(saved.khqrMerchantId ?? null).toBeNull(); // simple path requires NO Merchant fields
    expect(saved.khqrAcquiringBank ?? null).toBeNull();

    // 4. Save confirmation uses the SHARED readiness line:
    expect(confirm.replies.map((r) => r.text).join("\n")).toContain("🟢 KHQR động — Sẵn sàng");
  });

  it("MERCHANT flow refuses to save when merchant-required fields are missing", async () => {
    wizSeq++;
    const adminTg = String(993000000 + wizSeq);
    const { PermissionService } = await import("../src/modules/permissions/permission-service.js");
    await PermissionService.inviteStaff({ telegramId: adminTg, name: "QR Admin 2", role: "ADMIN" });

    const acc = await makeAccount();
    const { startAccountQrMetaWizard, handleAccountQrMetaInput, confirmAccountQrMeta } =
      await import("../src/bot/admin/account-qr-meta.js");

    const start = fakeCtx(adminTg);
    await startAccountQrMetaWizard(start.ctx, "khqr_merchant", acc.id);
    expect(start.replies.map((r) => r.text).join("\n")).toContain("KHQR MERCHANT NÂNG CAO");

    // Fill Bakong/Name/City but STOP before Merchant ID / Acquiring Bank:
    await handleAccountQrMetaInput(fakeCtx(adminTg).ctx, "merchant@aba");
    await handleAccountQrMetaInput(fakeCtx(adminTg).ctx, "MERCHANT DESK");
    await handleAccountQrMetaInput(fakeCtx(adminTg).ctx, "Phnom Penh");

    // Confirming with an incomplete merchant config must NOT save:
    const confirm = fakeCtx(adminTg);
    await confirmAccountQrMeta(confirm.ctx, acc.id);

    const saved: any = await prisma.paymentAccount.findUnique({ where: { id: acc.id } });
    expect(saved.qrProvider ?? "STATIC").not.toBe("KHQR"); // no misleading successful save
    expect(confirm.replies.map((r) => r.text).join("\n")).toContain("Thiếu");
  });
});
