import { google } from "googleapis";
import { Readable } from "stream";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { prisma } from "../../database/client.js";
import { FileService } from "../files/file-service.js";
import { ConversationService } from "../conversation/conversation-service.js";
import { sendToAdminNotificationChat } from "../../bot/notifications.js";

export function sanitizeDriveError(err: any): string {
  if (!err) return "Unknown error";
  let message = typeof err === "string" ? err : err.message || JSON.stringify(err);

  const errCode = err?.code || err?.response?.data?.error;

  if (errCode === "invalid_grant" || message.includes("invalid_grant")) {
    return "OAuth error: invalid_grant (refresh token may be invalid, revoked, or expired)";
  }
  if (errCode === "invalid_client" || message.includes("invalid_client")) {
    return "OAuth error: invalid_client (client ID or client secret mismatch)";
  }
  if (errCode === "unauthorized_client" || message.includes("unauthorized_client")) {
    return "OAuth error: unauthorized_client (OAuth client not authorized for this scope)";
  }
  if (errCode === "insufficient_scope" || message.includes("insufficient_scope")) {
    return "OAuth error: insufficient_scope (token does not have required Google Drive permissions)";
  }

  message = message
    .replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, "Bearer [REDACTED]")
    .replace(/ya29\.[A-Za-z0-9-_.]+/gi, "[REDACTED_ACCESS_TOKEN]")
    .replace(/1\/\/[A-Za-z0-9-_.]+/gi, "[REDACTED_REFRESH_TOKEN]")
    .replace(/client_secret=[^& \n\r"']+/gi, "client_secret=[REDACTED]")
    .replace(/refresh_token=[^& \n\r"']+/gi, "refresh_token=[REDACTED]")
    .replace(/code=[^& \n\r"']+/gi, "code=[REDACTED]");

  return message.slice(0, 400);
}

export interface OrderFolderTree {
  orderFolderId: string;
  subFolders: {
    payment_instruction: string;
    customer_bill: string;
    payout_bill: string;
    voice: string;
    images: string;
    documents: string;
  };
}

export class GoogleDriveService {
  private static driveClient: any = null;
  private static oauth2Client: any = null;

  static isConfigured(): boolean {
    return Boolean(
      env.GOOGLE_DRIVE_CLIENT_ID?.trim() &&
      env.GOOGLE_DRIVE_CLIENT_SECRET?.trim() &&
      env.GOOGLE_DRIVE_REFRESH_TOKEN?.trim() &&
      env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim()
    );
  }

  static isMockAllowed(): boolean {
    if (env.NODE_ENV === "test") return true;
    if (env.NODE_ENV === "development" && env.GOOGLE_DRIVE_MOCK === true) return true;
    return false;
  }

  static setDriveClientForTesting(client: any) {
    this.driveClient = client;
  }

  static resetClientForTesting() {
    this.driveClient = null;
    this.oauth2Client = null;
  }

  static getOAuth2Client() {
    if (this.oauth2Client) return this.oauth2Client;

    if (!env.GOOGLE_DRIVE_CLIENT_ID || !env.GOOGLE_DRIVE_CLIENT_SECRET || !env.GOOGLE_DRIVE_REFRESH_TOKEN) {
      return null;
    }

    try {
      const oauth2 = new google.auth.OAuth2(
        env.GOOGLE_DRIVE_CLIENT_ID,
        env.GOOGLE_DRIVE_CLIENT_SECRET
      );

      oauth2.setCredentials({
        refresh_token: env.GOOGLE_DRIVE_REFRESH_TOKEN
      });

      this.oauth2Client = oauth2;
      return this.oauth2Client;
    } catch (err: any) {
      logger.error({ err: sanitizeDriveError(err) }, "Failed to initialize Google Drive OAuth2 client");
      return null;
    }
  }

  static getDriveClient() {
    if (this.driveClient) return this.driveClient;

    const oauth2 = this.getOAuth2Client();
    if (!oauth2) {
      if (!this.isConfigured()) {
        logger.warn("Google Drive OAuth2 credentials not configured. Drive operations will be mocked or rejected based on environment.");
      }
      return null;
    }

    try {
      this.driveClient = google.drive({
        version: "v3",
        auth: oauth2
      });
      return this.driveClient;
    } catch (err: any) {
      logger.error({ err: sanitizeDriveError(err) }, "Failed to initialize Google Drive v3 client");
      return null;
    }
  }

  static getClient() {
    return this.getDriveClient();
  }

  static async findOrCreateFolder(folderName: string, parentFolderId?: string): Promise<string> {
    const drive = this.getDriveClient();
    if (!drive) {
      if (this.isMockAllowed()) {
        return `mock-folder-${folderName}-${Date.now()}`;
      }
      throw new Error(
        "Google Drive is not configured. Missing required OAuth2 credentials in production."
      );
    }

    const parent = parentFolderId || env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    const query = parent
      ? `'${parent}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      : `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

    try {
      const res = await drive.files.list({
        q: query,
        fields: "files(id, name)",
        spaces: "drive"
      });

      if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id!;
      }

      const fileMetadata: any = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder"
      };

      if (parent) {
        fileMetadata.parents = [parent];
      }

      const folder = await drive.files.create({
        requestBody: fileMetadata,
        fields: "id"
      });

      return folder.data.id!;
    } catch (err: any) {
      const sanitized = sanitizeDriveError(err);
      logger.error({ err: sanitized, folderName, parent }, "Error in findOrCreateFolder");
      throw new Error(`Google Drive findOrCreateFolder failed: ${sanitized}`);
    }
  }

  /**
   * For original evidence: never overwrite historical originals.
   * If existing file found, reuse its id.
   */
  static async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    parentFolderId?: string
  ): Promise<string | null> {
    const drive = this.getDriveClient();
    if (!drive) {
      if (this.isMockAllowed()) {
        logger.info({ fileName }, "Mocked Google Drive upload (test/dev mock mode)");
        return `mock-drive-file-${Date.now()}`;
      }
      throw new Error(
        "Google Drive is not configured. Missing required OAuth2 credentials in production."
      );
    }

    const folderId = parentFolderId || env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

    try {
      if (folderId) {
        const existing = await drive.files.list({
          q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
          fields: "files(id, name)",
          spaces: "drive"
        });

        if (existing.data.files && existing.data.files.length > 0) {
          logger.info({ fileName, id: existing.data.files[0].id }, "File already exists in Drive folder, preserving original");
          return existing.data.files[0].id!;
        }
      }

      const response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: folderId ? [folderId] : undefined
        },
        media: {
          mimeType,
          body: Readable.from(fileBuffer)
        },
        fields: "id"
      });

      return response.data.id || null;
    } catch (err: any) {
      const sanitized = sanitizeDriveError(err);
      logger.error({ err: sanitized, fileName }, "Google Drive upload failed");
      throw new Error(`Google Drive upload failed: ${sanitized}`);
    }
  }

  /**
   * Fix 13: For generated archive files (order.json, customer.json, audit.json, conversation.txt, etc.)
   * Idempotently update content if file already exists in folder, avoiding duplicates on retry.
   */
  static async uploadOrUpdateFile(
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    parentFolderId?: string
  ): Promise<string | null> {
    const drive = this.getDriveClient();
    if (!drive) {
      if (this.isMockAllowed()) {
        logger.info({ fileName }, "Mocked Google Drive upload/update (test/dev mock mode)");
        return `mock-drive-file-${Date.now()}`;
      }
      throw new Error(
        "Google Drive is not configured. Missing required OAuth2 credentials in production."
      );
    }

    const folderId = parentFolderId || env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

    try {
      if (folderId) {
        const existing = await drive.files.list({
          q: `'${folderId}' in parents and name = '${fileName}' and trashed = false`,
          fields: "files(id, name)",
          spaces: "drive"
        });

        if (existing.data.files && existing.data.files.length > 0) {
          const fileId = existing.data.files[0].id!;
          await drive.files.update({
            fileId,
            media: {
              mimeType,
              body: Readable.from(fileBuffer)
            }
          });
          logger.info({ fileName, fileId }, "Drive file updated idempotently");
          return fileId;
        }
      }

      const response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: folderId ? [folderId] : undefined
        },
        media: {
          mimeType,
          body: Readable.from(fileBuffer)
        },
        fields: "id"
      });

      return response.data.id || null;
    } catch (err: any) {
      const sanitized = sanitizeDriveError(err);
      logger.error({ err: sanitized, fileName }, "Google Drive upload/update failed");
      throw new Error(`Google Drive upload/update failed: ${sanitized}`);
    }
  }

  static async uploadJson(data: any, fileName: string, parentFolderId?: string): Promise<string | null> {
    const jsonStr = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonStr, "utf-8");
    return this.uploadOrUpdateFile(buffer, fileName, "application/json", parentFolderId);
  }

  static async uploadText(text: string, fileName: string, parentFolderId?: string): Promise<string | null> {
    const buffer = Buffer.from(text, "utf-8");
    return this.uploadOrUpdateFile(buffer, fileName, "text/plain; charset=utf-8", parentFolderId);
  }

  /**
   * Constructs the full folder hierarchy for an order:
   * ROOT / YYYY / MM / ORDER-ID /
   * and subfolders: payment_instruction, customer_bill, payout_bill, voice, images, documents
   */
  static async getOrderFolderTree(order: any): Promise<OrderFolderTree> {
    const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
    const year = createdAt.getFullYear().toString();
    const month = String(createdAt.getMonth() + 1).padStart(2, "0");

    const rootId = env.GOOGLE_DRIVE_ROOT_FOLDER_ID || undefined;

    const yearFolderId = await this.findOrCreateFolder(year, rootId);
    const monthFolderId = await this.findOrCreateFolder(month, yearFolderId);
    const orderFolderId = await this.findOrCreateFolder(order.id, monthFolderId);

    const subFolders = {
      payment_instruction: await this.findOrCreateFolder("payment_instruction", orderFolderId),
      customer_bill: await this.findOrCreateFolder("customer_bill", orderFolderId),
      payout_bill: await this.findOrCreateFolder("payout_bill", orderFolderId),
      voice: await this.findOrCreateFolder("voice", orderFolderId),
      images: await this.findOrCreateFolder("images", orderFolderId),
      documents: await this.findOrCreateFolder("documents", orderFolderId)
    };

    return { orderFolderId, subFolders };
  }
}

