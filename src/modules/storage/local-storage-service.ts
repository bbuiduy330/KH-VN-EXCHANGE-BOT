import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";
import { ConversationService } from "../conversation/conversation-service.js";

export interface OrderFolderPaths {
  relativeOrderFolder: string;
  absoluteOrderFolder: string;
  subFolders: {
    payment_instruction: { relative: string; absolute: string };
    customer_bill: { relative: string; absolute: string };
    payout_bill: { relative: string; absolute: string };
    voice: { relative: string; absolute: string };
    images: { relative: string; absolute: string };
    documents: { relative: string; absolute: string };
  };
}

export interface SaveOriginalFileParams {
  buffer: Buffer;
  originalFileName: string;
  fileType: "QR" | "CUSTOMER_BILL" | "PAYOUT_BILL" | "VOICE" | "DOCUMENT" | "IMAGE" | "EXPORT";
  mimeType?: string;
  orderId?: string;
  uploadedBy?: string;
}

export interface OrderArchiveStatus {
  orderId: string;
  storageFolder: string | null;
  existsOnDisk: boolean;
  metadataStatus: "SUCCESS" | "MISSING";
  customerStatus: "SUCCESS" | "MISSING";
  qrStatus: "SUCCESS" | "MISSING" | "N/A";
  customerBillStatus: "SUCCESS" | "MISSING" | "N/A";
  payoutBillStatus: "SUCCESS" | "MISSING" | "N/A";
  conversationStatus: "SUCCESS" | "MISSING";
  auditStatus: "SUCCESS" | "MISSING";
  filesCount: number;
}

export class LocalStorageService {
  private static rootInitialized = false;

  /**
   * Returns the canonical absolute path of the storage root directory.
   */
  static getStorageRoot(): string {
    const configured = env.STORAGE_ROOT || env.DATA_DIR || "./data/KH-VN-EXCHANGE";
    return path.resolve(configured);
  }

