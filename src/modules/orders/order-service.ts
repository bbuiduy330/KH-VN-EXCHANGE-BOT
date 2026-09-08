import Decimal from "decimal.js";
import { prisma } from "../../database/client.js";
import { QuoteCalculation } from "../quotes/quote-service.js";
import { PaymentAccountService } from "../payment-accounts/account-service.js";
import { CustomerService } from "../customer/customer-service.js";
import { FileService } from "../files/file-service.js";
import { AiProvider } from "../ai/ai-provider.js";
import { AuditService } from "../audit/audit-service.js";
import { LocalStorageService } from "../storage/local-storage-service.js";
import { logger } from "../../shared/logger.js";

export class OrderService {
  /**
   * Create an order from a calculated quote
   * Initial status: WAITING_PAYMENT
   */
  static async createOrderFromQuote(
    customerId: string,
    quote: QuoteCalculation
  ) {
    // 1. Snapshot receiving account for source currency using deterministic selection
    const receivingAccount = await PaymentAccountService.getActiveAccountForCurrency(
      quote.sourceCurrency
    );
    if (!receivingAccount) {
      throw new Error(`Không tìm thấy tài khoản nhận hợp lệ cho đồng ${quote.sourceCurrency}`);
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

    const receivingAccountSnapshot = {
      paymentAccountId: receivingAccount.id,
      currency: receivingAccount.currency,
      bankName: receivingAccount.bankName,
      accountName: receivingAccount.accountName,
      accountNumber: receivingAccount.accountNumber,
      qrVersion: receivingAccount.qrVersion,
      qrFileId: receivingAccount.qrFileId,
      qrFilePath: receivingAccount.qrFilePath,
      qrSha256: receivingAccount.qrSha256
    };

    const payoutBankSnapshot = {
      currency: payoutBank.currency,
      bankName: payoutBank.bankName,
      accountName: payoutBank.accountName,
      accountNumber: payoutBank.accountNumber
    };

    const order = await prisma.$transaction(async (tx: any) => {
      const created = await tx.order.create({
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
          receivingAccountSnapshot,
          payoutBankSnapshot,
          status: "WAITING_PAYMENT"
        }
      });

      await tx.orderStateHistory.create({
        data: {
          orderId: created.id,
          fromStatus: "WAITING_PAYMENT",
          toStatus: "WAITING_PAYMENT",
          actorId: customerId,
          actorRole: "CUSTOMER",
          reason: "ORDER_CREATED",
          metadata: {
            sourceAmount: quote.sourceAmount.toString(),
            targetAmount: quote.targetAmount.toString(),
            rate: quote.effectiveRate.toString(),
            receivingAccountId: receivingAccount.id
          }
        }
      });

      await AuditService.log(
        {
          actorId: customerId,
          actorRole: "CUSTOMER",
          action: "ORDER_CREATED",
          targetType: "ORDER",
          targetId: created.id,
          details: {
            sourceAmount: quote.sourceAmount.toString(),
            targetAmount: quote.targetAmount.toString(),
            rate: quote.effectiveRate.toString()
          }
        },
        tx
      );

      return created;
    });

    // Initialize order folders and archive initial metadata and payment QR locally
    LocalStorageService.archiveOrderMetadata(order.id).catch((err) => {
      logger.warn({ err, orderId: order.id }, "Failed to archive initial order metadata");
    });
    LocalStorageService.archivePaymentInstructionQr(order.id).catch((err) => {
      logger.warn({ err, orderId: order.id }, "Failed to archive payment instruction QR");
    });

    return order;
  }

