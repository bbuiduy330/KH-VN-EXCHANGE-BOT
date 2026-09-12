import Decimal from "decimal.js";
import { prisma } from "../../database/client.js";
import { QuoteCalculation } from "../quotes/quote-service.js";
import { PaymentAccountService } from "../payment-accounts/account-service.js";
import { CustomerService } from "../customer/customer-service.js";
import { FileService } from "../files/file-service.js";
import { AiProvider } from "../ai/ai-provider.js";
import { AuditService } from "../audit/audit-service.js";
import { LocalStorageService } from "../storage/local-storage-service.js";
import {
  canCustomerCancel,
  canAdminCancel,
  isOrderPaymentReminderEligible,
  isOrderSafelyAutoCancellable,
  hasValidPaymentEvidence,
  CANCELLATION_SOURCES
} from "./order-safety.js";
import { logger } from "../../shared/logger.js";

export class OrderService {
  // -------------------------------------------------------------------------
  // Authoritative safety rules (single source of truth — requirement L).
  // Handlers/scheduler MUST use these instead of duplicating state checks.
  // -------------------------------------------------------------------------
  static canCustomerCancel(order: any) {
    return canCustomerCancel(order as any);
  }

  /**
   * Dynamic QR V1 — authoritative memo accessor.
   * Uses the FROZEN Order.transferMemo when present; legacy/null rows fall
   * back to the deterministic generator (legacy compatibility only — new
   * Orders always have the memo persisted).
   */
  static async getOrderTransferMemo(order: {
    id: string;
    transferMemo?: string | null;
    customer?: { username?: string | null; telegramId?: string | null } | null;
  }): Promise<string> {
    const stored = String(order.transferMemo || "").trim();
    if (stored) return stored;
    const { generateTransferMemo } = await import("./transfer-memo.js");
    const { SystemConfigService } = await import("../system-config/system-config-service.js");
    return generateTransferMemo(SystemConfigService.getTransferMemoTemplate(), {
      orderId: order.id,
      username: order.customer?.username ?? null,
      telegramId: order.customer?.telegramId ?? null
    });
  }
  static canAdminCancel(order: any) {
    return canAdminCancel(order as any);
  }
  static isOrderPaymentReminderEligible(order: any) {
    return isOrderPaymentReminderEligible(order as any);
  }
  static isOrderSafelyAutoCancellable(order: any) {
    return isOrderSafelyAutoCancellable(order as any);
  }
  static hasValidPaymentEvidence(order: any) {
    return hasValidPaymentEvidence(order as any);
  }
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

