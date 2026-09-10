import { prisma } from "../../database/client.js";
import {
  DEFAULT_LOCALE,
  SupportedLocale,
  normalizeLocale,
  resolveLocale
} from "../i18n/locales.js";

export class CustomerService {
  /**
   * Persist an explicit customer language choice (vi|en|km|zh).
   * Uses the existing Customer.language column — no schema change.
   * Only called from the explicit language-selector callback, never
   * automatically from detected message language.
   */
  static async setLanguage(customerId: string, locale: string): Promise<SupportedLocale> {
    const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
    await prisma.customer.update({
      where: { id: customerId },
      data: { language: normalized }
    });
    return normalized;
  }

  /** Resolve the customer's stored language into a SupportedLocale. */
  static getLocale(customer: { language?: string | null } | null | undefined): SupportedLocale {
    return resolveLocale(customer?.language);
  }

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
      // Telegram language_code is only an INITIAL default suggestion.
      const initial = normalizeLocale(data.language) ?? DEFAULT_LOCALE;
      customer = await prisma.customer.create({
        data: {
          telegramId: data.telegramId,
          username: data.username,
          fullName: data.fullName,
          language: initial
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