export class DriveArchiveService {
  /**
   * Fix 5 & 12: Archives order metadata: order.json and customer.json
   * Correctly queries Customer by ID or relation, using valid Prisma fields.
   */
  static async archiveOrderMetadata(orderId: string): Promise<string | null> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tree = await GoogleDriveService.getOrderFolderTree(order);

    // 1. order.json
    const orderJsonData = {
      orderId: order.id,
      customerId: order.customerId,
      sourceCurrency: order.sourceCurrency,
      targetCurrency: order.targetCurrency,
      sourceAmount: order.sourceAmount.toString(),
      targetAmount: order.targetAmount.toString(),
      rate: order.rate.toString(),
      fee: order.fee.toString(),
      feeCurrency: order.feeCurrency,
      status: order.status,
      receivingAccountSnapshot: order.receivingAccountSnapshot,
      payoutBankSnapshot: order.payoutBankSnapshot,
      aiExtractedData: order.aiExtractedData,
      customerBillSha256: order.customerBillSha256,
      payoutBillSha256: order.payoutBillSha256,
      verifiedByAdminId: order.verifiedByAdminId,
      verifiedAt: order.verifiedAt,
      payoutByAdminId: order.payoutByAdminId,
      payoutAt: order.payoutAt,
      completedAt: order.completedAt,
      createdAt: order.createdAt,
      archivedAt: new Date().toISOString()
    };
    const orderFileId = await GoogleDriveService.uploadJson(orderJsonData, "order.json", tree.orderFolderId);

