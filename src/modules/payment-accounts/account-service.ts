import { prisma } from "../../database/client.js";
import { FileService } from "../files/file-service.js";
import { AuditService } from "../audit/audit-service.js";

export class PaymentAccountService {
  /**
   * Add a new receiving payment account or update details and QR version
   */
  static async addAccount(
    data: {
      currency: string;
      bankName: string;
      accountName: string;
      accountNumber: string;
      tag?: string;
      isDefault?: boolean;
      priority?: number;
      createdBy?: string;
      qrFileBuffer?: Buffer;
      qrFileName?: string;
      qrMimeType?: string;
    },
    actorId?: string
  ) {
    const currency = data.currency.toUpperCase().trim();
    const creator = actorId || data.createdBy || "SYSTEM";
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

    // Check if account with same currency & account number already exists
    const existing = await prisma.paymentAccount.findFirst({
      where: {
        currency,
        accountNumber: data.accountNumber.trim()
      }
    });

    if (existing) {
      const nextVersion = qrFileId ? existing.qrVersion + 1 : existing.qrVersion;
      const updated = await prisma.$transaction(async (tx: any) => {
        if (data.isDefault) {
          await tx.paymentAccount.updateMany({
            where: { currency, isDefault: true },
            data: { isDefault: false }
          });
        }

        const acc = await tx.paymentAccount.update({
          where: { id: existing.id },
          data: {
            bankName: data.bankName,
            accountName: data.accountName,
            tag: data.tag || existing.tag,
            isDefault: data.isDefault !== undefined ? data.isDefault : existing.isDefault,
            priority: data.priority !== undefined ? data.priority : existing.priority,
            qrFileId: qrFileId || existing.qrFileId,
            qrFilePath: qrFilePath || existing.qrFilePath,
            qrSha256: qrSha256 || existing.qrSha256,
            qrVersion: nextVersion,
            isActive: true
          }
        });

        if (qrFileId && qrFilePath && qrSha256) {
          await tx.paymentAccountVersion.create({
            data: {
              paymentAccountId: acc.id,
              version: nextVersion,
              qrFileId,
              qrFilePath,
              qrSha256,
              createdBy: data.createdBy || "system"
            }
          });
        }

        return acc;
      });

      return updated;
    }

    // New account creation
    return prisma.$transaction(async (tx: any) => {
      // If marked default, clear existing default for this currency
      if (data.isDefault) {
        await tx.paymentAccount.updateMany({
          where: { currency, isDefault: true },
          data: { isDefault: false }
        });
      } else {
        // If this is the first account for currency, default to true
        const count = await tx.paymentAccount.count
          ? await tx.paymentAccount.count({ where: { currency, isActive: true } })
          : (await tx.paymentAccount.findMany({ where: { currency, isActive: true } })).length;
        if (count === 0) {
          data.isDefault = true;
        }
      }

      const acc = await tx.paymentAccount.create({
        data: {
          currency,
          bankName: data.bankName,
          accountName: data.accountName,
          accountNumber: data.accountNumber.trim(),
          tag: data.tag || "default",
          isDefault: data.isDefault ?? false,
          priority: data.priority ?? 0,
          qrFileId,
          qrFilePath,
          qrSha256,
          qrVersion: 1,
          isActive: true
        }
      });

      if (qrFileId && qrFilePath && qrSha256) {
        await tx.paymentAccountVersion.create({
          data: {
            paymentAccountId: acc.id,
            version: 1,
            qrFileId,
            qrFilePath,
            qrSha256,
            createdBy: data.createdBy || "system"
          }
        });
      }

      return acc;
    });
  }

  /**
   * Deterministic Selection Rule:
   * 1. Active account for required currency
   * 2. Default account first (isDefault = true)
   * 3. Higher priority second (priority desc)
   * 4. Deterministic fallback ordering (createdAt asc)
   */
  static async getActiveAccountForCurrency(currency: string) {
    const cur = currency.toUpperCase().trim();
    return prisma.paymentAccount.findFirst({
      where: {
        currency: cur,
        isActive: true
      },
      orderBy: [
        { isDefault: "desc" },
        { priority: "desc" },
        { createdAt: "asc" }
      ]
    });
  }

