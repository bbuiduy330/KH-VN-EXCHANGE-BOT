import { prisma } from "../../database/client.js";
import { FileService } from "../files/file-service.js";

export class PaymentAccountService {
  static async addAccount(data: {
    currency: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
    tag?: string;
    qrFileBuffer?: Buffer;
    qrFileName?: string;
    qrMimeType?: string;
  }) {
    let qrFileId: string | undefined;
    let qrFilePath: string | undefined;
    let qrSha256: string | undefined;

    if (data.qrFileBuffer && data.qrFileName) {
      const evidence = await FileService.saveEvidenceFile(
        data.qrFileBuffer,
        data.qrFileName,
        "QR",
        data.qrMimeType || "image/png"
      );
      qrFileId = evidence.id;
      qrFilePath = evidence.filePath;
      qrSha256 = evidence.sha256;
    }

    // Check if updating existing account to increment version
    const existing = await prisma.paymentAccount.findFirst({
      where: {
        currency: data.currency.toUpperCase(),
        accountNumber: data.accountNumber
      }
    });

    if (existing) {
      return prisma.paymentAccount.update({
        where: { id: existing.id },
        data: {
          bankName: data.bankName,
          accountName: data.accountName,
          tag: data.tag || existing.tag,
          qrFileId: qrFileId || existing.qrFileId,
          qrFilePath: qrFilePath || existing.qrFilePath,
          qrSha256: qrSha256 || existing.qrSha256,
          qrVersion: existing.qrVersion + 1,
          isActive: true
        }
      });
    }

    return prisma.paymentAccount.create({
      data: {
        currency: data.currency.toUpperCase(),
        bankName: data.bankName,
        accountName: data.accountName,
        accountNumber: data.accountNumber,
        tag: data.tag || "default",
        qrFileId,
        qrFilePath,
        qrSha256,
        qrVersion: 1,
        isActive: true
      }
    });
  }

  static async getActiveAccountForCurrency(currency: string) {
    const cur = currency.toUpperCase().trim();
    return prisma.paymentAccount.findFirst({
      where: {
        currency: cur,
        isActive: true
      }
    });
  }

  static async getAllAccounts() {
    return prisma.paymentAccount.findMany({
      where: { isActive: true }
    });
  }
}
