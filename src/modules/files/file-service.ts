import { LocalStorageService } from "../storage/local-storage-service.js";

export class FileService {
  static async ensureDataDir() {
    await LocalStorageService.ensureRoot();
  }

  static calculateSha256(buffer: Buffer): string {
    return LocalStorageService.calculateSha256(buffer);
  }

  static async saveEvidenceFile(
    fileBuffer: Buffer,
    originalFileName: string,
    fileType: "QR" | "CUSTOMER_BILL" | "PAYOUT_BILL" | "VOICE" | "EXPORT" | "DOCUMENT" | "IMAGE",
    mimeType: string = "application/octet-stream",
    orderId?: string
  ) {
    return LocalStorageService.saveOriginalFile({
      buffer: fileBuffer,
      originalFileName,
      fileType: fileType as any,
      mimeType,
      orderId
    });
  }

  static async getFile(filePath: string): Promise<Buffer | null> {
    return LocalStorageService.readFile(filePath);
  }
}
