import { prisma } from "../../database/client.js";

export class CustomerService {
  static async getOrCreateCustomer(data: {
    telegramId: string;
    username?: string;
    fullName?: string;
    language?: string;
  }) {
    let customer = await prisma.customer.findUnique({
      where: { telegramId: data.telegramId }
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          telegramId: data.telegramId,
          username: data.username,
          fullName: data.fullName,
          language: data.language || "vi"
        }
      });

      // Also create initial conversation record
      await prisma.conversation.create({
        data: {
          customerId: customer.id,
          mode: "AUTO"
        }
      });
    }

    return customer;
  }

  static async setPayoutBank(data: {
    customerId: string;
    currency: string;
    bankName: string;
    accountName: string;
    accountNumber: string;
  }) {
    const cur = data.currency.toUpperCase().trim();
    // Mark previous banks for this currency as non-default
    const existing = await prisma.customerPayoutBank.findFirst({
      where: {
        customerId: data.customerId,
        currency: cur
      }
    });

    if (existing) {
      return prisma.customerPayoutBank.update({
        where: { id: existing.id },
        data: {
          bankName: data.bankName,
          accountName: data.accountName,
          accountNumber: data.accountNumber,
          isDefault: true
        }
      });
    }

    return prisma.customerPayoutBank.create({
      data: {
        customerId: data.customerId,
        currency: cur,
        bankName: data.bankName,
        accountName: data.accountName,
        accountNumber: data.accountNumber,
        isDefault: true
      }
    });
  }

  static async getPayoutBank(customerId: string, currency: string) {
    return prisma.customerPayoutBank.findFirst({
      where: {
        customerId,
        currency: currency.toUpperCase().trim(),
        isDefault: true
      }
    });
  }

  static async searchCustomers(query: string) {
    return prisma.customer.findMany({
      where: {
        OR: [
          { telegramId: query },
          { username: query },
          { fullName: query }
        ]
      }
    });
  }
}