    // 2. Fix 5: customer.json with correct Customer relationship and fields
    const customer = order.customer || (await prisma.customer.findUnique({ where: { id: order.customerId } }));
    if (customer) {
      await GoogleDriveService.uploadJson(
        {
          customerId: customer.id,
          telegramId: customer.telegramId,
          username: customer.username ?? null,
          fullName: customer.fullName ?? null,
          phone: customer.phone ?? null,
          language: customer.language,
          createdAt: customer.createdAt,
          archivedAt: new Date().toISOString()
        },
        "customer.json",
        tree.orderFolderId
      );
    }

    // Save order folder ID in order record
    await prisma.order.update({
      where: { id: orderId },
      data: { driveFolderId: tree.orderFolderId }
    });

    return orderFileId;
  }

  /**
   * Fix 7: Archives payment QR instruction file preserving historical version
   */
  static async archivePaymentInstructionQr(orderId: string): Promise<string | null> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;

    const snapshot = order.receivingAccountSnapshot as any;
    if (!snapshot || !snapshot.qrFilePath) return null;

    const fileBuffer = await FileService.getFile(snapshot.qrFilePath);
    if (!fileBuffer) return null;

    const tree = await GoogleDriveService.getOrderFolderTree(order);
    const version = snapshot.qrVersion || 1;
    const fileName = `payment_qr_v${version}_${snapshot.currency || "GENERIC"}.jpg`;

    return GoogleDriveService.uploadFile(
      fileBuffer,
      fileName,
      "image/jpeg",
      tree.subFolders.payment_instruction
    );
  }

  /**
   * Archives customer payment bill evidence file
   */
  static async archiveCustomerBill(orderId: string): Promise<string | null> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || !order.customerBillFileId) return null;

    const evidence = await prisma.fileEvidence.findUnique({ where: { id: order.customerBillFileId } });
    if (!evidence) return null;

    const fileBuffer = await FileService.getFile(evidence.filePath);
    if (!fileBuffer) return null;

    const tree = await GoogleDriveService.getOrderFolderTree(order);
    const fileName = `customer_bill_${order.id}_${evidence.fileName}`;

    const driveFileId = await GoogleDriveService.uploadFile(
      fileBuffer,
      fileName,
      evidence.mimeType,
      tree.subFolders.customer_bill
    );

    if (driveFileId) {
      await prisma.fileEvidence.update({
        where: { id: evidence.id },
        data: { driveFileId, driveSyncStatus: "SYNCED" }
      });
    }

    return driveFileId;
  }

  /**
   * Archives payout receipt bill evidence file
   */
  static async archivePayoutBill(orderId: string): Promise<string | null> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || !order.payoutBillFileId) return null;

    const evidence = await prisma.fileEvidence.findUnique({ where: { id: order.payoutBillFileId } });
    if (!evidence) return null;

    const fileBuffer = await FileService.getFile(evidence.filePath);
    if (!fileBuffer) return null;

    const tree = await GoogleDriveService.getOrderFolderTree(order);
    const fileName = `payout_bill_${order.id}_${evidence.fileName}`;

    const driveFileId = await GoogleDriveService.uploadFile(
      fileBuffer,
      fileName,
      evidence.mimeType,
      tree.subFolders.payout_bill
    );

    if (driveFileId) {
      await prisma.fileEvidence.update({
        where: { id: evidence.id },
        data: { driveFileId, driveSyncStatus: "SYNCED" }
      });
    }

    return driveFileId;
  }

  /**
   * Formats conversation into conversation.json and conversation.txt
   */
  static async archiveConversation(orderId: string): Promise<{ jsonId: string | null; txtId: string | null }> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });
    if (!order) return { jsonId: null, txtId: null };

    const telegramId = order.customer?.telegramId || order.customerId;
    const history = await ConversationService.getHistory(telegramId, 200);
    const tree = await GoogleDriveService.getOrderFolderTree(order);

    // Format conversation.txt
    const txtBlocks: string[] = [];

    const allEvents: Array<{
      type: "MESSAGE" | "NOTE";
      date: Date;
      senderTag: string;
      content: string;
    }> = [];

    for (const m of history.messages) {
      const senderTag = m.senderType === "CUSTOMER"
        ? "CUSTOMER"
        : m.senderType === "AI"
        ? "AI"
        : m.senderType === "CSKH"
        ? `CSKH ${m.senderId || ""}`.trim()
        : "SYSTEM";

      allEvents.push({
        type: "MESSAGE",
        date: new Date(m.createdAt),
        senderTag,
        content: m.content + (m.translatedContent ? `\n[Bản dịch: ${m.translatedContent}]` : "")
      });
    }

    for (const n of history.notes) {
      allEvents.push({
        type: "NOTE",
        date: new Date(n.createdAt),
        senderTag: `INTERNAL NOTE (Bởi ${n.authorId})`,
        content: n.content
      });
    }

    allEvents.sort((a, b) => a.date.getTime() - b.date.getTime());

    for (const ev of allEvents) {
      const pad = (n: number) => String(n).padStart(2, "0");
      const d = ev.date;
      const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      txtBlocks.push(`[${timeStr}]\n${ev.senderTag}:\n${ev.content}`);
    }

    const fullText = txtBlocks.join("\n\n");

    const txtId = await GoogleDriveService.uploadText(fullText, "conversation.txt", tree.orderFolderId);

    const jsonId = await GoogleDriveService.uploadJson(
      {
        orderId,
        customerId: order.customerId,
        messages: history.messages,
        internalNotes: history.notes,
        mode: history.mode,
        claimedById: history.claimedById,
        exportedAt: new Date().toISOString()
      },
      "conversation.json",
      tree.orderFolderId
    );

    return { jsonId, txtId };
  }

  /**
   * Archives audit logs related to this order: audit.json
   */
  static async archiveAudit(orderId: string): Promise<string | null> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;

    const logs = await prisma.auditLog.findMany({
      where: { targetId: orderId },
      orderBy: { createdAt: "asc" }
    });

    const tree = await GoogleDriveService.getOrderFolderTree(order);

    return GoogleDriveService.uploadJson(
      {
        orderId,
        totalEvents: logs.length,
        logs,
        archivedAt: new Date().toISOString()
      },
      "audit.json",
      tree.orderFolderId
    );
  }

  // --- JOB QUEUE & RETRY WORKER ---

  static async enqueueSyncJob(orderId: string, jobType: string, fileEvidenceId?: string) {
    try {
      const existing = await prisma.driveSyncJob.findFirst({
        where: {
          orderId,
          jobType,
          status: { in: ["PENDING", "PROCESSING"] }
        }
      });
      if (existing) return existing;

      return await prisma.driveSyncJob.create({
        data: {
          orderId,
          jobType,
          fileEvidenceId,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          nextRetryAt: new Date()
        }
      });
    } catch (err: any) {
      logger.warn({ err, orderId, jobType }, "Failed to enqueue drive sync job, continuing financial flow");
      return null;
    }
  }

  static async processJob(job: any): Promise<boolean> {
    try {
      await prisma.driveSyncJob.update({
        where: { id: job.id },
        data: { status: "PROCESSING" }
      });

      let driveFileId: string | null = null;

      switch (job.jobType) {
        case "ORDER_METADATA":
          driveFileId = await this.archiveOrderMetadata(job.orderId);
          break;
        case "PAYMENT_QR":
          driveFileId = await this.archivePaymentInstructionQr(job.orderId);
          break;
        case "CUSTOMER_BILL":
          driveFileId = await this.archiveCustomerBill(job.orderId);
          break;
        case "PAYOUT_BILL":
          driveFileId = await this.archivePayoutBill(job.orderId);
          break;
        case "CONVERSATION":
          const convRes = await this.archiveConversation(job.orderId);
          driveFileId = convRes.txtId || convRes.jsonId;
          break;
        case "AUDIT":
          driveFileId = await this.archiveAudit(job.orderId);
          break;
        case "FULL_ORDER_ARCHIVE":
          await this.archiveOrderMetadata(job.orderId);
          await this.archivePaymentInstructionQr(job.orderId);
          await this.archiveCustomerBill(job.orderId);
          await this.archivePayoutBill(job.orderId);
          await this.archiveConversation(job.orderId);
          driveFileId = await this.archiveAudit(job.orderId);
          break;
        default:
          logger.warn({ jobType: job.jobType }, "Unknown drive sync job type");
      }

      await prisma.driveSyncJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCESS",
          driveFileId,
          lastError: null
        }
      });

      return true;
    } catch (err: any) {
      const sanitized = sanitizeDriveError(err);
      const attempts = (job.attempts || 0) + 1;
      const backoffMs = Math.min(30 * 60 * 1000, Math.pow(2, attempts) * 60 * 1000);
      const nextRetryAt = new Date(Date.now() + backoffMs);
      const isExhausted = attempts >= (job.maxAttempts || 5);

      await prisma.driveSyncJob.update({
        where: { id: job.id },
        data: {
          status: isExhausted ? "EXHAUSTED" : "FAILED",
          attempts,
          lastError: sanitized,
          nextRetryAt
        }
      });

      logger.warn({ jobId: job.id, attempts, nextRetryAt, error: sanitized }, "Drive sync job failed, scheduled retry");

      // Notify admin on critical OAuth error or retry exhaustion (without leaking credentials)
      if (isExhausted || sanitized.includes("OAuth error") || sanitized.includes("not configured")) {
        sendToAdminNotificationChat(
          `⚠️ <b>CẢNH BÁO ĐỒNG BỘ GOOGLE DRIVE:</b>\n` +
            `• Mã lệnh: <code>${job.orderId || "N/A"}</code>\n` +
            `• Tác vụ: <code>${job.jobType}</code>\n` +
            `• Trạng thái: <b>${isExhausted ? "EXHAUSTED (Hết số lần thử)" : "FAILED (Sẽ thử lại)"}</b>\n` +
            `• Lỗi: <code>${sanitized}</code>\n` +
            `• Lần thử: <b>${attempts}/${job.maxAttempts || 5}</b>`
        ).catch(() => {});
      }

      return false;
    }
  }

  static async runPendingJobs(limit: number = 10): Promise<number> {
    const now = new Date();
    const pending = await prisma.driveSyncJob.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        nextRetryAt: { lte: now }
      },
      take: limit,
      orderBy: { createdAt: "asc" }
    });

    let successCount = 0;
    for (const job of pending) {
      const ok = await this.processJob(job);
      if (ok) successCount++;
    }
    return successCount;
  }

  static async getOrderArchiveStatus(orderId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;

    const jobs = await prisma.driveSyncJob.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" }
    });

    const getStatusForType = (type: string) => {
      const job = jobs.find((j: any) => j.jobType === type);
      if (!job) return "PENDING";
      return job.status;
    };

    return {
      orderId,
      driveFolderId: order.driveFolderId || null,
      metadataStatus: getStatusForType("ORDER_METADATA"),
      qrStatus: getStatusForType("PAYMENT_QR"),
      customerBillStatus: order.customerBillFileId ? getStatusForType("CUSTOMER_BILL") : "N/A",
      payoutBillStatus: order.payoutBillFileId ? getStatusForType("PAYOUT_BILL") : "N/A",
      conversationStatus: getStatusForType("CONVERSATION"),
      auditStatus: getStatusForType("AUDIT")
    };
  }

  static async retryOrderSync(orderId: string): Promise<number> {
    const jobs = await prisma.driveSyncJob.findMany({
      where: { orderId }
    });

    if (jobs.length === 0) {
      await this.enqueueSyncJob(orderId, "FULL_ORDER_ARCHIVE");
    } else {
      for (const j of jobs) {
        await prisma.driveSyncJob.update({
          where: { id: j.id },
          data: {
            status: "PENDING",
            attempts: 0,
            nextRetryAt: new Date(),
            lastError: null
          }
        });
      }
    }

    return this.runPendingJobs(10);
  }
}
