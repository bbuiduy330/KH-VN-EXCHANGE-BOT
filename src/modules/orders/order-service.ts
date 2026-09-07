import Decimal from "decimal.js";
import { prisma } from "../../database/client.js";
import { QuoteCalculation } from "../quotes/quote-service.js";
import { PaymentAccountService } from "../payment-accounts/account-service.js";
import { CustomerService } from "../customer/customer-service.js";
import { FileService } from "../files/file-service.js";
import { AiProvider } from "../ai/ai-provider.js";
import { AuditService } from "../audit/audit-service.js";
import { DriveArchiveService } from "../drive/drive-service.js";

export class OrderService {
  static async createOrderFromQuote(
    customerId: string,
    quote: QuoteCalculation
  ) {
    // 1. Snapshot receiving account for the source currency
    const receivingAccount = await PaymentAccountService.getActiveAccountForCurrency(
      quote.sourceCurrency
    );
    if (!receivingAccount) {
      throw new Error(`Không tìm thấy tài khoản nhận cho đồng ${quote.sourceCurrency}`);
    }

    // 2. Snapshot customer payout bank for target currency
    const payoutBank = await CustomerService.getPayoutBank(
      customerId,
      quote.targetCurrency
    );
    if (!payoutBank) {
      throw new Error(
        `Vui lòng thiết lập tài khoản nhận tiền ${quote.targetCurrency} trước khi tạo đơn: /bank ${quote.targetCurrency}|Tên Ngân Hàng|Tên Chủ TK|Số TK`
      );
    }

    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const order = await prisma.order.create({
      data: {
        id: orderId,
        customerId,
        sourceCurrency: quote.sourceCurrency,
        targetCurrency: quote.targetCurrency,
        sourceAmount: quote.sourceAmount,
        targetAmount: quote.targetAmount,
        rate: quote.effectiveRate,
        fee: quote.fee,
        feeCurrency: quote.feeCurrency,
        receivingAccountId: receivingAccount.id,
        receivingAccountSnapshot: {
          currency: receivingAccount.currency,
          bankName: receivingAccount.bankName,
          accountName: receivingAccount.accountName,
          accountNumber: receivingAccount.accountNumber,
          qrVersion: receivingAccount.qrVersion,
          qrSha256: receivingAccount.qrSha256,
          qrFilePath: receivingAccount.qrFilePath
        },
        payoutBankSnapshot: {
          currency: payoutBank.currency,
          bankName: payoutBank.bankName,
          accountName: payoutBank.accountName,
          accountNumber: payoutBank.accountNumber
        },
        status: "PENDING_PAYMENT"
      }
    });

    await AuditService.log({
      actorId: customerId,
      actorRole: "CUSTOMER",
      action: "ORDER_CREATED",
      targetType: "ORDER",
      targetId: order.id,
      details: {
        sourceAmount: quote.sourceAmount.toString(),
        targetAmount: quote.targetAmount.toString(),
        rate: quote.effectiveRate.toString()
      }
    });

    // Enqueue non-blocking Drive archive jobs
    DriveArchiveService.enqueueSyncJob(order.id, "ORDER_METADATA").catch(() => {});
    DriveArchiveService.enqueueSyncJob(order.id, "PAYMENT_QR").catch(() => {});

    return order;
  }