  /**
   * Set an account as default for its currency atomically
   */
  static async setDefaultAccount(accountId: string, actorId: string = "system") {
    return prisma.$transaction(async (tx: any) => {
      const target = await tx.paymentAccount.findUnique({ where: { id: accountId } });
      if (!target) throw new Error("Payment account not found");

      await tx.paymentAccount.updateMany({
        where: { currency: target.currency, isDefault: true },
        data: { isDefault: false }
      });

      const updated = await tx.paymentAccount.update({
        where: { id: accountId },
        data: { isDefault: true, isActive: true }
      });

      await AuditService.record({
        actorId,
        actorRole: "ADMIN",
        action: "payment_account.set_default",
        targetType: "PaymentAccount",
        targetId: accountId,
        details: { currency: target.currency, bankName: target.bankName, accountNumber: target.accountNumber }
      });

      return updated;
    });
  }

  /**
   * Update priority for account ordering
   */
  static async setPriority(accountId: string, priority: number, actorId: string = "system") {
    const updated = await prisma.paymentAccount.update({
      where: { id: accountId },
      data: { priority }
    });

    await AuditService.record({
      actorId,
      actorRole: "ADMIN",
      action: "payment_account.set_priority",
      targetType: "PaymentAccount",
      targetId: accountId,
      details: { priority }
    });

    return updated;
  }

  /**
   * Toggle active state
   */
  static async toggleActive(accountId: string, isActive?: boolean, actorId: string = "system") {
    const existing = await prisma.paymentAccount.findUnique({ where: { id: accountId } });
    if (!existing) throw new Error("Payment account not found");

    const newActive = isActive !== undefined ? isActive : !existing.isActive;

    const updated = await prisma.paymentAccount.update({
      where: { id: accountId },
      data: {
        isActive: newActive,
        // If deactivating a default account, unset isDefault
        ...(newActive === false ? { isDefault: false } : {})
      }
    });

    await AuditService.record({
      actorId,
      actorRole: "ADMIN",
      action: newActive ? "payment_account.activate" : "payment_account.deactivate",
      targetType: "PaymentAccount",
      targetId: accountId,
      details: { currency: existing.currency, accountNumber: existing.accountNumber }
    });

    return updated;
  }

  /**
   * Update or replace QR code for an account, saving version history without overwriting old evidence
   */
  static async updateQrCode(data: {
    accountId: string;
    qrFileBuffer: Buffer;
    qrFileName: string;
    qrMimeType?: string;
    actorId?: string;
  }) {
    const existing = await prisma.paymentAccount.findUnique({ where: { id: data.accountId } });
    if (!existing) throw new Error("Payment account not found");

    const evidence = await FileService.saveEvidenceFile(
      data.qrFileBuffer,
      data.qrFileName,
      "QR",
      data.qrMimeType || "image/png"
    );

    const nextVersion = existing.qrVersion + 1;

    return prisma.$transaction(async (tx: any) => {
      const updated = await tx.paymentAccount.update({
        where: { id: data.accountId },
        data: {
          qrFileId: evidence.id,
          qrFilePath: evidence.filePath,
          qrSha256: evidence.sha256,
          qrVersion: nextVersion,
          isActive: true
        }
      });

      await tx.paymentAccountVersion.create({
        data: {
          paymentAccountId: data.accountId,
          version: nextVersion,
          qrFileId: evidence.id,
          qrFilePath: evidence.filePath,
          qrSha256: evidence.sha256,
          createdBy: data.actorId || "system"
        }
      });

      await AuditService.record({
        actorId: data.actorId || "system",
        actorRole: "ADMIN",
        action: "payment_account.update_qr",
        targetType: "PaymentAccount",
        targetId: data.accountId,
        details: { version: nextVersion, sha256: evidence.sha256 }
      });

      return updated;
    });
  }

  /**
   * Retrieve historical QR version for an account
   */
  static async getVersionQr(accountId: string, version: number) {
    return prisma.paymentAccountVersion.findUnique({
      where: {
        paymentAccountId_version: {
          paymentAccountId: accountId,
          version
        }
      } as any
    });
  }

  /**
   * Retrieve all versions of a payment account
   */
  static async getAccountVersions(paymentAccountId: string) {
    return prisma.paymentAccountVersion.findMany({
      where: { paymentAccountId },
      orderBy: { version: "desc" }
    });
  }

  /**
   * List payment accounts, optionally filtered by currency
   */
  static async listAccounts(currency?: string) {
    return prisma.paymentAccount.findMany({
      where: currency ? { currency: currency.toUpperCase().trim() } : {},
      orderBy: [
        { currency: "asc" },
        { isDefault: "desc" },
        { priority: "desc" },
        { createdAt: "asc" }
      ]
    });
  }

  static async getAccountById(id: string) {
    return prisma.paymentAccount.findUnique({
      where: { id }
    });
  }

  static async getAllAccounts() {
    return this.listAccounts();
  }
}
