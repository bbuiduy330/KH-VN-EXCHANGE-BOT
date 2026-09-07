import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../database/client.js";
import { logger } from "../../shared/logger.js";

export class FileService {
  private static dataDirInitialized = false;

  static async ensureDataDir() {
    if (!this.dataDirInitialized) {
      await fs.mkdir(env.DATA_DIR, { recursive: true });
      await fs.mkdir(path.join(env.DATA_DIR, "qr"), { recursive: true });
      await fs.mkdir(path.join(env.DATA_DIR, "bills"), { recursive: true });
      await fs.mkdir(path.join(env.DATA_DIR, "payouts"), { recursive: true });
      await fs.mkdir(path.join(env.DATA_DIR, "voice"), { recursive: true });
      this.dataDirInitialized = true;
    }
  }

  static calculateSha256(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  static async saveEvidenceFile(
    fileBuffer: Buffer,
    originalFileName: string,
    fileType: "QR" | "CUSTOMER_BILL" | "PAYOUT_BILL" | "VOICE" | "EXPORT",
    mimeType: string = "application/octet-stream"
  ) {
    await this.ensureDataDir();
    const sha256 = this.calculateSha256(fileBuffer);
    const ext = path.extname(originalFileName) || ".dat";
    const subFolder =
      fileType === "QR"
        ? "qr"
        : fileType === "CUSTOMER_BILL"
        ? "bills"
        : fileType === "PAYOUT_BILL"
        ? "payouts"
        : fileType === "VOICE"
        ? "voice"
        : "";

    const storedFileName = `${Date.now()}_${sha256.slice(0, 10)}${ext}`;
    const targetPath = path.join(env.DATA_DIR, subFolder, storedFileName);

    await fs.writeFile(targetPath, fileBuffer);

    const evidence = await prisma.fileEvidence.create({
      data: {
        fileName: originalFileName,
        filePath: targetPath,
        fileType,
        fileSize: fileBuffer.length,
        mimeType,
        sha256,
        driveSyncStatus: "PENDING"
      }
    });

    logger.info({ evidenceId: evidence.id, sha256, fileType }, "Evidence file saved successfully");
    return evidence;
  }

  static async getFile(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }
}