  static async submitCustomerBill(
    orderId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error("Không tìm thấy đơn hàng");
    if (order.status !== "PENDING_PAYMENT") {
      throw new Error(`Đơn hàng đang ở trạng thái ${order.status}, không thể nạp biên lai mới`);
    }

    // Save evidence file with SHA-256
    const evidence = await FileService.saveEvidenceFile(
      fileBuffer,
      fileName,
      "CUSTOMER_BILL",
      mimeType
    );

    // AI image analysis for secondary metadata only
    const aiMetadata = await AiProvider.analyzeBillImage(fileBuffer, mimeType);

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        customerBillFileId: evidence.id,
        customerBillSha256: evidence.sha256,
        aiExtractedData: aiMetadata || {}
      }
    });

    await AuditService.log({
      actorId: order.customerId,
      actorRole: "CUSTOMER",
      action: "BILL_SUBMITTED",
      targetType: "ORDER",
      targetId: orderId,
      details: { fileId: evidence.id, sha256: evidence.sha256 }
    });

    // Enqueue non-blocking customer bill sync job
    DriveArchiveService.enqueueSyncJob(orderId, "CUSTOMER_BILL", evidence.id).catch(() => {});

    return updated;
  }

  // Two-step payment confirmation by Admin
  static async confirmPaymentReceived(orderId: string, adminId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error("Không tìm thấy đơn hàng");
    if (order.status !== "PENDING_PAYMENT") {
      throw new Error(`Không thể xác nhận thanh toán khi đơn ở trạng thái ${order.status}`);
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "WAITING_PAYOUT",
        verifiedByAdminId: adminId,
        verifiedAt: new Date()
      }
    });

    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PAYMENT_VERIFIED",
      targetType: "ORDER",
      targetId: orderId,
      details: { verifiedAt: new Date() }
    });

    return updated;
  }

  // Step 1 of payout: Admin uploads payout proof bill -> status PAYOUT_SENT
  static async submitPayoutBill(
    orderId: string,
    adminId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error("Không tìm thấy đơn hàng");
    if (order.status !== "WAITING_PAYOUT") {
      throw new Error(`Đơn hàng cần ở trạng thái WAITING_PAYOUT (hiện tại: ${order.status})`);
    }

    const evidence = await FileService.saveEvidenceFile(
      fileBuffer,
      fileName,
      "PAYOUT_BILL",
      mimeType
    );

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "PAYOUT_SENT",
        payoutBillFileId: evidence.id,
        payoutBillSha256: evidence.sha256,
        payoutByAdminId: adminId,
        payoutAt: new Date()
      }
    });

    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "PAYOUT_BILL_UPLOADED",
      targetType: "ORDER",
      targetId: orderId,
      details: { fileId: evidence.id, sha256: evidence.sha256 }
    });

    // Enqueue non-blocking payout bill sync job
    DriveArchiveService.enqueueSyncJob(orderId, "PAYOUT_BILL", evidence.id).catch(() => {});

    return updated;
  }

  // Step 2 of payout: Two-step confirmation -> COMPLETED
  static async completePayout(orderId: string, adminId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error("Không tìm thấy đơn hàng");
    if (order.status !== "PAYOUT_SENT") {
      throw new Error(`Đơn hàng phải ở trạng thái PAYOUT_SENT trước khi hoàn tất (hiện tại: ${order.status})`);
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "COMPLETED",
        completedAt: new Date()
      }
    });

    await AuditService.log({
      actorId: adminId,
      actorRole: "ADMIN",
      action: "ORDER_COMPLETED",
      targetType: "ORDER",
      targetId: orderId,
      details: { completedAt: new Date() }
    });

    // Enqueue full archive sync upon order completion (conversation, audit, etc.)
    DriveArchiveService.enqueueSyncJob(orderId, "CONVERSATION").catch(() => {});
    DriveArchiveService.enqueueSyncJob(orderId, "AUDIT").catch(() => {});
    DriveArchiveService.enqueueSyncJob(orderId, "FULL_ORDER_ARCHIVE").catch(() => {});

    return updated;
  }

  static async getOrder(id: string) {
    return prisma.order.findUnique({ where: { id } });
  }

  static async getOrdersByStatus(status: any) {
    return prisma.order.findMany({ where: { status }, orderBy: { createdAt: "desc" } });
  }

  static async getAllOrders(limit: number = 50) {
    return prisma.order.findMany({ take: limit, orderBy: { createdAt: "desc" } });
  }
}