  /**
   * Customer submits payment proof bill
   * Checks SHA-256 duplicate & transactionId duplicate (Fix 8)
   * Prevents silent replacement of bills (Fix 9)
   * Transitions: WAITING_PAYMENT -> CUSTOMER_SENT_BILL -> WAITING_ADMIN_VERIFY (Fix 2)
   */
  static async submitCustomerBill(
    orderId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    actorTelegramId?: string
  ) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });
    if (!order) throw new Error("Không tìm thấy đơn hàng");

    // Check allowed statuses for uploading bill
    const allowedStatuses = ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW"];
    if (!allowedStatuses.includes(order.status)) {
      throw new Error(`Đơn hàng đang ở trạng thái ${order.status}, không thể nạp biên lai mới.`);
    }

    // 1. Save original evidence file with SHA-256 calculation
    const evidence = await FileService.saveEvidenceFile(
      fileBuffer,
      fileName,
      "CUSTOMER_BILL",
      mimeType,
      orderId
    );

    // 2. Fix 8: Check duplicate SHA-256 across all orders
    const duplicateEvidence = await prisma.fileEvidence.findFirst({
      where: {
        sha256: evidence.sha256,
        id: { not: evidence.id }
      }
    });

    let duplicateOrder: any = null;
    if (duplicateEvidence) {
      duplicateOrder = await prisma.order.findFirst({
        where: {
          OR: [
            { customerBillSha256: evidence.sha256 },
            { payoutBillSha256: evidence.sha256 }
          ],
          id: { not: orderId }
        }
      });
    }

    // 3. AI bill extraction (metadata only, never sets confirmed)
    let aiMetadata: any = null;
    try {
      aiMetadata = await AiProvider.analyzeBillImage(fileBuffer, mimeType);
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "AI bill analysis failed or unavailable");
    }

    // 4. Check duplicate transactionId if AI extracted one
    let duplicateTxId = false;
    if (aiMetadata && aiMetadata.transactionId) {
      const existingWithTxId = await prisma.order.findFirst({
        where: {
          id: { not: orderId },
          aiExtractedData: {
            path: ["transactionId"],
            equals: aiMetadata.transactionId
          } as any
        }
      });
      if (existingWithTxId) duplicateTxId = true;
    }

    const uploaderId = actorTelegramId || order.customerId;

    // 5. Fix 9: Check if a bill was already uploaded previously
    const hasExistingBill = Boolean(order.customerBillFileId);

    return prisma.$transaction(async (tx: any) => {
      // Always store in OrderBillEvidence history preserving all uploaded bills
      await tx.orderBillEvidence.create({
        data: {
          orderId,
          fileId: evidence.id,
          filePath: evidence.filePath,
          sha256: evidence.sha256,
          extracted: aiMetadata || {},
          uploadedBy: uploaderId
        }
      });

      // Handle duplicate fraud detection
      if (duplicateOrder || duplicateTxId) {
        const flagReason = duplicateOrder
          ? `Biên lai trùng SHA-256 với đơn ${duplicateOrder.id} (${evidence.sha256})`
          : `Mã giao dịch ngân hàng ${aiMetadata?.transactionId} đã tồn tại ở đơn khác`;

        await tx.order.update({
          where: { id: orderId },
          data: {
            status: "SUSPICIOUS",
            // If first bill, record reference, else preserve initial primary evidence
            ...(!hasExistingBill ? {
              customerBillFileId: evidence.id,
              customerBillSha256: evidence.sha256,
              aiExtractedData: aiMetadata || {}
            } : {})
          }
        });

        await tx.orderStateHistory.create({
          data: {
            orderId,
            fromStatus: order.status,
            toStatus: "SUSPICIOUS",
            actorId: uploaderId,
            actorRole: "SYSTEM_SECURITY",
            reason: flagReason,
            metadata: { sha256: evidence.sha256, duplicateOrderId: duplicateOrder?.id }
          }
        });

        await AuditService.log(
          {
            actorId: uploaderId,
            actorRole: "SECURITY",
            action: "BILL_DUPLICATE_FLAGGED",
            targetType: "ORDER",
            targetId: orderId,
            details: { flagReason, sha256: evidence.sha256, duplicateOrderId: duplicateOrder?.id }
          },
          tx
        );

        return {
          status: "SUSPICIOUS",
          flagReason,
          orderId
        };
      }

      // If customer is re-uploading / replacing bill when a bill already exists (Fix 9)
      if (hasExistingBill) {
        // Do NOT overwrite original customerBillFileId or customerBillSha256 silently!
        // Flag for MANUAL_REVIEW with multiple bills attached in orderBillEvidence
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: "MANUAL_REVIEW"
          }
        });

        await tx.orderStateHistory.create({
          data: {
            orderId,
            fromStatus: order.status,
            toStatus: "MANUAL_REVIEW",
            actorId: uploaderId,
            actorRole: "CUSTOMER",
            reason: "CUSTOMER_SUBMITTED_ADDITIONAL_BILL",
            metadata: { newFileId: evidence.id, newSha256: evidence.sha256 }
          }
        });

        await AuditService.log(
          {
            actorId: uploaderId,
            actorRole: "CUSTOMER",
            action: "ADDITIONAL_BILL_SUBMITTED",
            targetType: "ORDER",
            targetId: orderId,
            details: { newFileId: evidence.id, sha256: evidence.sha256 }
          },
          tx
        );

        LocalStorageService.archiveCustomerBill(orderId, evidence.id).catch(() => {});
        LocalStorageService.archiveOrderMetadata(orderId).catch(() => {});

        return {
          status: "MANUAL_REVIEW",
          message: "Biên lai bổ sung đã được ghi nhận và gửi Admin kiểm duyệt thủ công.",
          orderId
        };
      }

      // Normal first bill submission:
      // WAITING_PAYMENT -> CUSTOMER_SENT_BILL -> WAITING_ADMIN_VERIFY
      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          customerBillFileId: evidence.id,
          customerBillSha256: evidence.sha256,
          aiExtractedData: aiMetadata || {},
          status: "WAITING_ADMIN_VERIFY"
        }
      });

      // Record first step: WAITING_PAYMENT -> CUSTOMER_SENT_BILL
      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "WAITING_PAYMENT",
          toStatus: "CUSTOMER_SENT_BILL",
          actorId: uploaderId,
          actorRole: "CUSTOMER",
          reason: "CUSTOMER_UPLOADED_BILL",
          metadata: { fileId: evidence.id, sha256: evidence.sha256 }
        }
      });

      // Record second step: CUSTOMER_SENT_BILL -> WAITING_ADMIN_VERIFY
      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "CUSTOMER_SENT_BILL",
          toStatus: "WAITING_ADMIN_VERIFY",
          actorId: "SYSTEM",
          actorRole: "SYSTEM",
          reason: "AWAITING_ADMIN_VERIFICATION",
          metadata: { aiExtracted: aiMetadata }
        }
      });

      await AuditService.log(
        {
          actorId: uploaderId,
          actorRole: "CUSTOMER",
          action: "BILL_SUBMITTED",
          targetType: "ORDER",
          targetId: orderId,
          details: { fileId: evidence.id, sha256: evidence.sha256 }
        },
        tx
      );

      LocalStorageService.archiveCustomerBill(orderId, evidence.id).catch(() => {});
      LocalStorageService.archiveOrderMetadata(orderId).catch(() => {});

      return updated;
    });
  }

  /**
   * Fix 3: Authorized Admin Payment Confirmation (Atomic + Idempotent)
   * WAITING_ADMIN_VERIFY -> PAYMENT_CONFIRMED -> WAITING_PAYOUT
   * Concurrency-safe: conditional update ensures only 1 admin can confirm simultaneously
   * Normal confirmation strictly requires WAITING_ADMIN_VERIFY.
   */
  static async confirmPaymentReceived(orderId: string, adminId: string) {
    return prisma.$transaction(async (tx: any) => {
      // Conditional update strictly on WAITING_ADMIN_VERIFY only
      const result = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "WAITING_ADMIN_VERIFY"
        },
        data: {
          status: "WAITING_PAYOUT",
          verifiedByAdminId: adminId,
          verifiedAt: new Date()
        }
      });

      if (result.count !== 1) {
        throw new Error(
          "Order đã được xử lý hoặc không ở trạng thái chờ duyệt (WAITING_ADMIN_VERIFY). Hãy dùng Manual Override nếu cần can thiệp ngoại lệ."
        );
      }

      // Record step 1: -> PAYMENT_CONFIRMED
      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "WAITING_ADMIN_VERIFY",
          toStatus: "PAYMENT_CONFIRMED",
          actorId: adminId,
          actorRole: "ADMIN",
          reason: "ADMIN_VERIFIED_INCOMING_MONEY",
          metadata: { verifiedAt: new Date().toISOString() }
        }
      });

      // Record step 2: PAYMENT_CONFIRMED -> WAITING_PAYOUT
      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "PAYMENT_CONFIRMED",
          toStatus: "WAITING_PAYOUT",
          actorId: adminId,
          actorRole: "ADMIN",
          reason: "READY_FOR_PAYOUT",
          metadata: { verifiedAt: new Date().toISOString() }
        }
      });

      // Write STRICT AuditLog in the SAME transaction (aborts if audit fails)
      await AuditService.logStrict(
        {
          actorId: adminId,
          actorRole: "ADMIN",
          action: "PAYMENT_VERIFIED",
          targetType: "ORDER",
          targetId: orderId,
          details: { verifiedAt: new Date().toISOString() }
        },
        tx
      );

      // Fetch the updated order inside the transaction
      return tx.order.findUnique({
        where: { id: orderId },
        include: { customer: true }
      });
    });
  }

  /**
   * Fix 4: Admin uploads payout proof bill (Atomic + Idempotent)
   * WAITING_PAYOUT -> PAYOUT_SENT
   */
  static async submitPayoutBill(
    orderId: string,
    adminId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ) {
    const evidence = await FileService.saveEvidenceFile(
      fileBuffer,
      fileName,
      "PAYOUT_BILL",
      mimeType,
      orderId
    );

    const updated = await prisma.$transaction(async (tx: any) => {
      const result = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "WAITING_PAYOUT"
        },
        data: {
          status: "PAYOUT_SENT",
          payoutBillFileId: evidence.id,
          payoutBillSha256: evidence.sha256,
          payoutByAdminId: adminId,
          payoutAt: new Date()
        }
      });

      if (result.count !== 1) {
        throw new Error("Order đã được xử lý hoặc trạng thái không còn hợp lệ.");
      }

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "WAITING_PAYOUT",
          toStatus: "PAYOUT_SENT",
          actorId: adminId,
          actorRole: "ADMIN",
          reason: "ADMIN_UPLOADED_PAYOUT_BILL",
          metadata: { fileId: evidence.id, sha256: evidence.sha256 }
        }
      });

      await AuditService.logStrict(
        {
          actorId: adminId,
          actorRole: "ADMIN",
          action: "PAYOUT_BILL_UPLOADED",
          targetType: "ORDER",
          targetId: orderId,
          details: { fileId: evidence.id, sha256: evidence.sha256 }
        },
        tx
      );

      return tx.order.findUnique({
        where: { id: orderId },
        include: { customer: true }
      });
    });

    LocalStorageService.archivePayoutBill(orderId, evidence.id).catch(() => {});
    LocalStorageService.archiveOrderMetadata(orderId).catch(() => {});

    return updated;
  }

  /**
   * Fix 4: Admin confirms completed payout (Atomic + Idempotent)
   * PAYOUT_SENT -> COMPLETED
   */
  static async completePayout(orderId: string, adminId: string) {
    const updated = await prisma.$transaction(async (tx: any) => {
      const result = await tx.order.updateMany({
        where: {
          id: orderId,
          status: "PAYOUT_SENT"
        },
        data: {
          status: "COMPLETED",
          completedAt: new Date()
        }
      });

      if (result.count !== 1) {
        throw new Error("Order đã được xử lý hoặc trạng thái không còn hợp lệ.");
      }

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "PAYOUT_SENT",
          toStatus: "COMPLETED",
          actorId: adminId,
          actorRole: "ADMIN",
          reason: "ADMIN_FINALIZED_ORDER",
          metadata: { completedAt: new Date().toISOString() }
        }
      });

      await AuditService.logStrict(
        {
          actorId: adminId,
          actorRole: "ADMIN",
          action: "ORDER_COMPLETED",
          targetType: "ORDER",
          targetId: orderId,
          details: { completedAt: new Date().toISOString() }
        },
        tx
      );

      return tx.order.findUnique({
        where: { id: orderId },
        include: { customer: true }
      });
    });

    // Trigger full order archival to local storage upon completion
    LocalStorageService.archiveFullOrder(orderId).catch((err) => {
      logger.warn({ err, orderId }, "Failed to archive full order on completion");
    });

    return updated;
  }

  /**
   * MANUAL FINANCIAL OVERRIDE
   * Only for SUPER_ADMIN or specifically permitted Admin.
   * Forces transition from abnormal/blocked states (e.g. MANUAL_REVIEW, SUSPICIOUS, PAYMENT_MISMATCH)
   * to a target state with mandatory reason, ⚠️ warning, and STRICT audit logging.
   */
  static async manualFinancialOverride({
    orderId,
    actorId,
    actorRole,
    targetStatus,
    reason
  }: {
    orderId: string;
    actorId: string;
    actorRole: string;
    targetStatus: string;
    reason: string;
  }) {
    if (!reason || reason.trim().length < 5) {
      throw new Error("Lý do can thiệp tài chính thủ công (MANUAL OVERRIDE) phải từ 5 ký tự trở lên.");
    }

    return prisma.$transaction(async (tx: any) => {
      const currentOrder = await tx.order.findUnique({
        where: { id: orderId }
      });

      if (!currentOrder) {
        throw new Error(`Không tìm thấy đơn hàng ${orderId}`);
      }

      const fromStatus = currentOrder.status;

      const updated = await tx.order.update({
        where: { id: orderId },
        data: {
          status: targetStatus,
          verifiedByAdminId: actorId,
          verifiedAt: new Date()
        }
      });

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus,
          toStatus: targetStatus,
          actorId,
          actorRole,
          reason: `⚠️ MANUAL OVERRIDE: ${reason.trim()}`,
          metadata: {
            manualOverride: true,
            actorId,
            actorRole,
            fromStatus,
            targetStatus,
            timestamp: new Date().toISOString()
          }
        }
      });

      await AuditService.logStrict(
        {
          actorId,
          actorRole,
          action: "FINANCIAL_MANUAL_OVERRIDE",
          targetType: "ORDER",
          targetId: orderId,
          details: {
            fromStatus,
            targetStatus,
            reason: reason.trim(),
            timestamp: new Date().toISOString()
          }
        },
        tx
      );

      return updated;
    });
  }

  /**
   * Cancel an active order safely
   */
  static async cancelOrder(orderId: string, actorId: string, actorRole: string, reason: string) {
    return prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Không tìm thấy đơn hàng");

      const cancelableStatuses = [
        "WAITING_PAYMENT",
        "CUSTOMER_SENT_BILL",
        "WAITING_ADMIN_VERIFY",
        "PAYMENT_MISMATCH",
        "MANUAL_REVIEW",
        "SUSPICIOUS"
      ];

      if (!cancelableStatuses.includes(order.status)) {
        throw new Error(`Đơn hàng đang ở trạng thái ${order.status}, không thể hủy.`);
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: "CANCELLED" }
      });

      if (result.count !== 1) {
        throw new Error("Order đã thay đổi trạng thái, vui lòng thử lại.");
      }

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: "CANCELLED",
          actorId,
          actorRole,
          reason,
          metadata: { canceledAt: new Date().toISOString() }
        }
      });

      await AuditService.log(
        {
          actorId,
          actorRole,
          action: "ORDER_CANCELLED",
          targetType: "ORDER",
          targetId: orderId,
          details: { reason }
        },
        tx
      );

      const updated = await tx.order.findUnique({ where: { id: orderId } });
      LocalStorageService.archiveFullOrder(orderId).catch(() => {});
      return updated;
    });
  }

  static async getOrder(id: string) {
    return prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        stateHistories: { orderBy: { createdAt: "asc" } },
        bills: { orderBy: { createdAt: "asc" } }
      }
    });
  }

  static async getOrdersByStatus(status: any) {
    return prisma.order.findMany({
      where: { status },
      include: { customer: true },
      orderBy: { createdAt: "desc" }
    });
  }

  static async getAllOrders(limit: number = 50) {
    return prisma.order.findMany({
      take: limit,
      include: { customer: true },
      orderBy: { createdAt: "desc" }
    });
  }

  static async getOrdersForCustomer(customerId: string, limit: number = 20, cursor?: string) {
    return prisma.order.findMany({
      where: { customerId },
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: "desc" },
      include: { customer: true }
    });
  }

  static async getOrdersAwaitingBill(customerId: string) {
    return prisma.order.findMany({
      where: {
        customerId,
        status: { in: ["WAITING_PAYMENT"] }
      },
      orderBy: { createdAt: "desc" }
    });
  }

  static async getLatestActiveOrderForCustomer(customerId: string) {
    return prisma.order.findFirst({
      where: {
        customerId,
        status: {
          in: [
            "WAITING_PAYMENT",
            "CUSTOMER_SENT_BILL",
            "WAITING_ADMIN_VERIFY",
            "PAYMENT_CONFIRMED",
            "WAITING_PAYOUT",
            "PAYOUT_SENT",
            "MANUAL_REVIEW",
            "SUSPICIOUS"
          ]
        }
      },
      include: { customer: true },
      orderBy: { createdAt: "desc" }
    });
  }
}