  /**
   * Validates and ensures that a given relative or absolute path is strictly
   * contained within the storage root, rejecting path traversal attempts.
   */
  static ensureSafePath(targetPath: string): string {
    if (!targetPath || typeof targetPath !== "string") {
      throw new Error("Invalid path argument provided to LocalStorageService");
    }

    // Explicitly reject dangerous traversal patterns
    if (
      targetPath.includes("..") ||
      targetPath.includes("\0") ||
      targetPath.includes("\\..") ||
      targetPath.includes("../")
    ) {
      throw new Error(`Path traversal attempt detected: "${targetPath}"`);
    }

    const root = this.getStorageRoot();
    const resolved = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(root, targetPath);

    // Enforce root containment
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Path traversal escape detected: resolved "${resolved}" is outside root "${root}"`);
    }

    return resolved;
  }

  /**
   * Sanitizes path segments (e.g. orderId, year, month)
   */
  static sanitizeSegment(segment: string): string {
    if (!segment || typeof segment !== "string") return "unknown";
    const stripped = path.basename(segment).replace(/\.\./g, "").trim();
    const cleaned = stripped.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
    if (!cleaned) {
      return "item";
    }
    return cleaned;
  }

  /**
   * Sanitizes filenames, stripping path separators and unsafe characters while preserving safe extensions.
   */
  static sanitizeFileName(fileName: string): string {
    if (!fileName || typeof fileName !== "string") return "file.dat";
    const basename = path.basename(fileName);
    const ext = path.extname(basename).toLowerCase().slice(0, 10);
    const nameWithoutExt = basename.slice(0, basename.length - ext.length);
    const cleanedName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "evidence";
    const safeExt = ext.replace(/[^a-z0-9.]/g, "") || ".dat";
    return `${cleanedName}${safeExt}`;
  }

  /**
   * Calculates SHA-256 hash of a buffer.
   */
  static calculateSha256(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /**
   * Returns absolute path for a relative path inside storage root.
   */
  static getAbsolutePath(relativePath: string): string {
    return this.ensureSafePath(relativePath);
  }

  /**
   * Returns relative path from storage root for a given absolute or relative path.
   */
  static getRelativePath(absolutePath: string): string {
    const safeAbsolute = this.ensureSafePath(absolutePath);
    return path.relative(this.getStorageRoot(), safeAbsolute);
  }

  /**
   * Initializes the storage root directory and default system folders.
   */
  static async ensureRoot(): Promise<string> {
    const root = this.getStorageRoot();
    if (!this.rootInitialized) {
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(root, "qr"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(root, "_backup"), { recursive: true, mode: 0o700 });
      await fs.mkdir(path.join(root, "_backup", "db"), { recursive: true, mode: 0o700 });
      this.rootInitialized = true;
    }
    return root;
  }

  /**
   * Creates the standard order folder hierarchy:
   * YYYY/MM/ORDER-ID/
   * ├── payment_instruction/
   * ├── customer_bill/
   * ├── payout_bill/
   * ├── voice/
   * ├── images/
   * └── documents/
   */
  static async createOrderFolders(order: { id: string; createdAt?: Date | string }): Promise<OrderFolderPaths> {
    await this.ensureRoot();

    const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
    const year = this.sanitizeSegment(createdAt.getFullYear().toString());
    const month = this.sanitizeSegment(String(createdAt.getMonth() + 1).padStart(2, "0"));
    const orderId = this.sanitizeSegment(order.id);

    const relativeOrderFolder = path.join(year, month, orderId);
    const absoluteOrderFolder = this.ensureSafePath(relativeOrderFolder);

    const subFolderNames = [
      "payment_instruction",
      "customer_bill",
      "payout_bill",
      "voice",
      "images",
      "documents"
    ] as const;

    const subFolders: any = {};

    await fs.mkdir(absoluteOrderFolder, { recursive: true, mode: 0o700 });

    for (const name of subFolderNames) {
      const rel = path.join(relativeOrderFolder, name);
      const abs = this.ensureSafePath(rel);
      await fs.mkdir(abs, { recursive: true, mode: 0o700 });
      subFolders[name] = { relative: rel, absolute: abs };
    }

    return {
      relativeOrderFolder,
      absoluteOrderFolder,
      subFolders
    };
  }

  /**
   * Saves raw buffer into a safe relative path inside STORAGE_ROOT.
   */
  static async saveBuffer(
    buffer: Buffer,
    relativePath: string
  ): Promise<{ absolutePath: string; relativePath: string; sha256: string; size: number }> {
    await this.ensureRoot();
    const absolutePath = this.ensureSafePath(relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });

    await fs.writeFile(absolutePath, buffer, { mode: 0o600 });
    const sha256 = this.calculateSha256(buffer);

    return {
      absolutePath,
      relativePath: this.getRelativePath(absolutePath),
      sha256,
      size: buffer.length
    };
  }

  /**
   * Saves formatted JSON to relativePath.
   */
  static async saveJson(data: any, relativePath: string): Promise<{ absolutePath: string; relativePath: string }> {
    const jsonStr = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonStr, "utf-8");
    const result = await this.saveBuffer(buffer, relativePath);
    return { absolutePath: result.absolutePath, relativePath: result.relativePath };
  }

  /**
   * Saves UTF-8 text to relativePath.
   */
  static async saveText(text: string, relativePath: string): Promise<{ absolutePath: string; relativePath: string }> {
    const buffer = Buffer.from(text, "utf-8");
    const result = await this.saveBuffer(buffer, relativePath);
    return { absolutePath: result.absolutePath, relativePath: result.relativePath };
  }

  /**
   * Safely reads a file from disk.
   */
  static async readFile(relativePathOrAbsolute: string): Promise<Buffer | null> {
    try {
      const safePath = this.ensureSafePath(relativePathOrAbsolute);
      return await fs.readFile(safePath);
    } catch {
      return null;
    }
  }

  /**
   * Checks if file exists on disk.
   */
  static async fileExists(relativePathOrAbsolute: string): Promise<boolean> {
    try {
      const safePath = this.ensureSafePath(relativePathOrAbsolute);
      await fs.access(safePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Saves an original evidence file into storage and records it in FileEvidence table.
   * Original evidence files are never overwritten.
   */
  static async saveOriginalFile(params: SaveOriginalFileParams) {
    await this.ensureRoot();
    const { buffer, originalFileName, fileType, mimeType = "application/octet-stream", orderId } = params;
    const sha256 = this.calculateSha256(buffer);
    const safeName = this.sanitizeFileName(originalFileName);
    const ext = path.extname(safeName) || ".dat";

    // Format unique, non-colliding filename preserving sha256 and timestamp
    const uniqueFileName = `${Date.now()}_${sha256.slice(0, 10)}${ext}`;

    let relativePath: string;

    if (orderId) {
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      const tree = await this.createOrderFolders(order || { id: orderId });

      let targetSubFolder = tree.subFolders.documents.relative;
      if (fileType === "CUSTOMER_BILL") targetSubFolder = tree.subFolders.customer_bill.relative;
      else if (fileType === "PAYOUT_BILL") targetSubFolder = tree.subFolders.payout_bill.relative;
      else if (fileType === "QR") targetSubFolder = tree.subFolders.payment_instruction.relative;
      else if (fileType === "VOICE") targetSubFolder = tree.subFolders.voice.relative;
      else if (fileType === "IMAGE") targetSubFolder = tree.subFolders.images.relative;

      relativePath = path.join(targetSubFolder, uniqueFileName);
    } else {
      // Standalone evidence (e.g. initial QR codes uploaded by Admin before an order exists)
      const subFolder = fileType === "QR" ? "qr" : "evidence";
      relativePath = path.join(subFolder, uniqueFileName);
    }

    const saved = await this.saveBuffer(buffer, relativePath);

    const evidence = await prisma.fileEvidence.create({
      data: {
        fileName: originalFileName,
        filePath: saved.absolutePath,
        storageRelativePath: saved.relativePath,
        fileType,
        fileSize: buffer.length,
        mimeType,
        sha256
      }
    });

    logger.info(
      { evidenceId: evidence.id, relativePath: saved.relativePath, sha256, fileType, orderId },
      "Evidence file saved to local storage successfully"
    );

    return evidence;
  }

  /**
   * Performs a lightweight writable/accessibility health check on STORAGE_ROOT.
   */
  static async checkStorageHealth(): Promise<{ configured: boolean; writable: boolean }> {
    try {
      const root = await this.ensureRoot();
      const testFile = path.join(root, `_healthcheck_${Date.now()}.tmp`);
      await fs.writeFile(testFile, "ok", { mode: 0o600 });
      await fs.unlink(testFile);
      return { configured: true, writable: true };
    } catch (err) {
      logger.warn({ err }, "Local storage health check failed");
      return { configured: true, writable: false };
    }
  }

  // ==========================================
  // ORDER ARCHIVAL & METADATA EXPORTS
  // ==========================================

  /**
   * Archives order metadata: order.json and customer.json
   */
  static async archiveOrderMetadata(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });
    if (!order) throw new Error(`Order ${orderId} not found`);

    const tree = await this.createOrderFolders(order);

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
    await this.saveJson(orderJsonData, path.join(tree.relativeOrderFolder, "order.json"));

    // 2. customer.json
    const customer = order.customer || (await prisma.customer.findUnique({ where: { id: order.customerId } }));
    if (customer) {
      await this.saveJson(
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
        path.join(tree.relativeOrderFolder, "customer.json")
      );
    }

    // Save storage folder in order record
    await prisma.order.update({
      where: { id: orderId },
      data: { storageFolder: tree.relativeOrderFolder }
    });
  }

  /**
   * Archives payment QR instruction file into order's payment_instruction/ folder
   */
  static async archivePaymentInstructionQr(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const snapshot = order.receivingAccountSnapshot as any;
    if (!snapshot || !snapshot.qrFilePath) return;

    const fileBuffer = await this.readFile(snapshot.qrFilePath);
    if (!fileBuffer) return;

    const tree = await this.createOrderFolders(order);
    const version = snapshot.qrVersion || 1;
    const fileName = `payment_qr_v${version}_${snapshot.currency || "GENERIC"}.jpg`;

    await this.saveBuffer(fileBuffer, path.join(tree.subFolders.payment_instruction.relative, fileName));
  }

  /**
   * Ensures customer bill is archived in order's customer_bill/ folder
   */
  static async archiveCustomerBill(orderId: string, evidenceId?: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const targetEvidenceId = evidenceId || order.customerBillFileId;
    if (!targetEvidenceId) return;

    const evidence = await prisma.fileEvidence.findUnique({ where: { id: targetEvidenceId } });
    if (!evidence) return;

    const tree = await this.createOrderFolders(order);

    // If file is not already in customer_bill/, copy it into the order structure
    const relativeOrderCustomerBill = tree.subFolders.customer_bill.relative;
    if (!evidence.storageRelativePath || !evidence.storageRelativePath.startsWith(relativeOrderCustomerBill)) {
      const buffer = await this.readFile(evidence.filePath);
      if (buffer) {
        const destPath = path.join(relativeOrderCustomerBill, path.basename(evidence.filePath));
        await this.saveBuffer(buffer, destPath);
      }
    }

    // Update order.json
    await this.archiveOrderMetadata(orderId).catch(() => {});
  }

  /**
   * Ensures payout bill is archived in order's payout_bill/ folder
   */
  static async archivePayoutBill(orderId: string, evidenceId?: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const targetEvidenceId = evidenceId || order.payoutBillFileId;
    if (!targetEvidenceId) return;

    const evidence = await prisma.fileEvidence.findUnique({ where: { id: targetEvidenceId } });
    if (!evidence) return;

    const tree = await this.createOrderFolders(order);

    // If file is not already in payout_bill/, copy it into the order structure
    const relativeOrderPayoutBill = tree.subFolders.payout_bill.relative;
    if (!evidence.storageRelativePath || !evidence.storageRelativePath.startsWith(relativeOrderPayoutBill)) {
      const buffer = await this.readFile(evidence.filePath);
      if (buffer) {
        const destPath = path.join(relativeOrderPayoutBill, path.basename(evidence.filePath));
        await this.saveBuffer(buffer, destPath);
      }
    }

    // Update order.json
    await this.archiveOrderMetadata(orderId).catch(() => {});
  }

  /**
   * Formats conversation into conversation.json and conversation.txt
   * conversation.txt includes: CUSTOMER, AI, BOT, CSKH, ADMIN, SYSTEM, and clearly marked INTERNAL NOTE.
   */
  static async archiveConversation(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });
    if (!order) return;

    const telegramId = order.customer?.telegramId || order.customerId;
    const history = await ConversationService.getHistory(telegramId, 200);
    const tree = await this.createOrderFolders(order);

    const txtBlocks: string[] = [];

    const allEvents: Array<{
      type: "MESSAGE" | "NOTE";
      date: Date;
      senderTag: string;
      content: string;
    }> = [];

    for (const m of history.messages) {
      let senderTag = "SYSTEM";
      if (m.senderType === "CUSTOMER") senderTag = "CUSTOMER";
      else if (m.senderType === "AI") senderTag = "AI";
      else if (m.senderType === "BOT") senderTag = "BOT";
      else if (m.senderType === "ADMIN") senderTag = `ADMIN ${m.senderId || ""}`.trim();
      else if (m.senderType === "CSKH") senderTag = `CSKH ${m.senderId || ""}`.trim();

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

    await this.saveText(fullText, path.join(tree.relativeOrderFolder, "conversation.txt"));

    await this.saveJson(
      {
        orderId,
        customerId: order.customerId,
        messages: history.messages,
        internalNotes: history.notes,
        mode: history.mode,
        claimedById: history.claimedById,
        exportedAt: new Date().toISOString()
      },
      path.join(tree.relativeOrderFolder, "conversation.json")
    );
  }

  /**
   * Archives audit logs related to this order: audit.json
   */
  static async archiveAudit(orderId: string): Promise<void> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return;

    const logs = await prisma.auditLog.findMany({
      where: { targetId: orderId },
      orderBy: { createdAt: "asc" }
    });

    const tree = await this.createOrderFolders(order);

    await this.saveJson(
      {
        orderId,
        count: logs.length,
        logs: logs.map((l: any) => ({
          id: l.id,
          actorId: l.actorId,
          actorRole: l.actorRole,
          action: l.action,
          targetType: l.targetType,
          targetId: l.targetId,
          details: l.details,
          createdAt: l.createdAt
        })),
        exportedAt: new Date().toISOString()
      },
      path.join(tree.relativeOrderFolder, "audit.json")
    );
  }

  /**
   * Full order archival: runs all archive steps for an order.
   */
  static async archiveFullOrder(orderId: string): Promise<void> {
    await this.archiveOrderMetadata(orderId);
    await this.archivePaymentInstructionQr(orderId);
    await this.archiveCustomerBill(orderId);
    await this.archivePayoutBill(orderId);
    await this.archiveConversation(orderId);
    await this.archiveAudit(orderId);

    await prisma.order.update({
      where: { id: orderId },
      data: { archiveStatus: "ARCHIVED" }
    });
  }

  /**
   * Returns storage status report for an order by inspecting local filesystem.
   */
  static async getOrderArchiveStatus(orderId: string): Promise<OrderArchiveStatus | null> {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;

    const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
    const year = this.sanitizeSegment(createdAt.getFullYear().toString());
    const month = this.sanitizeSegment(String(createdAt.getMonth() + 1).padStart(2, "0"));
    const safeOrderId = this.sanitizeSegment(order.id);
    const relFolder = path.join(year, month, safeOrderId);
    const absFolder = this.getAbsolutePath(relFolder);

    const existsOnDisk = await this.fileExists(relFolder);
    if (!existsOnDisk) {
      return {
        orderId,
        storageFolder: null,
        existsOnDisk: false,
        metadataStatus: "MISSING",
        customerStatus: "MISSING",
        qrStatus: order.receivingAccountId ? "MISSING" : "N/A",
        customerBillStatus: order.customerBillFileId ? "MISSING" : "N/A",
        payoutBillStatus: order.payoutBillFileId ? "MISSING" : "N/A",
        conversationStatus: "MISSING",
        auditStatus: "MISSING",
        filesCount: 0
      };
    }

    const hasOrderJson = await this.fileExists(path.join(relFolder, "order.json"));
    const hasCustomerJson = await this.fileExists(path.join(relFolder, "customer.json"));
    const hasConvTxt = await this.fileExists(path.join(relFolder, "conversation.txt"));
    const hasAuditJson = await this.fileExists(path.join(relFolder, "audit.json"));

    // Check QR in payment_instruction
    let qrStatus: "SUCCESS" | "MISSING" | "N/A" = "N/A";
    if (order.receivingAccountId) {
      const qrDir = path.join(absFolder, "payment_instruction");
      try {
        const files = await fs.readdir(qrDir);
        qrStatus = files.length > 0 ? "SUCCESS" : "MISSING";
      } catch {
        qrStatus = "MISSING";
      }
    }

    // Check customer bill
    let customerBillStatus: "SUCCESS" | "MISSING" | "N/A" = "N/A";
    if (order.customerBillFileId) {
      const billDir = path.join(absFolder, "customer_bill");
      try {
        const files = await fs.readdir(billDir);
        customerBillStatus = files.length > 0 ? "SUCCESS" : "MISSING";
      } catch {
        customerBillStatus = "MISSING";
      }
    }

    // Check payout bill
    let payoutBillStatus: "SUCCESS" | "MISSING" | "N/A" = "N/A";
    if (order.payoutBillFileId) {
      const payoutDir = path.join(absFolder, "payout_bill");
      try {
        const files = await fs.readdir(payoutDir);
        payoutBillStatus = files.length > 0 ? "SUCCESS" : "MISSING";
      } catch {
        payoutBillStatus = "MISSING";
      }
    }

    // Count all files inside order directory
    let filesCount = 0;
    async function countFilesRecursively(dir: string): Promise<number> {
      let count = 0;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            count += await countFilesRecursively(full);
          } else if (entry.isFile()) {
            count++;
          }
        }
      } catch {}
      return count;
    }
    filesCount = await countFilesRecursively(absFolder);

    return {
      orderId,
      storageFolder: relFolder,
      existsOnDisk: true,
      metadataStatus: hasOrderJson ? "SUCCESS" : "MISSING",
      customerStatus: hasCustomerJson ? "SUCCESS" : "MISSING",
      qrStatus,
      customerBillStatus,
      payoutBillStatus,
      conversationStatus: hasConvTxt ? "SUCCESS" : "MISSING",
      auditStatus: hasAuditJson ? "SUCCESS" : "MISSING",
      filesCount
    };
  }
}
