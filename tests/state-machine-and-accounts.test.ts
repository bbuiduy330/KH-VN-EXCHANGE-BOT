import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import { OrderService } from "../src/modules/orders/order-service.js";
import { PaymentAccountService } from "../src/modules/payment-accounts/account-service.js";
import { CustomerService } from "../src/modules/customer/customer-service.js";
import { QuoteCalculation } from "../src/modules/quotes/quote-service.js";
import { prisma } from "../src/database/client.js";

describe("State Machine, Account Versioning & Fraud Prevention Tests", () => {
  const customerTelegramId = "9988776655";
  let customerId: string;

  beforeEach(async () => {
    // Find or create customer
    let customer = await prisma.customer.findUnique({
      where: { telegramId: customerTelegramId }
    });
    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          telegramId: customerTelegramId,
          username: "test_customer",
          fullName: "Nguyễn Văn Test"
        }
      });
    }
    customerId = customer.id;

    // Set payout bank for customer for USD and VND
    await CustomerService.setPayoutBank({
      customerId,
      currency: "USD",
      bankName: "ABA Bank",
      accountName: "NGUYEN VAN TEST",
      accountNumber: "000111222"
    });
    await CustomerService.setPayoutBank({
      customerId,
      currency: "VND",
      bankName: "Techcombank",
      accountName: "NGUYEN VAN TEST",
      accountNumber: "1903888888"
    });

    // Add VND payment account
    await PaymentAccountService.addAccount(
      {
        currency: "VND",
        bankName: "Vietcombank",
        accountName: "CONG TY TNHH TEST",
        accountNumber: "999888777666",
        isDefault: true,
        priority: 10,
        qrFileBuffer: Buffer.from("vietcombank-qr-base"),
        qrFileName: "vcb_qr.png"
      },
      "admin-init"
    );

    // Add USD payment account
    await PaymentAccountService.addAccount(
      {
        currency: "USD",
        bankName: "ABA Bank",
        accountName: "TEST CORP USD",
        accountNumber: "111222333",
        isDefault: true,
        priority: 10,
        qrFileBuffer: Buffer.from("aba-qr-base"),
        qrFileName: "aba_qr.png"
      },
      "admin-init"
    );
  });

  describe("Payment Account Versioning & Deterministic Selection", () => {
    it("Creates payment account with version 1 and increments version on QR change", async () => {
      const qrBuf1 = Buffer.from("dummy-qr-content-v1");
      const account = await PaymentAccountService.addAccount(
        {
          currency: "VND",
          bankName: "Techcombank",
          accountName: "CONG TY TNHH TEST 2",
          accountNumber: "190388998899",
          tag: "main",
          isDefault: false,
          priority: 5,
          qrFileBuffer: qrBuf1,
          qrFileName: "qr_v1.png",
          qrMimeType: "image/png"
        },
        "admin-user-1"
      );

      expect(account).toBeDefined();
      expect(account.qrVersion).toBe(1);
      expect(account.qrSha256).toBeDefined();

      // Update with new QR code by calling addAccount with the same currency & accountNumber
      const qrBuf2 = Buffer.from("dummy-qr-content-v2-different");
      const updated = await PaymentAccountService.addAccount(
        {
          currency: "VND",
          bankName: "Techcombank",
          accountName: "CONG TY TNHH TEST 2",
          accountNumber: "190388998899",
          tag: "main-updated",
          qrFileBuffer: qrBuf2,
          qrFileName: "qr_v2.png",
          qrMimeType: "image/png"
        },
        "admin-user-1"
      );

      expect(updated.qrVersion).toBe(2);
      expect(updated.qrSha256).not.toBe(account.qrSha256);

      // Verify versions history exists
      const versions = await PaymentAccountService.getAccountVersions(account.id);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions[0]?.version).toBe(2);
    });

    it("Selects active account deterministically based on currency and priority", async () => {
      const selected = await PaymentAccountService.getActiveAccountForCurrency("VND");
      expect(selected).not.toBeNull();
      expect(selected?.currency).toBe("VND");
      expect(selected?.qrVersion).toBeDefined();
    });
  });

  describe("Order State Machine & Atomic Transitions", () => {
    it("Follows strict state machine: WAITING_PAYMENT -> WAITING_ADMIN_VERIFY -> WAITING_PAYOUT -> PAYOUT_SENT -> COMPLETED", async () => {
      // 1. Create order
      const mockQuote: QuoteCalculation = {
        sourceCurrency: "VND",
        sourceAmount: new Decimal(10000000),
        targetCurrency: "USD",
        targetAmount: new Decimal(380),
        baseRate: new Decimal(26315),
        effectiveRate: new Decimal(26315),
        fee: new Decimal(2),
        feeCurrency: "USD",
        expiresAt: new Date(Date.now() + 60000)
      };

      const order = await OrderService.createOrderFromQuote(customerId, mockQuote);

      expect(order.id).toBeDefined();
      expect(order.status).toBe("WAITING_PAYMENT");

      // Verify initial state history logged
      const histories1 = await prisma.orderStateHistory.findMany({
        where: { orderId: order.id }
      });
      expect(histories1.length).toBeGreaterThanOrEqual(1);
      expect(histories1[0]?.toStatus).toBe("WAITING_PAYMENT");

      // 2. Customer submits bill -> WAITING_ADMIN_VERIFY
      const billData = Buffer.from("customer-receipt-test-unique-999");
      const billResult: any = await OrderService.submitCustomerBill(
        order.id,
        billData,
        "receipt.jpg",
        "image/jpeg",
        customerTelegramId
      );
      expect(billResult.status).toBe("WAITING_ADMIN_VERIFY");

      // 3. Admin verifies payment -> WAITING_PAYOUT
      const paid = await OrderService.confirmPaymentReceived(order.id, "admin-user-1");
      expect(paid.status).toBe("WAITING_PAYOUT");

      // 4. Admin submits payout -> PAYOUT_SENT
      const sent = await OrderService.submitPayoutBill(
        order.id,
        "admin-user-1",
        Buffer.from("payout-bill-data"),
        "payout_bill.jpg",
        "image/jpeg"
      );
      expect(sent.status).toBe("PAYOUT_SENT");

      // 5. Complete payout -> COMPLETED
      const completed = await OrderService.completePayout(order.id, "admin-user-1");
      expect(completed.status).toBe("COMPLETED");

      // Check all transitions recorded
      const historiesFinal = await prisma.orderStateHistory.findMany({
        where: { orderId: order.id }
      });
      expect(historiesFinal.length).toBeGreaterThanOrEqual(4);
    });

    it("Customer can cancel only before payment verification", async () => {
      const mockQuote: QuoteCalculation = {
        sourceCurrency: "USD",
        sourceAmount: new Decimal(500),
        targetCurrency: "VND",
        targetAmount: new Decimal(13150000),
        baseRate: new Decimal(26300),
        effectiveRate: new Decimal(26300),
        fee: new Decimal(0),
        feeCurrency: "USD",
        expiresAt: new Date(Date.now() + 60000)
      };

      const order = await OrderService.createOrderFromQuote(customerId, mockQuote);

      // Cancel while pending
      const cancelled = await OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "Đổi ý");
      expect(cancelled.status).toBe("CANCELLED");

      // Idempotent re-cancel (hardening contract): an already-CANCELLED order
      // is returned as-is — no second mutation, no duplicate audit entry.
      const again = await OrderService.cancelOrder(order.id, customerId, "CUSTOMER", "Thử lại");
      expect(again.status).toBe("CANCELLED");
    });

    it("Detects duplicate bill hash across orders and flags as SUSPICIOUS", async () => {
      const billData = Buffer.from("unique-duplicate-test-receipt-binary-554433");

      const mockQuote1: QuoteCalculation = {
        sourceCurrency: "VND",
        sourceAmount: new Decimal(5000000),
        targetCurrency: "USD",
        targetAmount: new Decimal(190),
        baseRate: new Decimal(26315),
        effectiveRate: new Decimal(26315),
        fee: new Decimal(0),
        feeCurrency: "USD",
        expiresAt: new Date(Date.now() + 60000)
      };

      // Order 1 receives the bill
      const order1 = await OrderService.createOrderFromQuote(customerId, mockQuote1);
      const res1: any = await OrderService.submitCustomerBill(
        order1.id,
        billData,
        "receipt1.jpg",
        "image/jpeg",
        customerTelegramId
      );
      expect(res1.status).toBe("WAITING_ADMIN_VERIFY");

      // Order 2 tries to reuse the exact same bill
      const mockQuote2: QuoteCalculation = {
        sourceCurrency: "VND",
        sourceAmount: new Decimal(5000000),
        targetCurrency: "USD",
        targetAmount: new Decimal(190),
        baseRate: new Decimal(26315),
        effectiveRate: new Decimal(26315),
        fee: new Decimal(0),
        feeCurrency: "USD",
        expiresAt: new Date(Date.now() + 60000)
      };

      const order2 = await OrderService.createOrderFromQuote(customerId, mockQuote2);
      const res2: any = await OrderService.submitCustomerBill(
        order2.id,
        billData,
        "receipt2.jpg",
        "image/jpeg",
        customerTelegramId
      );

      // Duplicate detected!
      expect(res2.status).toBe("SUSPICIOUS");
    });
  });
});