    // 2. Snapshot customer payout bank for target currency.
    // UX: the receiving bank account is NOT required to create the order.
    // It is collected later (menu button / chat) and becomes mandatory only
    // before payout execution (enforced by the admin payout-complete guard).
    const payoutBank = await CustomerService.getPayoutBank(
      customerId,
      quote.targetCurrency
    );

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
      qrSha256: receivingAccount.qrSha256,
      // Dynamic payment QR V1 — FROZEN QR metadata: the Order's QR can always
      // be reproduced from the snapshot even if Admin later edits the account.
      qrProvider: receivingAccount.qrProvider ?? null,
      bankBin: receivingAccount.bankBin ?? null,
      khqrMode: receivingAccount.khqrMode ?? null,
      khqrBakongAccountId: receivingAccount.khqrBakongAccountId ?? null,
      khqrMerchantName: receivingAccount.khqrMerchantName ?? null,
      khqrMerchantCity: receivingAccount.khqrMerchantCity ?? null,
      khqrMerchantId: receivingAccount.khqrMerchantId ?? null,
      khqrAcquiringBank: receivingAccount.khqrAcquiringBank ?? null
    };

    const payoutBankSnapshot = payoutBank
      ? {
          currency: payoutBank.currency,
          bankName: payoutBank.bankName,
          accountName: payoutBank.accountName,
          accountNumber: payoutBank.accountNumber
        }
      : null;

    // T — immutable Partner attribution snapshot at Order creation: taken from
    // the customer's CURRENT assignment once, so later corrections never
    // rewrite historical attribution.
    const customerRow = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { partnerId: true, username: true, telegramId: true }
    });

    // Dynamic QR V1 — FROZEN transfer memo: generated ONCE at Order creation
    // from the THEN-CURRENT template. Later SystemSetting edits never rewrite
    // an existing Order's payment instructions (legacy-null fallback below).
    const { generateTransferMemo } = await import("./transfer-memo.js");
    const { SystemConfigService } = await import("../system-config/system-config-service.js");
    const transferMemo = generateTransferMemo(SystemConfigService.getTransferMemoTemplate(), {
      orderId,
      username: customerRow?.username ?? null,
      telegramId: customerRow?.telegramId ?? null
    });

    const order = await prisma.$transaction(async (tx: any) => {
      const created = await tx.order.create({
        data: {
          id: orderId,
          customerId,
          partnerId: customerRow?.partnerId ?? null,
          transferMemo,
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

    // FINANCIAL SAFETY (audit fix): a late bill may ONLY be attached to an
    // order owned by the uploading customer, and only through an EXPLICITLY
    // bound target (the customer:bill:attach selection callback). There is no
    // "latest CANCELLED order" guessing anywhere — random photos can never be
    // attached to an arbitrary old cancelled order.
    const actorCustomer = await prisma.customer.findUnique({
      where: { telegramId: actorTelegramId || "" }
    });
    if (!actorCustomer || actorCustomer.id !== order.customerId) {
      throw new Error("Không tìm thấy đơn hàng");
    }

    // Late bill after auto-cancel (requirement E): NEVER automatically reopen,
    // confirm payment, or create a payout. Preserve the original evidence,
    // record an audit trail, and let Admin/CSKH review manually. The order
    // status stays CANCELLED — the customer is told staff will review.
    if (order.status === "CANCELLED") {
      const evidence = await FileService.saveEvidenceFile(
        fileBuffer,
        fileName,
        "CUSTOMER_BILL",
        mimeType,
        orderId
      );
      await prisma.orderBillEvidence.create({
        data: {
          orderId,
          fileId: evidence.id,
          filePath: evidence.filePath,
          sha256: evidence.sha256,
          extracted: {},
          uploadedBy: actorTelegramId || order.customerId
        }
      });
      await prisma.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "CANCELLED",
          toStatus: "CANCELLED",
          actorId: actorTelegramId || order.customerId,
          actorRole: "CUSTOMER",
          reason: "LATE_BILL_FOR_CANCELLED_ORDER",
          metadata: { fileId: evidence.id, sha256: evidence.sha256 }
        }
      });
      await AuditService.log({
        actorId: actorTelegramId || order.customerId,
        actorRole: "CUSTOMER",
        action: "BILL_RECEIVED_AFTER_CANCEL",
        targetType: "ORDER",
        targetId: orderId,
        details: { fileId: evidence.id, sha256: evidence.sha256, requiresManualReview: true }
      });
      return { status: "LATE_BILL_CANCELLED", orderId };
    }

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
    // HARD GATE: payout execution is blocked unless the order is truly
    // payout-ready (WAITING_PAYOUT + valid customer-confirmed destination).
    // This protects both the ops-center flow and the legacy /payout command.
    const current = await prisma.order.findUnique({ where: { id: orderId } });
    if (!current) throw new Error("Không tìm thấy đơn hàng.");
    if (!OrderService.isPayoutReady(current as any)) {
      throw new Error(
        "Chưa thể chi trả: đơn chưa có tài khoản/QR nhận tiền đã xác nhận. Vui lòng yêu cầu khách gửi tài khoản nhận trước."
      );
    }

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

  // -------------------------------------------------------------------------
  // Customer payout destination (per-Order snapshot; no new OrderStatus)
  // -------------------------------------------------------------------------

  /**
   * An order is "payout-ready" only when:
   * - status === WAITING_PAYOUT (incoming payment already verified), AND
   * - a confirmed payout destination snapshot exists.
   * Orders in WAITING_PAYOUT without a destination are "awaiting customer
   * payout info" — never presented as ready for payout.
   */
  static isPayoutReady(order: { status: string; payoutBankSnapshot?: any }): boolean {
    if (!order) return false;
    if (order.status !== "WAITING_PAYOUT") return false;
    const snap = order.payoutBankSnapshot as any;
    if (!snap) return false;
    if (snap.type === "qr") return Boolean(snap.qrFileId || snap.qrFilePath);
    return Boolean(snap.bankName && snap.accountNumber && snap.accountName);
  }

  /**
   * Attach a customer-confirmed payout destination to a specific Order.
   * destination types:
   *  - text: { type:"text", currency, bankName, accountName, accountNumber }
   *  - qr:   { type:"qr", qrFileId, qrFilePath, qrSha256, mimeType }
   * Only the owner customer on a WAITING_PAYOUT order can set it (state-aware,
   * no global session). Never mutates historical orders.
   */
  static async attachPayoutDestination(
    orderId: string,
    customerId: string,
    destination: { type: "text" | "qr"; [k: string]: any }
  ) {
    return prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Không tìm thấy đơn hàng.");
      if (order.customerId !== customerId) {
        throw new Error("Đơn hàng không thuộc về tài khoản của bạn.");
      }
      if (order.status !== "WAITING_PAYOUT") {
        throw new Error(`Không thể cập nhật tài khoản nhận ở trạng thái ${order.status}.`);
      }
      if (!destination || !destination.type) {
        throw new Error("Thiếu thông tin tài khoản nhận.");
      }

      const snapshot =
        destination.type === "qr"
          ? {
              type: "qr",
              qrFileId: destination.qrFileId || null,
              qrFilePath: destination.qrFilePath || null,
              qrSha256: destination.qrSha256 || null,
              mimeType: destination.mimeType || "image/png",
              confirmedByCustomer: true,
              confirmedAt: new Date().toISOString()
            }
          : {
              type: "text",
              currency: String(destination.currency || "VND").toUpperCase(),
              bankName: String(destination.bankName || "").trim(),
              accountName: String(destination.accountName || "").trim(),
              accountNumber: String(destination.accountNumber || "").trim(),
              confirmedByCustomer: true,
              confirmedAt: new Date().toISOString()
            };

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { payoutBankSnapshot: snapshot }
      });

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: order.status,
          actorId: customerId,
          actorRole: "CUSTOMER",
          reason: "PAYOUT_DESTINATION_CONFIRMED",
          metadata: { type: snapshot.type }
        }
      });

      await AuditService.logStrict(
        {
          actorId: customerId,
          actorRole: "CUSTOMER",
          action: "PAYOUT_DESTINATION_CONFIRMED",
          targetType: "ORDER",
          targetId: orderId,
          details: { type: snapshot.type, orderId }
        },
        tx
      );

      return tx.order.findUnique({ where: { id: orderId }, include: { customer: true } });
    });
  }

  /** Most recent WAITING_PAYOUT order for a customer (destination binding target). */
  static async getLatestEligiblePayoutOrder(customerId: string) {
    return prisma.order.findFirst({
      where: { customerId, status: "WAITING_PAYOUT" },
      orderBy: { createdAt: "desc" },
      include: { customer: true }
    });
  }

  /**
   * Recent unique payout destinations from THIS customer's own COMPLETED
   * orders (snapshots only — no new SavedBankAccount table). Never exposes
   * another customer's data.
   */
  static async getRecentPayoutDestinations(customerId: string, limit: number = 5) {
    const orders = await prisma.order.findMany({
      where: { customerId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      take: 50
    });

    const seen = new Set<string>();
    const result: any[] = [];
    for (const o of orders) {
      const snap = (o.payoutBankSnapshot || null) as any;
      if (!snap) continue;
      const key =
        snap.type === "qr"
          ? `qr:${snap.qrSha256 || snap.qrFilePath || ""}`
          : `text:${String(snap.bankName || "").toUpperCase()}:${String(snap.accountNumber || "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ...snap });
      if (result.length >= limit) break;
    }
    return result;
  }

  /**
   * Fix 4: Admin confirms completed payout (Atomic + Idempotent)
   * PAYOUT_SENT -> COMPLETED
   */
  static async completePayout(orderId: string, adminId: string) {
    const { PartnerService } = await import("../partner/partner-service.js");
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

      // 1 — in-transaction ATTEMPT (fail-safe): the Order COMPLETED transition
      // and the commission attempt share the transaction, but commission
      // errors are swallowed by onOrderCompleted, so the Order still commits
      // successfully even if affiliate accounting fails. The authoritative
      // guarantee is reconcileMissingCommissions() (eventual consistency).
      await PartnerService.onOrderCompleted(orderId, tx).catch(() => {});

      return tx.order.findUnique({
        where: { id: orderId },
        include: { customer: true }
      });
    });

    // Trigger full order archival to local storage upon completion
    LocalStorageService.archiveFullOrder(orderId).catch((err) => {
      logger.warn({ err, orderId }, "Failed to archive full order on completion");
    });

    // Approach B backstop: also run the idempotent reconciliation for THIS
    // order (covers any swallowed commission error above). No-op when the
    // same-transaction creation already succeeded.
    await PartnerService.onOrderCompleted(orderId).catch(() => {});

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
   * Cancel an active order safely (authoritative, centralized rules).
   *
   * SAFETY (requirement A/B/L):
   * - Reloads the authoritative order inside the transaction.
   * - CUSTOMER cancellations are gated by the centralized canCustomerCancel
   *   rules (unpaid + no evidence only).
   * - ADMIN cancellations are gated by canAdminCancel (confirmed-money states
   *   are never simple-cancelled).
   * - Idempotent: cancelling an already-CANCELLED order is a no-op success.
   * - Conditional updateMany prevents concurrent double-cancellation.
   */
  static async cancelOrder(
    orderId: string,
    actorId: string,
    actorRole: string,
    reason: string,
    options?: { source?: string; metadata?: Record<string, any> }
  ) {
    return prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Không tìm thấy đơn hàng");

      // Idempotency: already cancelled → return as-is (no state change).
      if (order.status === "CANCELLED") {
        return order;
      }

      if (actorRole === "CUSTOMER") {
        const decision = canCustomerCancel(order);
        if (!decision.allowed) {
          if (decision.code === "BILL_EXISTS") {
            throw new Error("BILL_EXISTS");
          }
          throw new Error(`Đơn hàng đang ở trạng thái ${order.status}, không thể hủy.`);
        }
      } else {
        // ADMIN / SYSTEM path — same centralized rules as the scheduler.
        const decision = canAdminCancel(order);
        if (!decision.allowed) {
          throw new Error(
            decision.code === "PAYMENT_CONFIRMED"
              ? "Đơn đã xác nhận tiền vào hoặc đã giải ngân — không thể hủy trực tiếp. Dùng xem xét thủ công (manual override)."
              : `Đơn hàng đang ở trạng thái ${order.status}, không thể hủy.`
          );
        }
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: { status: "CANCELLED" }
      });

      if (result.count !== 1) {
        throw new Error("Order đã thay đổi trạng thái, vui lòng thử lại.");
      }

      const source = options?.source || (actorRole === "CUSTOMER" ? CANCELLATION_SOURCES.CUSTOMER : CANCELLATION_SOURCES.ADMIN);

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: order.status,
          toStatus: "CANCELLED",
          actorId,
          actorRole,
          reason,
          metadata: {
            canceledAt: new Date().toISOString(),
            source,
            ...(options?.metadata || {})
          }
        }
      });

      await AuditService.log(
        {
          actorId,
          actorRole,
          action: "ORDER_CANCELLED",
          targetType: "ORDER",
          targetId: orderId,
          details: { reason, source }
        },
        tx
      );

      const updated = await tx.order.findUnique({ where: { id: orderId } });
      LocalStorageService.archiveFullOrder(orderId).catch(() => {});
      return updated;
    });
  }

  /**
   * Scheduler auto-cancel after payment timeout (requirement D).
   * Atomic + idempotent: re-validates against the authoritative row inside the
   * transaction and uses a conditional update so two scheduler runs can never
   * cancel the same order twice. Returns { cancelled:false } when the order is
   * no longer safely auto-cancellable (evidence arrived, payment confirmed,
   * already cancelled, etc.).
   */
  static async cancelOrderForPaymentTimeout(orderId: string, actorId: string = "SYSTEM_SCHEDULER") {
    return prisma.$transaction(async (tx: any) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) return { cancelled: false, reason: "NOT_FOUND" as const };

      if (!isOrderSafelyAutoCancellable(order)) {
        return { cancelled: false, reason: "NOT_ELIGIBLE" as const, status: order.status };
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, status: "WAITING_PAYMENT" },
        data: { status: "CANCELLED" }
      });
      if (result.count !== 1) {
        // Lost the race — another scheduler run / handler mutated it first.
        return { cancelled: false, reason: "RACE_LOST" as const };
      }

      await tx.orderStateHistory.create({
        data: {
          orderId,
          fromStatus: "WAITING_PAYMENT",
          toStatus: "CANCELLED",
          actorId,
          actorRole: "SYSTEM",
          reason: CANCELLATION_SOURCES.AUTO_TIMEOUT,
          metadata: {
            canceledAt: new Date().toISOString(),
            source: CANCELLATION_SOURCES.AUTO_TIMEOUT
          }
        }
      });

      await AuditService.logStrict(
        {
          actorId,
          actorRole: "SYSTEM",
          action: "ORDER_AUTO_CANCELLED_PAYMENT_TIMEOUT",
          targetType: "ORDER",
          targetId: orderId,
          details: {
            reason: "PAYMENT_TIMEOUT",
            source: CANCELLATION_SOURCES.AUTO_TIMEOUT
          }
        },
        tx
      );

      const updated = await tx.order.findUnique({ where: { id: orderId } });
      LocalStorageService.archiveFullOrder(orderId).catch(() => {});
      return { cancelled: true as const, order: updated };
    });
  }

  /**
   * Number of payment reminders already sent for an order, derived from the
   * persisted AuditLog (authoritative). This survives container restarts and
   * prevents duplicate reminder spam after restart (requirement K) — no
   * in-memory counter, no schema change.
   */
  static async countPaymentReminders(orderId: string): Promise<number> {
    try {
      // findMany + length instead of count(): works identically on the real
      // database and on the in-memory test mock (which has no count()).
      const rows = await prisma.auditLog.findMany({
        where: { action: "PAYMENT_REMINDER_SENT", targetType: "ORDER", targetId: orderId }
      });
      return Array.isArray(rows) ? rows.length : 0;
    } catch (err: any) {
      logger.warn({ err: err?.message, orderId }, "countPaymentReminders failed; treating as 0");
      return 0;
    }
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
    // BILL INTAKE eligibility = EXACTLY the statuses submitCustomerBill()
    // accepts (WAITING_PAYMENT first bill + CUSTOMER_SENT_BILL /
    // WAITING_ADMIN_VERIFY / MANUAL_REVIEW re-uploads). If this list ever
    // shrinks to WAITING_PAYMENT alone, a customer's SECOND bill photo (order
    // already in verify) silently falls through to the HUMAN relay/"bill.none"
    // dead end and Admin never receives it — that was the observed runtime
    // regression. Newest first: the just-paid Order (whose QR the customer
    // scanned) is unambiguous.
    return prisma.order.findMany({
      where: {
        customerId,
        status: { in: ["WAITING_PAYMENT", "CUSTOMER_SENT_BILL", "WAITING_ADMIN_VERIFY", "MANUAL_REVIEW"] }
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
